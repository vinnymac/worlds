import type { Firestore, Query, Transaction } from '@google-cloud/firestore';
import { FieldValue } from '@google-cloud/firestore';
import {
  EntityConflictError,
  HookNotFoundError,
  RunExpiredError,
  TooEarlyError,
  WorkflowRunNotFoundError,
  WorkflowWorldError,
} from '@workflow/errors';
import type {
  CreateEventParams,
  CreateEventRequest,
  Event,
  EventResult,
  GetEventParams,
  GetHookParams,
  GetStepParams,
  GetWorkflowRunParams,
  Hook,
  ListEventsByCorrelationIdParams,
  ListEventsParams,
  ListHooksParams,
  ListWorkflowRunStepsParams,
  ListWorkflowRunsParams,
  PaginatedResponse,
  ResolveData,
  RunCreatedEventRequest,
  Step,
  StepWithoutData,
  Storage,
  Wait,
  WorkflowRun,
  WorkflowRunWithoutData,
} from '@workflow/world';
import {
  applyAttributeChanges,
  EventSchema,
  eventIdToSlot,
  FIRST_EVENT_SLOT,
  HookSchema,
  isChildEntityCreationEvent,
  isTerminalStepStatus,
  isTerminalWorkflowRunStatus,
  SPEC_VERSION_CURRENT,
  slotToEventId,
  stripEventDataRefs,
  validateAttributeChanges,
  validateUlidTimestamp,
  WaitSchema,
} from '@workflow/world';
import { monotonicFactory } from 'ulid';
import { compact, debug } from './util.js';

interface FirestoreStorageConfig {
  firestore: Firestore;
  deploymentId: string;
  /** Per-run event ceiling reported as `EventResult.maxEvents`. Defaults to
   * `WORKFLOW_MAX_EVENTS` or {@link DEFAULT_MAX_EVENTS_PER_RUN}. */
  maxEventsPerRun?: number;
}

/** Default per-run event ceiling. Mirrors `@workflow/world-local`. */
const DEFAULT_MAX_EVENTS_PER_RUN = 25_000;

/** Upper bound on whole-transaction retries when a slot race or transaction
 * contention aborts a commit. */
const MAX_CREATE_ATTEMPTS = 30;

/** A lost slot race surfaces as ALREADY_EXISTS (6) from the event doc create,
 * or as ABORTED (10) when the transaction's read set changed underneath it.
 * Both mean: re-derive the slot from the store and try again. */
function isSlotContentionError(err: unknown): boolean {
  const code = (err as { code?: number }).code;
  return code === 6 || code === 10;
}

/** Resolve the per-run event ceiling: explicit config, then
 * `WORKFLOW_MAX_EVENTS`, then the default. An explicit value must be a
 * positive integer. */
function resolveMaxEventsPerRun(configured: number | undefined): number {
  if (configured !== undefined) {
    if (!Number.isInteger(configured) || configured <= 0) {
      throw new WorkflowWorldError(
        `maxEventsPerRun must be a positive integer, received ${configured}`,
        { status: 500 },
      );
    }
    return configured;
  }
  const raw = process.env.WORKFLOW_MAX_EVENTS;
  const parsed = raw !== undefined ? Number(raw) : Number.NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_EVENTS_PER_RUN;
}

function _toFirestoreTimestamp(date: Date | undefined) {
  return date ? new Date(date) : null;
}

interface FirestoreTimestamp {
  toDate(): Date;
}

function isFirestoreTimestamp(value: unknown): value is FirestoreTimestamp {
  return (
    typeof value === 'object' &&
    value !== null &&
    'toDate' in value &&
    typeof (value as { toDate: unknown }).toDate === 'function'
  );
}

function fromFirestoreTimestamp(timestamp: unknown): Date | undefined {
  if (!timestamp) return undefined;
  if (timestamp instanceof Date) {
    return timestamp;
  }
  if (isFirestoreTimestamp(timestamp)) {
    return timestamp.toDate();
  }
  if (typeof timestamp === 'string' || typeof timestamp === 'number') {
    return new Date(timestamp);
  }
  return undefined;
}

/**
 * Firestore CANNOT store nested arrays (arrays within arrays).
 * This will throw: "Cannot convert an array value in an array value"
 *
 * To work around this, we serialize values that contain nested arrays as JSON strings.
 */
function hasNestedArrays(value: unknown): boolean {
  if (!Array.isArray(value)) return false;

  for (const item of value) {
    if (Array.isArray(item)) return true;
    if (typeof item === 'object' && item !== null && hasNestedArrays(item)) {
      return true;
    }
  }

  return false;
}

/**
 * Serialize a value that might contain nested arrays.
 * If it contains nested arrays, convert to JSON string with a marker.
 */
function serializeNestedArrays(value: unknown): unknown {
  if (value === null || value === undefined) return value;

  if (hasNestedArrays(value)) {
    // Serialize to JSON with marker
    return JSON.stringify({ __nested_array__: value });
  }

  return value;
}

/**
 * Recursively convert Firestore read shapes back to spec shapes: Buffer to
 * Uint8Array, and Timestamp to Date. Replay reads dates out of eventData
 * (wait_created resumeAt, step_retrying retryAfter) and only accepts Date
 * instances or strings, never Firestore Timestamps.
 */
function isBufferLike(value: unknown): value is Buffer | Uint8Array {
  if (Buffer.isBuffer(value)) return true;
  if (value instanceof Uint8Array) return true;
  return false;
}

function convertBuffersToUint8Array(value: unknown): unknown {
  if (value === null || value === undefined) return value;

  // Check for Buffer or Uint8Array subclass (Buffer extends Uint8Array)
  // Ensure we return a plain Uint8Array, not a Buffer subclass
  if (isBufferLike(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }

  if (isFirestoreTimestamp(value)) {
    return value.toDate();
  }

  // Check for serialized Buffer objects: { type: 'Buffer', data: [...] }
  if (
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).type === 'Buffer' &&
    Array.isArray((value as Record<string, unknown>).data)
  ) {
    return new Uint8Array((value as Record<string, unknown>).data as number[]);
  }

  if (Array.isArray(value)) {
    let result: unknown[] | undefined;
    for (let i = 0; i < value.length; i++) {
      const converted = convertBuffersToUint8Array(value[i]);
      if (converted !== value[i]) {
        result ??= value.slice();
        result[i] = converted;
      }
    }
    return result ?? value;
  }

  if (typeof value === 'object') {
    const source = value as Record<string, unknown>;
    let result: Record<string, unknown> | undefined;
    for (const [key, val] of Object.entries(source)) {
      const converted = convertBuffersToUint8Array(val);
      if (converted !== val) {
        result ??= { ...source };
        result[key] = converted;
      }
    }
    return result ?? value;
  }

  return value;
}

/**
 * Deserialize a value that might have been serialized to handle nested arrays.
 * Also converts any Buffer instances to Uint8Array.
 */
function deserializeNestedArrays(value: unknown): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') {
    if (!value.startsWith('{"__nested_array__":')) return value;
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && '__nested_array__' in parsed) {
        return convertBuffersToUint8Array(parsed.__nested_array__);
      }
    } catch {
      return value;
    }
    return value;
  }

  return convertBuffersToUint8Array(value);
}

/**
 * Filter data based on ResolveData parameter.
 * When resolveData is 'none', strips specified keys to reduce data transfer.
 */
function filterData<T extends object>(
  data: T,
  resolveData: ResolveData | undefined,
  keysToStrip: (keyof T)[],
): T {
  if (resolveData === 'none') {
    const newData = { ...data };
    for (const key of keysToStrip) {
      if (key in newData) {
        delete newData[key];
      }
    }
    return newData;
  }
  return data;
}

/**
 * Filter hook data based on resolveData parameter
 */
function filterHookData(hook: Hook, resolveData: ResolveData): Hook {
  if (resolveData === 'none' && 'metadata' in hook) {
    const { metadata: _, ...rest } = hook;
    return { metadata: undefined, ...rest };
  }
  return hook;
}

/** Deserialize a run entity from a Firestore document. The `error` payload is
 * opaque serialized data and round-trips verbatim. */
function runFromDoc(data: FirebaseFirestore.DocumentData): WorkflowRun {
  return {
    ...data,
    attributes: (data.attributes ?? {}) as Record<string, string>,
    input: deserializeNestedArrays(data.input),
    output: deserializeNestedArrays(data.output),
    error: deserializeNestedArrays(data.error) ?? undefined,
    createdAt: fromFirestoreTimestamp(data.createdAt),
    updatedAt: fromFirestoreTimestamp(data.updatedAt),
    startedAt: fromFirestoreTimestamp(data.startedAt),
    completedAt: fromFirestoreTimestamp(data.completedAt),
  } as WorkflowRun;
}

/** Deserialize a step entity from a Firestore document. */
function stepFromDoc(data: FirebaseFirestore.DocumentData): Step {
  return {
    ...data,
    input: deserializeNestedArrays(data.input),
    output: deserializeNestedArrays(data.output),
    error: deserializeNestedArrays(data.error) ?? undefined,
    createdAt: fromFirestoreTimestamp(data.createdAt),
    updatedAt: fromFirestoreTimestamp(data.updatedAt),
    startedAt: fromFirestoreTimestamp(data.startedAt),
    completedAt: fromFirestoreTimestamp(data.completedAt),
    retryAfter: fromFirestoreTimestamp(data.retryAfter),
  } as Step;
}

/** Deserialize a hook entity from a Firestore document. */
function hookFromDoc(data: FirebaseFirestore.DocumentData): Hook {
  return HookSchema.parse(
    compact({
      runId: data.runId,
      hookId: data.hookId,
      token: data.token,
      ownerId: data.ownerId || '',
      projectId: data.projectId || '',
      environment: data.environment || '',
      specVersion: data.specVersion,
      createdAt: fromFirestoreTimestamp(data.createdAt) || new Date(),
      metadata: deserializeNestedArrays(data.metadata),
      isSystem: data.isSystem,
    }),
  );
}

/** Deserialize a wait entity from a Firestore document. */
function waitFromDoc(data: FirebaseFirestore.DocumentData): Wait {
  return WaitSchema.parse(
    compact({
      waitId: data.waitId,
      runId: data.runId,
      status: data.status,
      resumeAt: fromFirestoreTimestamp(data.resumeAt),
      completedAt: fromFirestoreTimestamp(data.completedAt),
      createdAt: fromFirestoreTimestamp(data.createdAt) || new Date(),
      updatedAt: fromFirestoreTimestamp(data.updatedAt) || new Date(),
      specVersion: data.specVersion,
    }),
  );
}

/** Deserialize an event from a Firestore document. */
function eventFromDoc(data: FirebaseFirestore.DocumentData): Event {
  return {
    ...data,
    eventData: convertBuffersToUint8Array(data.eventData),
    createdAt: fromFirestoreTimestamp(data.createdAt),
  } as Event;
}

export function createStorage(config: FirestoreStorageConfig): Storage {
  const { firestore } = config;
  const ulid = monotonicFactory();
  const maxEventsPerRun = resolveMaxEventsPerRun(config.maxEventsPerRun);

  /**
   * Internal helper to get a run from Firestore.
   */
  async function getRun(runId: string): Promise<WorkflowRun> {
    const docRef = firestore.collection('workflow_runs').doc(runId);
    const doc = await docRef.get();

    if (!doc.exists) {
      // Typed error: @workflow/core matches this by name via
      // WorkflowRunNotFoundError.is() (Run.exists, resilient polling).
      throw new WorkflowRunNotFoundError(runId);
    }

    return runFromDoc(doc.data() as FirebaseFirestore.DocumentData);
  }

  /**
   * Internal helper to get a step from Firestore.
   *
   * Note: @workflow/errors has no StepNotFoundError; upstream world-postgres
   * throws a generic WorkflowWorldError for missing steps, so we match that.
   */
  async function getStep(runId: string, stepId: string): Promise<Step> {
    const docRef = firestore.collection('workflow_runs').doc(runId).collection('steps').doc(stepId);
    const doc = await docRef.get();

    if (!doc.exists) {
      throw new WorkflowWorldError(`Step not found: ${stepId}`, {
        status: 404,
      });
    }

    return stepFromDoc(doc.data() as FirebaseFirestore.DocumentData);
  }

  /**
   * Internal: cleanup (delete) all hooks and waits for a run when it reaches
   * a terminal state, releasing hook tokens for reuse.
   *
   * Firestore limits batches to 500 operations and each hook costs two
   * deletes (entity + token index), so deletes are chunked.
   */
  async function cleanupHooksAndWaits(runId: string): Promise<void> {
    const runRef = firestore.collection('workflow_runs').doc(runId);
    const [hooksSnapshot, waitsSnapshot] = await Promise.all([
      runRef.collection('hooks').get(),
      runRef.collection('waits').get(),
    ]);

    const refs: FirebaseFirestore.DocumentReference[] = [];
    for (const doc of hooksSnapshot.docs) {
      refs.push(doc.ref);
      const token = doc.data().token;
      if (typeof token === 'string' && token.length > 0) {
        refs.push(firestore.collection('hooks_by_token').doc(token));
      }
    }
    for (const doc of waitsSnapshot.docs) {
      refs.push(doc.ref);
    }

    const MAX_BATCH_OPS = 500;
    for (let i = 0; i < refs.length; i += MAX_BATCH_OPS) {
      const batch = firestore.batch();
      for (const ref of refs.slice(i, i + MAX_BATCH_OPS)) {
        batch.delete(ref);
      }
      await batch.commit();
    }
  }

  async function listEvents(params: ListEventsParams): Promise<PaginatedResponse<Event>> {
    const { runId } = params;
    const limit = params?.pagination?.limit ?? 100;
    const sortOrder = params.pagination?.sortOrder || 'asc';
    const resolveData = params?.resolveData ?? 'all';

    // Slot event ids are fixed-width, so lexicographic doc-id order equals
    // positional order; order and paginate by eventId, never createdAt.
    let query: Query = firestore
      .collection('workflow_runs')
      .doc(runId)
      .collection('events')
      .orderBy('eventId', sortOrder)
      .limit(limit + 1);

    if (params?.pagination?.cursor) {
      query = query.startAfter(params.pagination.cursor);
    }

    const snapshot = await query.get();
    const all = snapshot.docs;
    const values = all.slice(0, limit);
    const hasMore = all.length > limit;

    return {
      data: values.map((doc) => stripEventDataRefs(eventFromDoc(doc.data()), resolveData)),
      cursor: values.at(-1)?.id ?? null,
      hasMore,
    };
  }

  /** Load a run's full event log for the run_started preload. */
  async function preloadAllEvents(
    runId: string,
    resolveData: ResolveData,
  ): Promise<{ events: Event[]; cursor: string | null; hasMore: false }> {
    const snapshot = await firestore
      .collection('workflow_runs')
      .doc(runId)
      .collection('events')
      .orderBy('eventId', 'asc')
      .get();
    const events = snapshot.docs.map((doc) =>
      stripEventDataRefs(eventFromDoc(doc.data()), resolveData),
    );
    return { events, cursor: events.at(-1)?.eventId ?? null, hasMore: false };
  }

  /**
   * The report half of bump-and-report: when the committed slot exceeds
   * `eventCount + 1`, return the events occupying the skipped span so the
   * writer learns its snapshot was stale without the write being rejected.
   * `cursor` stays null: the report is a lower bound, not a read position.
   */
  async function reportSkippedSlots(
    result: EventResult,
    askedFor: number,
    resolveData: ResolveData,
  ): Promise<EventResult> {
    if (!result.event) {
      return result;
    }
    const committedSlot = eventIdToSlot(result.event.eventId);
    if (committedSlot === null || askedFor < FIRST_EVENT_SLOT || committedSlot <= askedFor + 1) {
      return result;
    }
    const span = committedSlot - askedFor - 1;
    const snapshot = await firestore
      .collection('workflow_runs')
      .doc(result.event.runId)
      .collection('events')
      .orderBy('eventId', 'asc')
      .startAt(slotToEventId(askedFor + 1))
      .endAt(slotToEventId(committedSlot - 1))
      .get();
    const events = snapshot.docs.map((doc) =>
      stripEventDataRefs(eventFromDoc(doc.data()), resolveData),
    );
    return { ...result, events, cursor: null, hasMore: events.length < span };
  }

  async function createImpl(
    runId: string | null,
    data: RunCreatedEventRequest | CreateEventRequest,
    params?: CreateEventParams,
  ): Promise<EventResult> {
    // For run_created events, generate a runId if null
    const effectiveRunId = runId ?? (data.eventType === 'run_created' ? `wrun_${ulid()}` : '');
    if (!effectiveRunId) {
      throw new WorkflowWorldError('runId is required for non-run_created events', {
        status: 400,
      });
    }

    // Validate client-provided runId timestamp is within acceptable threshold
    if (data.eventType === 'run_created' && runId) {
      const validationError = validateUlidTimestamp(effectiveRunId, 'wrun_');
      if (validationError) {
        throw new WorkflowWorldError(validationError, { status: 400 });
      }
    }

    const effectiveSpecVersion = data.specVersion ?? SPEC_VERSION_CURRENT;
    const correlationId =
      'correlationId' in data && typeof data.correlationId === 'string'
        ? data.correlationId
        : undefined;
    const eventData =
      'eventData' in data && data.eventData !== undefined
        ? (data.eventData as Record<string, unknown>)
        : undefined;

    const runRef = firestore.collection('workflow_runs').doc(effectiveRunId);
    const eventsCol = runRef.collection('events');

    interface Allocation {
      eventId: string;
      eventRef: FirebaseFirestore.DocumentReference;
      record: Record<string, unknown>;
    }

    /**
     * Per-transaction slot allocator seeded from the run's committed max
     * slot. `allocate()` takes the next dense slot; the slot is settled at
     * the commit by `tx.create` on the slot-named event doc, so a concurrent
     * writer that took the slot fails the commit with ALREADY_EXISTS and
     * `runEventTransaction` re-derives against the advanced log, which is
     * the bump to the next free slot.
     */
    interface SlotAllocator {
      allocate(overrides?: Partial<Record<string, unknown>>): Allocation;
    }

    function makeAllocator(committedMaxSlot: number): SlotAllocator {
      let next = committedMaxSlot;
      return {
        allocate(overrides) {
          next += 1;
          const eventId = slotToEventId(next);
          const record: Record<string, unknown> = {
            runId: effectiveRunId,
            eventId,
            eventType: data.eventType,
            // EventSchema requires eventData to be an object, default to {}
            eventData: eventData ?? {},
            specVersion: effectiveSpecVersion,
            createdAt: new Date(),
            ...overrides,
          };
          // Strip eventData from run_started events before storage; the run
          // input belongs on run_created only.
          if (record.eventType === 'run_started') {
            delete record.eventData;
          }
          if (correlationId !== undefined && record.correlationId === undefined) {
            record.correlationId = correlationId;
          }
          return { eventId, eventRef: eventsCol.doc(eventId), record };
        },
      };
    }

    /** Committed max slot: slot ids are fixed-width, so the
     * lexicographically last event id is the max. Read outside the
     * transaction; putting the query in the transaction read set would
     * read-lock the log tail and serialize every concurrent writer. */
    async function readMaxSlot(): Promise<number> {
      const snap = await eventsCol.orderBy('eventId', 'desc').limit(1).get();
      if (snap.empty) return FIRST_EVENT_SLOT - 1;
      const lastId = snap.docs[0].id;
      const slot = eventIdToSlot(lastId);
      if (slot === null) {
        throw new WorkflowWorldError(
          `Event id is not slot-numbered: ${lastId}. Run "${effectiveRunId}" predates slot identity and cannot accept new events.`,
          { status: 500 },
        );
      }
      return slot;
    }

    /**
     * Run one event-creating transaction. Each attempt re-reads the
     * committed max slot and hands the callback a fresh allocator, so a
     * writer only ever takes slots directly above a durably committed
     * predecessor. Slot-race retries are handled here rather than by the
     * client library: its ABORTED backoff starts at a full second, which
     * under a parallel fan-out (the normal v5 case) stalls commits long
     * enough to distort step timing. Losers instead retry immediately
     * against the advanced log, with a small jitter once the race is more
     * than a couple writers deep.
     */
    async function runEventTransaction<T>(
      fn: (tx: Transaction, allocator: SlotAllocator) => Promise<T>,
    ): Promise<T> {
      for (let attempt = 0; ; attempt++) {
        const baseSlot = await readMaxSlot();
        try {
          return await firestore.runTransaction(
            async (tx) => fn(tx, makeAllocator(baseSlot)),
            { maxAttempts: 1 },
          );
        } catch (err) {
          if (!isSlotContentionError(err) || attempt >= MAX_CREATE_ATTEMPTS) {
            throw err;
          }
          if (attempt >= 3) {
            await new Promise((resolve) =>
              globalThis.setTimeout(resolve, Math.ceil(Math.random() * 25 * attempt)),
            );
          }
        }
      }
    }

    /** Applied to every event this call returns, including preloads. */
    const resolveData = params?.resolveData ?? 'all';

    const isRunTerminalEvent =
      data.eventType === 'run_completed' ||
      data.eventType === 'run_failed' ||
      data.eventType === 'run_cancelled';

    let result: EventResult;

    switch (data.eventType) {
      // ============================================================
      // run_created: create the run entity + event atomically.
      // Duplicate creation is rejected with EntityConflictError, which
      // core start() treats as "run already exists".
      // ============================================================
      case 'run_created': {
        const runData = eventData as RunCreatedEventRequest['eventData'];
        const attributes = runData.attributes ?? {};
        validateAttributeChanges(
          Object.entries(attributes).map(([key, value]) => ({ key, value })),
          { allowReservedAttributes: runData.allowReservedAttributes === true },
        );
        // Duplicate detection uses a plain read, not a transactional one:
        // reading runRef inside the transaction would take a read lock that
        // deadlocks against a concurrent resilient run_started reading the
        // same doc. The transaction holds no reads at all; `tx.create` on
        // both docs arbitrates at the commit, ALREADY_EXISTS re-enters here,
        // and this check turns a lost run race into EntityConflictError.
        result = await runEventTransaction(async (tx, allocator) => {
          const preExisting = await runRef.get();
          if (preExisting.exists) {
            throw new EntityConflictError(`Workflow run "${effectiveRunId}" already exists`);
          }
          const now = new Date();
          const { eventRef, record } = allocator.allocate();
          const runDoc: Record<string, unknown> = {
            runId: effectiveRunId,
            workflowName: runData.workflowName,
            specVersion: effectiveSpecVersion,
            status: 'pending',
            input: serializeNestedArrays(runData.input),
            executionContext: runData.executionContext,
            deploymentId: runData.deploymentId,
            attributes,
            ...(runData.encryptionPublicKey !== undefined
              ? { encryptionPublicKey: runData.encryptionPublicKey }
              : {}),
            createdAt: now,
            updatedAt: now,
          };
          tx.create(eventRef, record);
          tx.create(runRef, runDoc);

          const run: WorkflowRun = {
            runId: effectiveRunId,
            workflowName: runData.workflowName,
            specVersion: effectiveSpecVersion,
            status: 'pending',
            input: runData.input,
            executionContext: runData.executionContext,
            deploymentId: runData.deploymentId,
            attributes,
            encryptionPublicKey: runData.encryptionPublicKey,
            createdAt: now,
            updatedAt: now,
          };
          return {
            event: stripEventDataRefs(EventSchema.parse(record), resolveData),
            run,
            maxEvents: maxEventsPerRun,
          };
        });
        break;
      }

      // ============================================================
      // Run lifecycle transitions. All guards run inside a Firestore
      // transaction so concurrent terminal transitions cannot both pass
      // (read-then-blind-batch TOCTOU).
      // ============================================================
      case 'run_started':
      case 'run_completed':
      case 'run_failed':
      case 'run_cancelled': {
        const eventType = data.eventType;
        const txResult = await runEventTransaction(
          async (
            tx,
            allocator,
          ): Promise<{
            record: Record<string, unknown> | null;
            bootstrappedRun?: WorkflowRun;
            unchangedRun?: WorkflowRun;
          }> => {
            const [runSnap] = await tx.getAll(runRef);

            if (!runSnap.exists) {
              // ============================================================
              // RESILIENT START: bootstrap run from run_started eventData
              // (queue message carried runInput because run_created lost
              // the race or failed).
              // ============================================================
              const runInput = eventData as
                | {
                    deploymentId?: string;
                    workflowName?: string;
                    input?: unknown;
                    executionContext?: Record<string, unknown>;
                    attributes?: Record<string, string>;
                    encryptionPublicKey?: string;
                  }
                | undefined;
              if (
                eventType === 'run_started' &&
                runInput?.deploymentId &&
                runInput.workflowName &&
                runInput.input !== undefined
              ) {
                const now = new Date();
                // Synthetic run_created is allocated BEFORE run_started so
                // the journal replays in causal order.
                const created = allocator.allocate({
                  eventType: 'run_created',
                  eventData: {
                    deploymentId: runInput.deploymentId,
                    workflowName: runInput.workflowName,
                    input: runInput.input,
                    executionContext: runInput.executionContext,
                  },
                });
                const started = allocator.allocate();
                const attributes = runInput.attributes ?? {};
                const runDoc: Record<string, unknown> = {
                  runId: effectiveRunId,
                  workflowName: runInput.workflowName,
                  specVersion: effectiveSpecVersion,
                  status: 'running',
                  input: serializeNestedArrays(runInput.input),
                  executionContext: runInput.executionContext,
                  deploymentId: runInput.deploymentId,
                  attributes,
                  ...(runInput.encryptionPublicKey !== undefined
                    ? { encryptionPublicKey: runInput.encryptionPublicKey }
                    : {}),
                  startedAt: now,
                  createdAt: now,
                  updatedAt: now,
                };
                tx.create(created.eventRef, created.record);
                tx.create(started.eventRef, started.record);
                tx.create(runRef, runDoc);
                const run: WorkflowRun = {
                  runId: effectiveRunId,
                  workflowName: runInput.workflowName,
                  specVersion: effectiveSpecVersion,
                  status: 'running',
                  input: runInput.input,
                  executionContext: runInput.executionContext,
                  deploymentId: runInput.deploymentId,
                  attributes,
                  encryptionPublicKey: runInput.encryptionPublicKey,
                  startedAt: now,
                  createdAt: now,
                  updatedAt: now,
                };
                return { record: started.record, bootstrappedRun: run };
              }

              throw new WorkflowRunNotFoundError(effectiveRunId);
            }

            const currentRun = runFromDoc(runSnap.data() as FirebaseFirestore.DocumentData);

            // Terminal-state validation: runs cannot transition out of a
            // terminal state.
            if (isTerminalWorkflowRunStatus(currentRun.status)) {
              // Idempotent operation: run_cancelled on an already cancelled
              // run is allowed: record the event and return the run
              // unchanged.
              if (eventType === 'run_cancelled' && currentRun.status === 'cancelled') {
                const { eventRef, record } = allocator.allocate();
                tx.create(eventRef, record);
                return { record, unchangedRun: currentRun };
              }
              // For run_started on terminal runs, use RunExpiredError so
              // the runtime knows to exit without retrying.
              if (eventType === 'run_started') {
                throw new RunExpiredError(
                  `Workflow run "${effectiveRunId}" is already in terminal state "${currentRun.status}"`,
                );
              }
              throw new EntityConflictError(
                `Cannot transition run from terminal state "${currentRun.status}"`,
              );
            }

            // Idempotency: for run_started, if run is already running this
            // is a replay. Return existing run state without creating a
            // duplicate event.
            if (eventType === 'run_started' && currentRun.status === 'running') {
              return { record: null, unchangedRun: currentRun };
            }

            const now = new Date();
            const updates: Record<string, unknown> = { updatedAt: now };

            switch (eventType) {
              case 'run_started': {
                updates.status = 'running';
                if (!currentRun.startedAt) {
                  updates.startedAt = now;
                }
                // Non-final snapshots must not carry error/output/completedAt
                // (WorkflowRunSchema is a discriminated union on status).
                updates.output = FieldValue.delete();
                updates.error = FieldValue.delete();
                updates.errorCode = FieldValue.delete();
                updates.completedAt = FieldValue.delete();
                if (eventData?.input !== undefined) {
                  updates.input = serializeNestedArrays(eventData.input);
                }
                if (eventData?.deploymentId !== undefined) {
                  updates.deploymentId = eventData.deploymentId;
                }
                break;
              }
              case 'run_completed': {
                updates.status = 'completed';
                updates.completedAt = now;
                updates.error = FieldValue.delete();
                updates.errorCode = FieldValue.delete();
                if (eventData?.output !== undefined) {
                  updates.output = serializeNestedArrays(eventData.output);
                }
                break;
              }
              case 'run_failed': {
                updates.status = 'failed';
                updates.completedAt = now;
                updates.output = FieldValue.delete();
                // The error payload is opaque serialized data, stored
                // verbatim; errorCode is the only structured channel.
                if (eventData?.error !== undefined) {
                  updates.error = serializeNestedArrays(eventData.error);
                }
                if (typeof eventData?.errorCode === 'string') {
                  updates.errorCode = eventData.errorCode;
                }
                break;
              }
              case 'run_cancelled': {
                updates.status = 'cancelled';
                updates.completedAt = now;
                updates.output = FieldValue.delete();
                updates.error = FieldValue.delete();
                updates.errorCode = FieldValue.delete();
                break;
              }
            }

            const { eventRef, record } = allocator.allocate();
            tx.create(eventRef, record);
            tx.update(runRef, updates);
            return { record };
          });

        // Cleanup hooks and waits when run reaches terminal state
        if (isRunTerminalEvent && !txResult.unchangedRun) {
          await cleanupHooksAndWaits(effectiveRunId);
        }

        if (txResult.record === null) {
          // Idempotent run_started replay: no event was written.
          result = { run: txResult.unchangedRun };
        } else {
          result = {
            event: stripEventDataRefs(EventSchema.parse(txResult.record), resolveData),
            run:
              txResult.bootstrappedRun ?? txResult.unchangedRun ?? (await getRun(effectiveRunId)),
          };
        }
        break;
      }

      // ============================================================
      // attr_set: merge attribute changes onto the run entity + event
      // atomically. A workflow-writer attr_set with a correlationId is
      // deduplicated by a claim document, so a replayed event cannot
      // apply (or log) twice.
      // ============================================================
      case 'attr_set': {
        const attrData = eventData as {
          changes: { key: string; value: string | null }[];
          writer: { type: 'workflow' } | { type: 'step'; stepId: string; attempt: number };
          allowReservedAttributes?: boolean;
        };
        const claimRef =
          correlationId !== undefined && attrData.writer.type === 'workflow'
            ? runRef.collection('attr_claims').doc(correlationId)
            : undefined;

        result = await runEventTransaction(async (tx, allocator) => {
          const [runSnap, claimSnap] = await tx.getAll(...(claimRef ? [runRef, claimRef] : [runRef]));
          if (!runSnap.exists) {
            throw new WorkflowRunNotFoundError(effectiveRunId);
          }
          const currentRun = runFromDoc(runSnap.data() as FirebaseFirestore.DocumentData);
          if (isTerminalWorkflowRunStatus(currentRun.status)) {
            throw new EntityConflictError(
              `Cannot set attributes on run in terminal state "${currentRun.status}"`,
            );
          }
          if (claimSnap?.exists) {
            throw new EntityConflictError(`Attribute event "${correlationId}" already exists`);
          }

          const currentAttributes = currentRun.attributes ?? {};
          validateAttributeChanges(attrData.changes, {
            existingKeys: Object.keys(currentAttributes),
            allowReservedAttributes: attrData.allowReservedAttributes === true,
          });
          const attributes = applyAttributeChanges(currentAttributes, attrData.changes);

          const now = new Date();
          const { eventRef, record } = allocator.allocate();
          tx.create(eventRef, record);
          if (claimRef) {
            tx.create(claimRef, { createdAt: now });
          }
          tx.update(runRef, { attributes, updatedAt: now });

          return {
            event: stripEventDataRefs(EventSchema.parse(record), resolveData),
            run: { ...currentRun, attributes, updatedAt: now },
          };
        });
        break;
      }

      // ============================================================
      // step_created: create the step entity + event atomically.
      // Duplicates are rejected with EntityConflictError (matching the
      // postgres unique index on entity-creation events); the runtime's
      // concurrent-replay catch path swallows it.
      // ============================================================
      case 'step_created': {
        if (!correlationId) {
          throw new WorkflowWorldError('correlationId is required for step_created', {
            status: 400,
          });
        }
        const stepData = eventData as { stepName: string; input: unknown };
        const stepRef = runRef.collection('steps').doc(correlationId);

        result = await runEventTransaction(async (tx, allocator) => {
          const [runSnap, stepSnap] = await tx.getAll(runRef, stepRef);

          const runStatus = runSnap.exists
            ? String((runSnap.data() as FirebaseFirestore.DocumentData).status)
            : undefined;
          if (runStatus && isTerminalWorkflowRunStatus(runStatus)) {
            throw new EntityConflictError(
              `Cannot create new entities on run in terminal state "${runStatus}"`,
            );
          }

          if (stepSnap.exists) {
            throw new EntityConflictError(
              `step_created for correlationId "${correlationId}" already exists in run "${effectiveRunId}"`,
            );
          }

          const now = new Date();
          const { eventRef, record } = allocator.allocate();
          const stepDoc: Record<string, unknown> = {
            runId: effectiveRunId,
            stepId: correlationId,
            stepName: stepData.stepName,
            status: 'pending',
            input: serializeNestedArrays(stepData.input),
            attempt: 0,
            specVersion: effectiveSpecVersion,
            createdAt: now,
            updatedAt: now,
          };
          tx.create(eventRef, record);
          tx.create(stepRef, stepDoc);

          const step: Step = {
            runId: effectiveRunId,
            stepId: correlationId,
            stepName: stepData.stepName,
            status: 'pending',
            input: stepData.input,
            attempt: 0,
            specVersion: effectiveSpecVersion,
            createdAt: now,
            updatedAt: now,
          };
          return { event: stripEventDataRefs(EventSchema.parse(record), resolveData), step };
        });
        break;
      }

      // ============================================================
      // Step lifecycle transitions. Terminal-state / retryAfter guards
      // and the event write all happen inside one transaction so a
      // concurrent terminal event aborts the loser instead of being
      // silently overwritten. A lazy step_started carrying step-creation
      // data creates the step on the fly (with a synthetic step_created
      // event at the prior slot); winning that create is the runtime's
      // exactly-once inline-execution ownership signal.
      // ============================================================
      case 'step_started':
      case 'step_completed':
      case 'step_failed':
      case 'step_retrying': {
        const eventType = data.eventType;
        if (!correlationId) {
          throw new WorkflowWorldError(`correlationId is required for ${eventType}`, {
            status: 400,
          });
        }
        const stepRef = runRef.collection('steps').doc(correlationId);
        const lazyStepStart = eventType === 'step_started' && isChildEntityCreationEvent(data);

        const txOut = await runEventTransaction(
          async (
            tx,
            allocator,
          ): Promise<{ record: Record<string, unknown>; stepCreated?: true }> => {
            const refs = eventType === 'step_started' ? [stepRef, runRef] : [stepRef];
            const [stepSnap, runSnap] = await tx.getAll(...refs);

            if (!stepSnap.exists) {
              if (!lazyStepStart) {
                throw new WorkflowWorldError(`Step "${correlationId}" not found`, {
                  status: 404,
                });
              }
              const runStatus = runSnap?.exists
                ? String((runSnap.data() as FirebaseFirestore.DocumentData).status)
                : undefined;
              if (runStatus && isTerminalWorkflowRunStatus(runStatus)) {
                throw new EntityConflictError(
                  `Cannot create new entities on run in terminal state "${runStatus}"`,
                );
              }
              const lazyData = eventData as { stepName: string; input: unknown };
              const now = new Date();
              const created = allocator.allocate({
                eventType: 'step_created',
                eventData: { stepName: lazyData.stepName, input: lazyData.input },
              });
              const started = allocator.allocate();
              const stepDoc: Record<string, unknown> = {
                runId: effectiveRunId,
                stepId: correlationId,
                stepName: lazyData.stepName,
                status: 'running',
                input: serializeNestedArrays(lazyData.input),
                attempt: 1,
                specVersion: effectiveSpecVersion,
                startedAt: now,
                createdAt: now,
                updatedAt: now,
              };
              tx.create(created.eventRef, created.record);
              tx.create(started.eventRef, started.record);
              tx.create(stepRef, stepDoc);
              return { record: started.record, stepCreated: true };
            }

            // Exactly-once gate: an existing step means a concurrent handler
            // won the lazy create; the runtime maps this to `skipped`.
            if (lazyStepStart) {
              throw new EntityConflictError(`Step "${correlationId}" already created`);
            }

            const currentStep = stepFromDoc(stepSnap.data() as FirebaseFirestore.DocumentData);

            // Terminal-state validation: steps cannot be modified once
            // completed or failed. The runtime relies on this to dedupe
            // redelivered step messages; without it, a late step_started
            // lands in the event log after step_completed and corrupts
            // replay.
            if (isTerminalStepStatus(currentStep.status)) {
              throw new EntityConflictError(
                `Cannot modify step in terminal state "${currentStep.status}"`,
              );
            }

            if (eventType === 'step_started') {
              // Retried steps may be scheduled for later. The runtime turns
              // TooEarlyError into a delayed queue retry.
              if (currentStep.retryAfter && currentStep.retryAfter.getTime() > Date.now()) {
                throw new TooEarlyError(
                  `Cannot start step "${correlationId}": retryAfter timestamp has not been reached yet`,
                  {
                    retryAfter: Math.ceil((currentStep.retryAfter.getTime() - Date.now()) / 1000),
                  },
                );
              }

              // On terminal runs, only steps that are already running may
              // proceed (to record their completion); new work must not
              // start on a cancelled run.
              if (runSnap?.exists) {
                const runStatus = String(
                  (runSnap.data() as FirebaseFirestore.DocumentData).status,
                );
                if (isTerminalWorkflowRunStatus(runStatus) && currentStep.status !== 'running') {
                  throw new RunExpiredError(
                    `Cannot modify non-running step on run in terminal state "${runStatus}"`,
                  );
                }
              }
            }

            const now = new Date();
            const updates: Record<string, unknown> = { updatedAt: now };

            switch (eventType) {
              case 'step_started': {
                updates.status = 'running';
                updates.attempt = (currentStep.attempt || 0) + 1;
                if (!currentStep.startedAt) {
                  updates.startedAt = now;
                }
                // Clear retryAfter now that the step has started
                updates.retryAfter = FieldValue.delete();
                break;
              }
              case 'step_completed': {
                updates.status = 'completed';
                updates.completedAt = now;
                if (eventData?.result !== undefined) {
                  updates.output = serializeNestedArrays(eventData.result);
                }
                break;
              }
              case 'step_failed': {
                updates.status = 'failed';
                updates.completedAt = now;
                // Opaque serialized error, stored verbatim.
                if (eventData?.error !== undefined) {
                  updates.error = serializeNestedArrays(eventData.error);
                }
                break;
              }
              case 'step_retrying': {
                updates.status = 'pending';
                if (eventData?.error !== undefined) {
                  updates.error = serializeNestedArrays(eventData.error);
                }
                if (eventData?.retryAfter !== undefined) {
                  updates.retryAfter = new Date(eventData.retryAfter as string);
                }
                break;
              }
            }

            const { eventRef, record } = allocator.allocate();
            tx.create(eventRef, record);
            tx.update(stepRef, updates);
            return { record };
          });

        result = {
          event: stripEventDataRefs(EventSchema.parse(txOut.record), resolveData),
          step: await getStep(effectiveRunId, correlationId),
          ...(txOut.stepCreated ? { stepCreated: true as const } : {}),
        };
        break;
      }

      // ============================================================
      // hook_created: create hook entity + token index + event
      // atomically.
      //
      // Token uniqueness semantics:
      // - Same (runId, hookId) already owns the token and its
      //   hook_created event is in the log -> duplicate/replayed
      //   processing: throw EntityConflictError so the runtime's
      //   concurrent-replay catch path swallows it (matching
      //   step_created).
      // - Same (runId, hookId) without a hook_created event ->
      //   crash-orphaned hook entity from a pre-transactional version:
      //   complete the partial write by publishing the missing event.
      // - A different (runId, hookId) owns the token -> record a
      //   hook_conflict event so the workflow can fail gracefully when
      //   the hook is awaited.
      // ============================================================
      case 'hook_created': {
        if (!correlationId) {
          throw new WorkflowWorldError('correlationId is required for hook_created', {
            status: 400,
          });
        }
        const hookData = eventData as { token: string; metadata?: unknown; isSystem?: boolean };
        if (!hookData.token) {
          debug('[hook_created] Missing token in eventData');
        }
        const hookRef = runRef.collection('hooks').doc(correlationId);
        const tokenRef = firestore.collection('hooks_by_token').doc(hookData.token);

        result = await runEventTransaction(async (tx, allocator) => {
          const [runSnap, tokenSnap] = await tx.getAll(runRef, tokenRef);

          // A hook_created landing after the terminal transition's
          // cleanup would orphan the token index forever; reject it.
          const runStatus = runSnap.exists
            ? String((runSnap.data() as FirebaseFirestore.DocumentData).status)
            : undefined;
          if (runStatus && isTerminalWorkflowRunStatus(runStatus)) {
            throw new EntityConflictError(
              `Cannot create new entities on run in terminal state "${runStatus}"`,
            );
          }

          if (tokenSnap.exists) {
            const existing = tokenSnap.data() as FirebaseFirestore.DocumentData;

            if (existing.runId === effectiveRunId && existing.hookId === correlationId) {
              const existingEvent = await tx.get(
                eventsCol
                  .where('correlationId', '==', correlationId)
                  .where('eventType', '==', 'hook_created')
                  .limit(1),
              );

              if (!existingEvent.empty) {
                throw new EntityConflictError(`Hook "${correlationId}" already created`);
              }

              // Orphaned hook entity: publish the missing hook_created
              // event and return the persisted hook rather than mutating
              // it with this retry's payload.
              const { eventRef, record } = allocator.allocate();
              tx.create(eventRef, record);
              return {
                event: stripEventDataRefs(EventSchema.parse(record), resolveData),
                hook: hookFromDoc(existing),
              };
            }

            // Cross-hook / cross-run conflict: a different (runId, hookId)
            // holds this token. Record a hook_conflict event instead of
            // throwing.
            const { eventRef, record } = allocator.allocate({
              eventType: 'hook_conflict',
              eventData: { token: hookData.token, conflictingRunId: existing.runId },
            });
            tx.create(eventRef, record);
            return { event: stripEventDataRefs(EventSchema.parse(record), resolveData) };
          }

          const now = new Date();
          const { eventRef, record } = allocator.allocate();
          const hookDoc = {
            runId: effectiveRunId,
            hookId: correlationId,
            token: hookData.token,
            ownerId: '',
            projectId: '',
            environment: '',
            specVersion: effectiveSpecVersion,
            createdAt: now,
            metadata: serializeNestedArrays(hookData.metadata),
            ...(hookData.isSystem !== undefined ? { isSystem: hookData.isSystem } : {}),
          };
          tx.create(eventRef, record);
          tx.set(hookRef, hookDoc);
          tx.set(tokenRef, hookDoc);

          return {
            event: stripEventDataRefs(EventSchema.parse(record), resolveData),
            hook: HookSchema.parse(compact({ ...hookDoc, metadata: hookData.metadata })),
          };
        });
        break;
      }

      // ============================================================
      // hook_disposed: delete hook entity + token index atomically,
      // releasing the token for reuse by other hooks.
      // ============================================================
      case 'hook_disposed': {
        if (!correlationId) {
          throw new WorkflowWorldError('correlationId is required for hook_disposed', {
            status: 400,
          });
        }
        const hookRef = runRef.collection('hooks').doc(correlationId);

        result = await runEventTransaction(async (tx, allocator) => {
          const [hookSnap] = await tx.getAll(hookRef);
          if (!hookSnap.exists) {
            // Typed error: core's resume-or-start pattern matches this by
            // name via HookNotFoundError.is().
            throw new HookNotFoundError(correlationId);
          }
          const hookDoc = hookSnap.data() as FirebaseFirestore.DocumentData;

          const { eventRef, record } = allocator.allocate();
          tx.create(eventRef, record);
          tx.delete(hookRef);
          if (typeof hookDoc.token === 'string' && hookDoc.token.length > 0) {
            tx.delete(firestore.collection('hooks_by_token').doc(hookDoc.token));
          }
          return { event: stripEventDataRefs(EventSchema.parse(record), resolveData) };
        });
        break;
      }

      // ============================================================
      // hook_received: event-only, but the hook must still exist;
      // a payload delivered concurrently with disposal must not be
      // silently appended to the event log.
      // ============================================================
      case 'hook_received': {
        if (!correlationId) {
          throw new WorkflowWorldError('correlationId is required for hook_received', {
            status: 400,
          });
        }
        result = await runEventTransaction(async (tx, allocator) => {
          // Hooks live in per-run subcollections; match postgres semantics
          // (global lookup by hookId) with a collection-group query.
          const hookQuery = await tx.get(
            firestore.collectionGroup('hooks').where('hookId', '==', correlationId).limit(1),
          );
          if (hookQuery.empty) {
            throw new HookNotFoundError(correlationId);
          }
          const { eventRef, record } = allocator.allocate();
          tx.create(eventRef, record);
          return { event: stripEventDataRefs(EventSchema.parse(record), resolveData) };
        });
        break;
      }

      // ============================================================
      // wait_created: create wait entity + event atomically. Duplicates
      // are rejected with EntityConflictError; core relies on this to
      // dedupe concurrent replays.
      // ============================================================
      case 'wait_created': {
        if (!correlationId) {
          throw new WorkflowWorldError('correlationId is required for wait_created', {
            status: 400,
          });
        }
        const waitRef = runRef.collection('waits').doc(correlationId);
        const waitId = `${effectiveRunId}-${correlationId}`;

        result = await runEventTransaction(async (tx, allocator) => {
          const [runSnap, waitSnap] = await tx.getAll(runRef, waitRef);

          const runStatus = runSnap.exists
            ? String((runSnap.data() as FirebaseFirestore.DocumentData).status)
            : undefined;
          if (runStatus && isTerminalWorkflowRunStatus(runStatus)) {
            throw new EntityConflictError(
              `Cannot create new entities on run in terminal state "${runStatus}"`,
            );
          }

          if (waitSnap.exists) {
            throw new EntityConflictError(`Wait "${correlationId}" already exists`);
          }

          const now = new Date();
          const resumeAt = eventData?.resumeAt
            ? new Date(eventData.resumeAt as string | number | Date)
            : undefined;
          const { eventRef, record } = allocator.allocate();
          const waitDoc: Record<string, unknown> = {
            waitId,
            runId: effectiveRunId,
            status: 'waiting',
            resumeAt,
            specVersion: effectiveSpecVersion,
            createdAt: now,
            updatedAt: now,
          };
          tx.create(eventRef, record);
          tx.create(waitRef, waitDoc);

          return {
            event: stripEventDataRefs(EventSchema.parse(record), resolveData),
            wait: WaitSchema.parse(compact(waitDoc)),
          };
        });
        break;
      }

      // ============================================================
      // wait_completed: transition wait to 'completed'; duplicate
      // completions (wakeUpRun racing natural wake) are rejected with
      // EntityConflictError, which core swallows.
      // ============================================================
      case 'wait_completed': {
        if (!correlationId) {
          throw new WorkflowWorldError('correlationId is required for wait_completed', {
            status: 400,
          });
        }
        const waitRef = runRef.collection('waits').doc(correlationId);

        result = await runEventTransaction(async (tx, allocator) => {
          const [waitSnap] = await tx.getAll(waitRef);
          if (!waitSnap.exists) {
            throw new WorkflowWorldError(`Wait "${correlationId}" not found`, {
              status: 404,
            });
          }
          const waitDoc = waitSnap.data() as FirebaseFirestore.DocumentData;
          if (waitDoc.status === 'completed') {
            throw new EntityConflictError(`Wait "${correlationId}" already completed`);
          }

          const now = new Date();
          const { eventRef, record } = allocator.allocate();
          tx.create(eventRef, record);
          tx.update(waitRef, { status: 'completed', completedAt: now, updatedAt: now });

          return {
            event: stripEventDataRefs(EventSchema.parse(record), resolveData),
            wait: waitFromDoc({
              ...waitDoc,
              status: 'completed',
              completedAt: now,
              updatedAt: now,
            }),
          };
        });
        break;
      }

      // hook_conflict, noop (and any future event-only types): no entity
      // mutation, just an appended event.
      default: {
        result = await runEventTransaction(async (tx, allocator) => {
          const { eventRef, record } = allocator.allocate();
          tx.create(eventRef, record);
          return { event: stripEventDataRefs(EventSchema.parse(record), resolveData) };
        });
        break;
      }
    }

    // run_started responses carry the per-run event ceiling and (unless the
    // caller opts out) a preload of the full log, on the fresh transition and
    // the idempotent already-running replay alike.
    if (data.eventType === 'run_started' && result.run) {
      if (!params?.skipPreload && result.events === undefined) {
        const page = await preloadAllEvents(effectiveRunId, resolveData);
        result = {
          ...result,
          maxEvents: maxEventsPerRun,
          events: page.events,
          cursor: page.cursor,
          hasMore: page.hasMore,
        };
      } else {
        result = { ...result, maxEvents: maxEventsPerRun };
      }
    }

    return result;
  }

  const create = (async (
    runId: string | null,
    data: RunCreatedEventRequest | CreateEventRequest,
    params?: CreateEventParams,
  ): Promise<EventResult> => {
    const result = await createImpl(runId, data, params);
    const resolveData = params?.resolveData ?? 'all';

    // Inline-delta optimization: the delta of events strictly after
    // `sinceCursor`, exactly what `events.list` would return right now. It
    // wins over the skipped-slot report (it is a strict superset and the only
    // one of the two that advances the caller's cursor), and applies to the
    // hook_conflict a claimed-token create commits instead.
    if (typeof params?.sinceCursor === 'string' && result.event) {
      const page = await listEvents({
        runId: result.event.runId,
        pagination: { cursor: params.sinceCursor, sortOrder: 'asc' },
        resolveData,
      });
      return { ...result, events: page.data, cursor: page.cursor, hasMore: page.hasMore };
    }

    if (params?.eventCount !== undefined && result.event && result.events === undefined) {
      return reportSkippedSlots(result, params.eventCount, resolveData);
    }

    return result;
  }) as Storage['events']['create'];

  const experimentalSetAttributes: NonNullable<Storage['runs']['experimentalSetAttributes']> =
    async (runId, changes, options) => {
      const runRef = firestore.collection('workflow_runs').doc(runId);
      return firestore.runTransaction(async (tx) => {
        const snap = await tx.get(runRef);
        if (!snap.exists) {
          throw new WorkflowRunNotFoundError(runId);
        }
        const current = ((snap.data() as FirebaseFirestore.DocumentData).attributes ??
          {}) as Record<string, string>;
        validateAttributeChanges(changes, {
          existingKeys: Object.keys(current),
          allowReservedAttributes: options?.allowReservedAttributes === true,
        });
        const attributes = applyAttributeChanges(current, changes);
        tx.update(runRef, { attributes, updatedAt: new Date() });
        return { attributes };
      });
    };

  return {
    runs: {
      async get(runId: string, params?: GetWorkflowRunParams) {
        const run = await getRun(runId);
        return filterData(run, params?.resolveData, ['input', 'output']);
      },

      async list(
        params?: ListWorkflowRunsParams,
      ): Promise<PaginatedResponse<WorkflowRun | WorkflowRunWithoutData>> {
        const limit = params?.pagination?.limit ?? 20;
        let query: Query = firestore.collection('workflow_runs');

        if (params?.workflowName) {
          query = query.where('workflowName', '==', params.workflowName);
        }

        if (params?.status) {
          query = query.where('status', '==', params.status);
        }

        query = query.orderBy('createdAt', 'desc').limit(limit + 1);

        if (params?.pagination?.cursor) {
          const cursorDoc = await firestore
            .collection('workflow_runs')
            .doc(params.pagination.cursor)
            .get();
          if (cursorDoc.exists) {
            query = query.startAfter(cursorDoc);
          }
        }

        const snapshot = await query.get();
        const all = snapshot.docs;
        const values = all.slice(0, limit);
        const hasMore = all.length > limit;

        return {
          data: values.map((doc) => {
            const run = runFromDoc(doc.data());
            return filterData(run, params?.resolveData, ['input', 'output']);
          }),
          cursor: values.at(-1)?.id ?? null,
          hasMore,
        };
      },

      experimentalSetAttributes,
    } as Storage['runs'],

    events: {
      create,

      async get(runId: string, eventId: string, params?: GetEventParams): Promise<Event> {
        const doc = await firestore
          .collection('workflow_runs')
          .doc(runId)
          .collection('events')
          .doc(eventId)
          .get();

        if (!doc.exists) {
          throw new WorkflowWorldError(`Event not found: ${eventId}`, {
            status: 404,
          });
        }

        const event = eventFromDoc(doc.data() as FirebaseFirestore.DocumentData);
        return stripEventDataRefs(event, params?.resolveData ?? 'all');
      },

      list: listEvents,

      async listByCorrelationId(
        params: ListEventsByCorrelationIdParams,
      ): Promise<PaginatedResponse<Event>> {
        const { correlationId, runId } = params;
        const limit = params?.pagination?.limit ?? 100;
        const sortOrder = params.pagination?.sortOrder || 'asc';
        const resolveData = params?.resolveData ?? 'all';

        // A correlationId identifies a step, hook or wait within its run, so
        // the lookup is always run-scoped. Requires the composite index
        // `correlationId ASC, runId ASC, eventId ASC|DESC` declared in
        // firestore.indexes.json.
        let query: Query = firestore
          .collectionGroup('events')
          .where('correlationId', '==', correlationId)
          .where('runId', '==', runId)
          .orderBy('eventId', sortOrder)
          .limit(limit + 1);

        if (params?.pagination?.cursor) {
          query = query.startAfter(params.pagination.cursor);
        }

        const snapshot = await query.get();
        const all = snapshot.docs;
        const values = all.slice(0, limit);
        const hasMore = all.length > limit;
        const lastEventId = values.at(-1)?.data().eventId;

        return {
          data: values.map((doc) => stripEventDataRefs(eventFromDoc(doc.data()), resolveData)),
          cursor: typeof lastEventId === 'string' ? lastEventId : null,
          hasMore,
        };
      },
    },

    steps: {
      async get(runId: string, stepId: string, params?: GetStepParams) {
        const step = await getStep(runId, stepId);
        return filterData(step, params?.resolveData, ['input', 'output']);
      },

      async list(
        params: ListWorkflowRunStepsParams,
      ): Promise<PaginatedResponse<Step | StepWithoutData>> {
        const { runId } = params;
        const limit = params?.pagination?.limit ?? 20;

        let query: Query = firestore
          .collection('workflow_runs')
          .doc(runId)
          .collection('steps')
          .orderBy('createdAt', 'desc')
          .limit(limit + 1);

        if (params?.pagination?.cursor) {
          const cursorDoc = await firestore
            .collection('workflow_runs')
            .doc(runId)
            .collection('steps')
            .doc(params.pagination.cursor)
            .get();
          if (cursorDoc.exists) {
            query = query.startAfter(cursorDoc);
          }
        }

        const snapshot = await query.get();
        const all = snapshot.docs;
        const values = all.slice(0, limit);
        const hasMore = all.length > limit;

        return {
          data: values.map((doc) => {
            const step = stepFromDoc(doc.data());
            return filterData(step, params?.resolveData, ['input', 'output']);
          }),
          cursor: values.at(-1)?.id ?? null,
          hasMore,
        };
      },
    } as Storage['steps'],

    hooks: {
      async get(hookId: string, params?: GetHookParams) {
        // NOTE: This method may not be used by @workflow/world-testing.
        // The hooks test typically uses hooks.getByToken() instead.
        // Collection group queries require composite indexes in production Firestore.

        // Query hooks across all runs by hookId
        // We need to use a collection group query since hooks are stored in subcollections
        try {
          const hooksQuery = await firestore
            .collectionGroup('hooks')
            .where('hookId', '==', hookId)
            .limit(1)
            .get();

          if (hooksQuery.empty) {
            throw new HookNotFoundError(hookId);
          }

          const doc = hooksQuery.docs[0];
          const parsed = hookFromDoc(doc.data());
          const resolveData = params?.resolveData ?? 'all';
          return filterHookData(parsed, resolveData);
        } catch (error) {
          // Log and re-throw to help diagnose CI issues
          debug('[hooks.get] Error querying hooks:', error);
          throw error;
        }
      },

      async getByToken(token: string, params?: GetHookParams) {
        const doc = await firestore.collection('hooks_by_token').doc(token).get();

        if (!doc.exists) {
          // Typed error: core's documented resume-or-start pattern matches
          // this by name via HookNotFoundError.is().
          throw new HookNotFoundError(token);
        }

        const parsed = hookFromDoc(doc.data() as FirebaseFirestore.DocumentData);
        const resolveData = params?.resolveData ?? 'all';
        return filterHookData(parsed, resolveData);
      },

      async list(params: ListHooksParams): Promise<PaginatedResponse<Hook>> {
        if (!params.runId) {
          throw new WorkflowWorldError('runId is required for listing hooks', {
            status: 400,
          });
        }
        const runId = params.runId;
        const limit = params?.pagination?.limit ?? 100;

        let query: Query = firestore
          .collection('workflow_runs')
          .doc(runId)
          .collection('hooks')
          .orderBy('createdAt', 'desc')
          .limit(limit + 1);

        if (params?.pagination?.cursor) {
          const cursorDoc = await firestore
            .collection('workflow_runs')
            .doc(runId)
            .collection('hooks')
            .doc(params.pagination.cursor)
            .get();
          if (cursorDoc.exists) {
            query = query.startAfter(cursorDoc);
          }
        }

        const snapshot = await query.get();
        const all = snapshot.docs;
        const values = all.slice(0, limit);
        const hasMore = all.length > limit;

        return {
          data: values.map((doc) => {
            const parsed = hookFromDoc(doc.data());
            return filterHookData(parsed, params?.resolveData ?? 'all');
          }),
          cursor: values.at(-1)?.id ?? null,
          hasMore,
        };
      },
    },
  };
}

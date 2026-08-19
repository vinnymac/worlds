import type { Firestore, Query } from '@google-cloud/firestore';
import { FieldValue } from '@google-cloud/firestore';
import {
  EntityConflictError,
  HookNotFoundError,
  PreconditionFailedError,
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
  UpdateStepRequest,
  Wait,
  WorkflowRun,
  WorkflowRunWithoutData,
} from '@workflow/world';
import {
  EventSchema,
  HookSchema,
  isTerminalStepStatus,
  isTerminalWorkflowRunStatus,
  SPEC_VERSION_CURRENT,
  ulidToDate,
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

/** Subcollection + document holding the per-run concurrency marker. Kept out
 * of the run document so advancing it never contends with lifecycle
 * transitions or a parallel step fan-out. */
const STATE_MARKER_COLLECTION = 'meta';
const STATE_MARKER_DOC = 'state';

/** Event types that advance the state marker when created outside a replay.
 * Narrow by design: core also omits `stateUpdatedAt` on `run_created` /
 * `run_started` / `run_failed`, and advancing there would reject replays. */
const EXTERNAL_EVENT_TYPES: ReadonlySet<string> = new Set(['hook_received', 'step_completed']);

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

/** ULID time (epoch ms) of a prefixed event id, or undefined when it is not
 * a decodable ULID. Mirrors core, which likewise fails open. */
function eventIdTime(eventId: string): number | undefined {
  const underscore = eventId.lastIndexOf('_');
  const rawUlid = underscore === -1 ? eventId : eventId.slice(underscore + 1);
  return ulidToDate(rawUlid)?.getTime();
}

interface SerializedError {
  message: string;
  stack?: string;
  code?: string;
}

type SerializedStepUpdate = Omit<UpdateStepRequest, 'error'> & {
  error?: SerializedError;
};

function isValidRunData(data: unknown): data is Record<string, unknown> & { error?: unknown } {
  return typeof data === 'object' && data !== null;
}

function deserializeRunError(data: unknown): WorkflowRun {
  if (!isValidRunData(data)) {
    throw new WorkflowWorldError('Invalid run data', { status: 500 });
  }

  if (!data.error) {
    return data as WorkflowRun;
  }

  const error = data.error as {
    message?: string;
    stack?: string;
    code?: string;
  };
  return {
    ...data,
    error: {
      message: error.message || '',
      stack: error.stack,
      code: error.code,
    },
  } as WorkflowRun;
}

function _serializeStepError(data: UpdateStepRequest): SerializedStepUpdate {
  const baseData = {
    ...data,
  };

  if (!baseData.error) {
    return baseData;
  }

  const { error, ...rest } = baseData;
  return {
    ...rest,
    error: {
      message: error.message,
      stack: error.stack,
      code: error.code,
    },
  };
}

function isValidStepData(data: unknown): data is Record<string, unknown> & { error?: unknown } {
  return typeof data === 'object' && data !== null;
}

function deserializeStepError(data: unknown): Step {
  if (!isValidStepData(data)) {
    throw new WorkflowWorldError('Invalid step data', { status: 500 });
  }

  if (!data.error) {
    return data as Step;
  }

  const error = data.error as {
    message?: string;
    stack?: string;
    code?: string;
  };
  return {
    ...data,
    error: {
      message: error.message || '',
      stack: error.stack,
      code: error.code,
    },
  } as Step;
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
 * Recursively convert Buffer instances to Uint8Array.
 * Firestore stores Uint8Array as Buffer, but the spec expects Uint8Array.
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
    return value.map(convertBuffersToUint8Array);
  }

  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      result[key] = convertBuffersToUint8Array(val);
    }
    return result;
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
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && '__nested_array__' in parsed) {
        return convertBuffersToUint8Array(parsed.__nested_array__);
      }
    } catch {
      // Not JSON, return as-is
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

/**
 * Serialize an error object for Firestore storage.
 */
/** `overrides.code` carries `eventData.errorCode`, naming a run_failed reason
 * (e.g. MAX_EVENTS_EXCEEDED). Custom error classes do not survive the wire,
 * so `run.error.code` is the only channel for it. */
function serializeError(
  error: unknown,
  overrides: { code?: unknown } = {},
): SerializedError | undefined {
  if (!error) return undefined;
  const err = error as { message?: string; stack?: string; code?: string };
  return {
    message: err.message || '',
    stack: err.stack,
    code: typeof overrides.code === 'string' ? overrides.code : err.code,
  };
}

/** Deserialize a run entity from a Firestore document. */
function runFromDoc(data: FirebaseFirestore.DocumentData): WorkflowRun {
  return deserializeRunError({
    ...data,
    input: deserializeNestedArrays(data.input),
    output: deserializeNestedArrays(data.output),
    createdAt: fromFirestoreTimestamp(data.createdAt),
    updatedAt: fromFirestoreTimestamp(data.updatedAt),
    startedAt: fromFirestoreTimestamp(data.startedAt),
    completedAt: fromFirestoreTimestamp(data.completedAt),
  });
}

/** Deserialize a step entity from a Firestore document. */
function stepFromDoc(data: FirebaseFirestore.DocumentData): Step {
  return deserializeStepError({
    ...data,
    input: deserializeNestedArrays(data.input),
    output: deserializeNestedArrays(data.output),
    createdAt: fromFirestoreTimestamp(data.createdAt),
    updatedAt: fromFirestoreTimestamp(data.updatedAt),
    startedAt: fromFirestoreTimestamp(data.startedAt),
    completedAt: fromFirestoreTimestamp(data.completedAt),
    retryAfter: fromFirestoreTimestamp(data.retryAfter),
  });
}

/** Deserialize a hook entity from a Firestore document. */
function hookFromDoc(data: FirebaseFirestore.DocumentData): Hook {
  return HookSchema.parse({
    runId: data.runId,
    hookId: data.hookId,
    token: data.token,
    ownerId: data.ownerId || '',
    projectId: data.projectId || '',
    environment: data.environment || '',
    specVersion: data.specVersion,
    createdAt: fromFirestoreTimestamp(data.createdAt) || new Date(),
    metadata: deserializeNestedArrays(data.metadata),
  });
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
    } as Storage['runs'],

    events: {
      async create(
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

        /**
         * Allocate the event record. Called INSIDE transactions AFTER all
         * validation reads have passed, so a writer blocked on contended
         * documents never carries a stale (older) eventId into a later
         * commit; replays observe events in eventId order.
         */
        function allocateEvent(overrides?: Partial<Record<string, unknown>>): {
          eventId: string;
          eventRef: FirebaseFirestore.DocumentReference;
          record: Record<string, unknown>;
        } {
          const eventId = `wevt_${ulid()}`;
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
        }

        // The marker read happens inside the same transaction as the event write, so
        // it is a transaction precondition: an externally-originated event landing
        // in between aborts and retries against the newer marker.
        const stateUpdatedAt = params?.stateUpdatedAt;
        const markerRef = runRef.collection(STATE_MARKER_COLLECTION).doc(STATE_MARKER_DOC);
        /** Whether this create is externally originated and therefore owns the
         * marker. Replay-origin creates carry a `stateUpdatedAt` and must never
         * advance it, or a run would reject its own later writes. */
        const advancesStateMarker =
          stateUpdatedAt === undefined && EXTERNAL_EVENT_TYPES.has(data.eventType);

        /** Read the marker and enforce the guard. Must run before any write;
         * Firestore requires all reads first. Returns the current marker so the
         * write side can keep it monotonic. */
        async function readStateMarker(
          tx: FirebaseFirestore.Transaction,
        ): Promise<number | undefined> {
          if (stateUpdatedAt === undefined && !advancesStateMarker) return undefined;
          const snap = await tx.get(markerRef);
          const raw = snap.exists
            ? (snap.data() as FirebaseFirestore.DocumentData).stateUpdatedAt
            : undefined;
          const marker = typeof raw === 'number' ? raw : undefined;
          if (stateUpdatedAt !== undefined && marker !== undefined && stateUpdatedAt < marker) {
            throw new PreconditionFailedError(
              `Event creation for run "${effectiveRunId}" is based on a stale snapshot ` +
                `(stateUpdatedAt ${stateUpdatedAt} < ${marker})`,
            );
          }
          return marker;
        }

        /** Advance the marker to this event's ULID time, monotonically. */
        function advanceStateMarker(
          tx: FirebaseFirestore.Transaction,
          eventId: string,
          marker: number | undefined,
        ): void {
          if (!advancesStateMarker) return;
          const time = eventIdTime(eventId);
          if (time === undefined) return;
          if (marker !== undefined && time <= marker) return;
          tx.set(markerRef, { stateUpdatedAt: time }, { merge: true });
        }

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
            result = await firestore.runTransaction(async (tx) => {
              await readStateMarker(tx);
              const existing = await tx.get(runRef);
              if (existing.exists) {
                throw new EntityConflictError(`Workflow run "${effectiveRunId}" already exists`);
              }

              const now = new Date();
              const { eventRef, record } = allocateEvent();
              const runDoc: Record<string, unknown> = {
                runId: effectiveRunId,
                workflowName: runData.workflowName,
                specVersion: effectiveSpecVersion,
                status: 'pending',
                input: serializeNestedArrays(runData.input),
                executionContext: runData.executionContext,
                deploymentId: runData.deploymentId,
                createdAt: now,
                updatedAt: now,
              };
              tx.set(eventRef, record);
              tx.set(runRef, runDoc);

              const run: WorkflowRun = {
                runId: effectiveRunId,
                workflowName: runData.workflowName,
                specVersion: effectiveSpecVersion,
                status: 'pending',
                input: runData.input,
                executionContext: runData.executionContext,
                deploymentId: runData.deploymentId,
                createdAt: now,
                updatedAt: now,
              };
              return { event: EventSchema.parse(record), run };
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
            const txResult = await firestore.runTransaction(
              async (
                tx,
              ): Promise<{
                record: Record<string, unknown> | null;
                bootstrappedRun?: WorkflowRun;
                unchangedRun?: WorkflowRun;
              }> => {
                await readStateMarker(tx);
                const runSnap = await tx.get(runRef);

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
                    const created = allocateEvent({
                      eventType: 'run_created',
                      eventData: {
                        deploymentId: runInput.deploymentId,
                        workflowName: runInput.workflowName,
                        input: runInput.input,
                        executionContext: runInput.executionContext,
                      },
                    });
                    const started = allocateEvent();
                    const runDoc: Record<string, unknown> = {
                      runId: effectiveRunId,
                      workflowName: runInput.workflowName,
                      specVersion: effectiveSpecVersion,
                      status: 'running',
                      input: serializeNestedArrays(runInput.input),
                      executionContext: runInput.executionContext,
                      deploymentId: runInput.deploymentId,
                      startedAt: now,
                      createdAt: now,
                      updatedAt: now,
                    };
                    tx.set(created.eventRef, created.record);
                    tx.set(started.eventRef, started.record);
                    tx.set(runRef, runDoc);
                    const run: WorkflowRun = {
                      runId: effectiveRunId,
                      workflowName: runInput.workflowName,
                      specVersion: effectiveSpecVersion,
                      status: 'running',
                      input: runInput.input,
                      executionContext: runInput.executionContext,
                      deploymentId: runInput.deploymentId,
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
                    const { eventRef, record } = allocateEvent();
                    tx.set(eventRef, record);
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
                    if (eventData?.output !== undefined) {
                      updates.output = serializeNestedArrays(eventData.output);
                    }
                    break;
                  }
                  case 'run_failed': {
                    updates.status = 'failed';
                    updates.completedAt = now;
                    updates.output = FieldValue.delete();
                    if (eventData?.error !== undefined) {
                      updates.error = serializeError(eventData.error, {
                        code: eventData.errorCode,
                      });
                    }
                    break;
                  }
                  case 'run_cancelled': {
                    updates.status = 'cancelled';
                    updates.completedAt = now;
                    updates.output = FieldValue.delete();
                    updates.error = FieldValue.delete();
                    break;
                  }
                }

                const { eventRef, record } = allocateEvent();
                tx.set(eventRef, record);
                tx.update(runRef, updates);
                return { record };
              },
            );

            // Cleanup hooks and waits when run reaches terminal state
            if (isRunTerminalEvent && !txResult.unchangedRun) {
              await cleanupHooksAndWaits(effectiveRunId);
            }

            if (txResult.record === null) {
              // Idempotent run_started replay: no event was written.
              result = { run: txResult.unchangedRun };
            } else {
              result = {
                event: EventSchema.parse(txResult.record),
                run:
                  txResult.bootstrappedRun ??
                  txResult.unchangedRun ??
                  (await getRun(effectiveRunId)),
              };
            }
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

            result = await firestore.runTransaction(async (tx) => {
              await readStateMarker(tx);
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
              const { eventRef, record } = allocateEvent();
              const stepDoc: Record<string, unknown> = {
                runId: effectiveRunId,
                stepId: correlationId,
                stepName: stepData.stepName,
                status: 'pending',
                input: serializeNestedArrays(stepData.input),
                attempt: 1,
                specVersion: effectiveSpecVersion,
                createdAt: now,
                updatedAt: now,
              };
              tx.set(eventRef, record);
              tx.set(stepRef, stepDoc);

              const step: Step = {
                runId: effectiveRunId,
                stepId: correlationId,
                stepName: stepData.stepName,
                status: 'pending',
                input: stepData.input,
                attempt: 1,
                specVersion: effectiveSpecVersion,
                createdAt: now,
                updatedAt: now,
              };
              return { event: EventSchema.parse(record), step };
            });
            break;
          }

          // ============================================================
          // Step lifecycle transitions. Terminal-state / retryAfter guards
          // and the event write all happen inside one transaction so a
          // concurrent terminal event aborts the loser instead of being
          // silently overwritten.
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

            const record = await firestore.runTransaction(async (tx) => {
              const marker = await readStateMarker(tx);
              const stepSnap = await tx.get(stepRef);
              if (!stepSnap.exists) {
                throw new WorkflowWorldError(`Step "${correlationId}" not found`, {
                  status: 404,
                });
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
                const runSnap = await tx.get(runRef);
                if (runSnap.exists) {
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
                  if (!currentStep.startedAt) {
                    updates.startedAt = now;
                  }
                  // Clear retryAfter now that the step has started
                  updates.retryAfter = FieldValue.delete();
                  if (eventData?.attempt !== undefined) {
                    updates.attempt = eventData.attempt;
                  }
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
                  if (eventData?.error !== undefined) {
                    updates.error = serializeError(eventData.error);
                  }
                  break;
                }
                case 'step_retrying': {
                  updates.status = 'pending';
                  if (eventData?.error !== undefined) {
                    updates.error = serializeError(eventData.error);
                  }
                  if (eventData?.retryAfter !== undefined) {
                    updates.retryAfter = new Date(eventData.retryAfter as string);
                  }
                  updates.attempt = (currentStep.attempt || 1) + 1;
                  break;
                }
              }

              const { eventId, eventRef, record } = allocateEvent();
              tx.set(eventRef, record);
              tx.update(stepRef, updates);
              advanceStateMarker(tx, eventId, marker);
              return record;
            });

            result = {
              event: EventSchema.parse(record),
              step: await getStep(effectiveRunId, correlationId),
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
            const hookData = eventData as { token: string; metadata?: unknown };
            if (!hookData.token) {
              debug('[hook_created] Missing token in eventData');
            }
            const hookRef = runRef.collection('hooks').doc(correlationId);
            const tokenRef = firestore.collection('hooks_by_token').doc(hookData.token);

            result = await firestore.runTransaction(async (tx) => {
              await readStateMarker(tx);
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
                  const { eventRef, record } = allocateEvent();
                  tx.set(eventRef, record);
                  return { event: EventSchema.parse(record), hook: hookFromDoc(existing) };
                }

                // Cross-hook / cross-run conflict: a different (runId, hookId)
                // holds this token. Record a hook_conflict event instead of
                // throwing.
                const { eventRef, record } = allocateEvent({
                  eventType: 'hook_conflict',
                  eventData: { token: hookData.token, conflictingRunId: existing.runId },
                });
                tx.set(eventRef, record);
                return { event: EventSchema.parse(record) };
              }

              const now = new Date();
              const { eventRef, record } = allocateEvent();
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
              };
              tx.set(eventRef, record);
              tx.set(hookRef, hookDoc);
              tx.set(tokenRef, hookDoc);

              return {
                event: EventSchema.parse(record),
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

            result = await firestore.runTransaction(async (tx) => {
              await readStateMarker(tx);
              const hookSnap = await tx.get(hookRef);
              if (!hookSnap.exists) {
                // Typed error: core's resume-or-start pattern matches this by
                // name via HookNotFoundError.is().
                throw new HookNotFoundError(correlationId);
              }
              const hookDoc = hookSnap.data() as FirebaseFirestore.DocumentData;

              const { eventRef, record } = allocateEvent();
              tx.set(eventRef, record);
              tx.delete(hookRef);
              if (typeof hookDoc.token === 'string' && hookDoc.token.length > 0) {
                tx.delete(firestore.collection('hooks_by_token').doc(hookDoc.token));
              }
              return { event: EventSchema.parse(record) };
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
            result = await firestore.runTransaction(async (tx) => {
              const marker = await readStateMarker(tx);
              // Hooks live in per-run subcollections; match postgres semantics
              // (global lookup by hookId) with a collection-group query.
              const hookQuery = await tx.get(
                firestore.collectionGroup('hooks').where('hookId', '==', correlationId).limit(1),
              );
              if (hookQuery.empty) {
                throw new HookNotFoundError(correlationId);
              }
              const { eventId, eventRef, record } = allocateEvent();
              tx.set(eventRef, record);
              advanceStateMarker(tx, eventId, marker);
              return { event: EventSchema.parse(record) };
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

            result = await firestore.runTransaction(async (tx) => {
              await readStateMarker(tx);
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
              const { eventRef, record } = allocateEvent();
              const waitDoc: Record<string, unknown> = {
                waitId,
                runId: effectiveRunId,
                status: 'waiting',
                resumeAt,
                specVersion: effectiveSpecVersion,
                createdAt: now,
                updatedAt: now,
              };
              tx.set(eventRef, record);
              tx.set(waitRef, waitDoc);

              return {
                event: EventSchema.parse(record),
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

            result = await firestore.runTransaction(async (tx) => {
              await readStateMarker(tx);
              const waitSnap = await tx.get(waitRef);
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
              const { eventRef, record } = allocateEvent();
              tx.set(eventRef, record);
              tx.update(waitRef, { status: 'completed', completedAt: now, updatedAt: now });

              return {
                event: EventSchema.parse(record),
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

          // hook_conflict (and any future event-only types): no entity
          // mutation, but still transactional so a create carrying a
          // `stateUpdatedAt` snapshot is guarded like every other type.
          default: {
            result = await firestore.runTransaction(async (tx) => {
              await readStateMarker(tx);
              const { eventRef, record } = allocateEvent();
              tx.set(eventRef, record);
              return { event: EventSchema.parse(record) };
            });
            break;
          }
        }

        // Preload all events for run_started to reduce TTFB
        if (data.eventType === 'run_started' && result.run && result.event) {
          const eventsSnapshot = await eventsCol.orderBy('eventId', 'asc').get();
          result.events = eventsSnapshot.docs.map((doc) => eventFromDoc(doc.data()));
          result.cursor = result.events.at(-1)?.eventId ?? null;
          result.hasMore = false;
        }

        // The runtime reads the per-run event ceiling from the run_started
        // response only, so it must also be present on the idempotent
        // already-running replay path (which returns no event).
        if (data.eventType === 'run_started' && result.run) {
          result.maxEvents = maxEventsPerRun;
        }

        return result;
      },

      async get(runId: string, eventId: string, _params?: GetEventParams): Promise<Event> {
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

        return eventFromDoc(doc.data() as FirebaseFirestore.DocumentData);
      },

      async list(params: ListEventsParams): Promise<PaginatedResponse<Event>> {
        const { runId } = params;
        const limit = params?.pagination?.limit ?? 100;
        const sortOrder = params.pagination?.sortOrder || 'asc';

        // Order and paginate by the monotonic eventId (ULID), never
        // createdAt, whose millisecond ties and out-of-commit-order writes
        // make cursors skip events.
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
          data: values.map((doc) => eventFromDoc(doc.data())),
          cursor: values.at(-1)?.id ?? null,
          hasMore,
        };
      },

      async listByCorrelationId(params) {
        const { correlationId } = params;
        const limit = params?.pagination?.limit ?? 100;
        const sortOrder = params.pagination?.sortOrder || 'asc';

        // Query across all runs for this correlationId, ordered and
        // paginated by the monotonic eventId (see events.list).
        let query: Query = firestore
          .collectionGroup('events')
          .where('correlationId', '==', correlationId)
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
          data: values.map((doc) => eventFromDoc(doc.data())),
          cursor: typeof lastEventId === 'string' ? lastEventId : null,
          hasMore,
        };
      },
    },

    steps: {
      async get(runId: string | undefined, stepId: string, params?: GetStepParams) {
        if (!runId) {
          throw new WorkflowWorldError('runId is required for Firestore step lookup', {
            status: 400,
          });
        }
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

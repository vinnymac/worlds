import {
  EntityConflictError,
  HookNotFoundError,
  RunExpiredError,
  RunNotSupportedError,
  TooEarlyError,
  WorkflowRunNotFoundError,
  WorkflowWorldError,
} from '@workflow/errors';
import type {
  AnyEventRequest,
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
  EventsResolveData,
  RunCreatedEventRequest,
  SpecVersion,
  Step,
  StepWithoutData,
  Storage,
  Wait,
  WorkflowRun,
  WorkflowRunWithoutData,
} from '@workflow/world';
import {
  applyAttributeChanges,
  entityResolveData,
  EventSchema,
  eventIdToSlot,
  HookSchema,
  isChildEntityCreationEvent,
  isLegacySpecVersion,
  requiresNewerWorld,
  SPEC_VERSION_CURRENT,
  SPEC_VERSION_SUPPORTS_SLOT_IDENTITY,
  slotToEventId,
  StepSchema,
  stripEventDataRefs,
  validateAttributeChanges,
  WaitSchema,
  WorkflowRunSchema,
} from '@workflow/world';
import type { JetStreamClient } from '@nats-io/jetstream';
import type { KV, KvEntry } from '@nats-io/kv';
import { Kvm } from '@nats-io/kv';
import { monotonicFactory } from 'ulid';
import { parse, stringify } from '@fantasticfour/shared';
import { compact, debug } from './util.js';

interface NatsStorageConfig {
  getJetStream: () => Promise<JetStreamClient>;
  keyPrefix: string;
  /** The spec version the World declares; stamped on runs created without one. */
  specVersion?: SpecVersion;
  terminalRunTTLMs?: number;
  maxEventsPerRun?: number;
}

/** Default TTL for terminal runs: 30 days. */
const DEFAULT_TERMINAL_RUN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Default per-run event ceiling; mirrors the Vercel World. */
const DEFAULT_MAX_EVENTS_PER_RUN = 25_000;

/** Resolve the per-run event ceiling reported on `run_started`: explicit
 * config, then `WORKFLOW_MAX_EVENTS`, then the default. A nonsensical
 * configured value throws rather than leaving runs unbounded. */
function resolveMaxEventsPerRun(configured?: number): number {
  if (configured !== undefined) {
    if (!Number.isInteger(configured) || configured <= 0) {
      throw new Error(`maxEventsPerRun must be a positive integer, received ${configured}`);
    }
    return configured;
  }
  const raw = process.env.WORKFLOW_MAX_EVENTS;
  if (raw === undefined || raw === '') return DEFAULT_MAX_EVENTS_PER_RUN;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`WORKFLOW_MAX_EVENTS must be a positive integer, received "${raw}"`);
  }
  return parsed;
}

/**
 * Convert KV entry value to string (handles both string and Uint8Array)
 */
function kvValueToString(value: string | Uint8Array): string {
  if (typeof value === 'string') return value;
  return new TextDecoder().decode(value);
}

/**
 * Get a KV entry, treating delete/purge tombstones as absent.
 *
 * NATS KV `get()` returns the latest entry for a key even when that entry
 * is a DEL/PURGE marker, so a plain truthiness check would treat deleted
 * keys as live and then crash parsing the empty tombstone value.
 */
async function getLiveEntry(bucket: KV, key: string): Promise<KvEntry | null> {
  const entry = await bucket.get(key);
  if (!entry || entry.operation !== 'PUT') return null;
  return entry;
}

/**
 * Iterate the live (latest, non-deleted) entries of a bucket.
 *
 * Unlike `history()`, which yields every retained revision of every key
 * (duplicating entities once per update and resurrecting deleted entities
 * via their older PUT revisions), this yields exactly one entry per live key.
 */
async function* listLiveEntries(bucket: KV): AsyncGenerator<KvEntry> {
  // Drain the key listing before issuing any other KV requests: the keys()
  // iterator is backed by a push subscription that drops buffered keys when
  // the consumer awaits unrelated work between reads.
  const keys: string[] = [];
  const iter = await bucket.keys();
  for await (const key of iter) {
    keys.push(key);
  }
  for (const key of keys) {
    const entry = await getLiveEntry(bucket, key);
    if (entry) yield entry;
  }
}

/** Max attempts for revision-checked (CAS) update loops. */
const MAX_CAS_ATTEMPTS = 10;

/** True when a KV update failed because the revision precondition was violated. */
function isWrongLastSequence(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const apiError = (err as Error & { api_error?: { err_code?: number } }).api_error;
  return apiError?.err_code === 10071 || err.message.includes('wrong last sequence');
}

type CasResult =
  | { type: 'updated'; value: object }
  | { type: 'unchanged'; value: object }
  | { type: 'missing' };

/**
 * Revision-checked read-modify-write (compare-and-swap).
 *
 * `mutate` receives the current live value and either returns the next value
 * (`write: true`), signals that no write is needed (`write: false`), or
 * throws a domain error. Losing a CAS race re-reads and re-validates, so
 * terminal-state guards inside `mutate` hold under concurrent writers.
 *
 * The returned value is intentionally loosely typed (`object`): callers
 * re-validate through the relevant zod schema before use.
 */
async function casMutate<T>(
  bucket: KV,
  key: string,
  mutate: (existing: T) => { write: boolean; value: object },
): Promise<CasResult> {
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
    const entry = await getLiveEntry(bucket, key);
    if (!entry) return { type: 'missing' };
    const existing = parse<T>(kvValueToString(entry.value));
    const result = mutate(existing);
    if (!result.write) return { type: 'unchanged', value: result.value };
    try {
      await bucket.update(key, stringify(result.value), entry.revision);
      return { type: 'updated', value: result.value };
    } catch (err) {
      if (!isWrongLastSequence(err)) throw err;
      // Lost the race: re-read and re-validate.
    }
  }
  throw new WorkflowWorldError(
    `Concurrent update on "${key}" did not settle after ${MAX_CAS_ATTEMPTS} attempts`,
    { status: 409 },
  );
}

/** Compare two ULID-suffixed IDs (e.g. eventId, runId) lexicographically. */
function compareIds(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
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

function filterStepData(step: Step, resolveData: 'none'): StepWithoutData;
function filterStepData(step: Step, resolveData: 'all'): Step;
function filterStepData(step: Step, resolveData: ResolveData): Step | StepWithoutData;
function filterStepData(step: Step, resolveData: ResolveData): Step | StepWithoutData {
  if (resolveData === 'none') {
    const { input: _, output: __, ...rest } = step;
    return { input: undefined, output: undefined, ...rest };
  }
  return step;
}

function filterRunData(run: WorkflowRun, resolveData: 'none'): WorkflowRunWithoutData;
function filterRunData(run: WorkflowRun, resolveData: 'all'): WorkflowRun;
function filterRunData(
  run: WorkflowRun,
  resolveData: ResolveData,
): WorkflowRun | WorkflowRunWithoutData;
function filterRunData(
  run: WorkflowRun,
  resolveData: ResolveData,
): WorkflowRun | WorkflowRunWithoutData {
  if (resolveData === 'none') {
    const { input: _, output: __, ...rest } = run;
    return { input: undefined, output: undefined, ...rest };
  }
  return run;
}

// ---------------------------------------------------------------------------
// Secondary index helpers
// ---------------------------------------------------------------------------

/**
 * Collect all keys currently stored in a KV bucket that match a given prefix
 * (which must end with the `.` key separator). Returns the key suffixes.
 *
 * The prefix is pushed down as a server-side subject filter; an empty bucket
 * or a prefix with no matches yields an empty list. Infrastructure failures
 * (connection loss, etc.) propagate; swallowing them here would silently
 * turn index lookups into empty results.
 */
async function collectIndexKeys(bucket: KV, prefix: string): Promise<string[]> {
  const results: string[] = [];
  const keys = await bucket.keys(`${prefix}>`);
  for await (const key of keys) {
    if (key.startsWith(prefix)) {
      results.push(key.slice(prefix.length));
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Runs storage
// ---------------------------------------------------------------------------

/**
 * Create storage for workflow runs using JetStream KV Store.
 *
 * Uses a secondary index bucket (`<prefix>runs_by_status`) so that
 * `runs.list({ status })` no longer requires a full bucket scan.
 */
export function createRunsStorage(config: NatsStorageConfig): Storage['runs'] {
  const { getJetStream, keyPrefix } = config;
  let runsBucket: KV;
  let runsByStatusBucket: KV;

  let bucketsReady: Promise<void> | undefined;
  // Memoized: concurrent first calls share one open, so none of them proceeds
  // while a later bucket is still unassigned.
  const initBuckets = (): Promise<void> =>
    (bucketsReady ??= openBuckets().catch((err: unknown) => {
      bucketsReady = undefined;
      throw err;
    }));
  const openBuckets = async () => {
    if (!runsBucket) {
      const jetstream = await getJetStream();
      runsBucket = await new Kvm(jetstream).create(`${keyPrefix}runs`, {
        history: 10,
      });
      runsByStatusBucket = await new Kvm(jetstream).create(`${keyPrefix}runs_by_status`, {
        history: 1,
      });
    }
  };

  return {
    get: (async (id: string, params?: GetWorkflowRunParams) => {
      await initBuckets();
      const entry = await getLiveEntry(runsBucket, id);
      if (!entry) {
        // Core matches this by name (WorkflowRunNotFoundError.is) to drive
        // run.exists() and pollReturnValue's not-found retry tolerance.
        throw new WorkflowRunNotFoundError(id);
      }
      const data = kvValueToString(entry.value);
      const run = parse<WorkflowRun>(data);
      const parsed = WorkflowRunSchema.parse(compact(run));
      const resolveData = params?.resolveData ?? 'all';
      return filterRunData(parsed, resolveData);
    }) as Storage['runs']['get'],

    list: (async (params?: ListWorkflowRunsParams) => {
      await initBuckets();
      const limit = params?.pagination?.limit ?? 20;
      const resolveData = params?.resolveData ?? 'all';

      let candidateRunIds: string[] | null = null;

      // If filtering by status, use the secondary index for a fast lookup.
      // An array matches a run in any of the listed statuses; an empty array
      // matches nothing, like SQL `IN ()`.
      if (params?.status !== undefined) {
        const statuses = Array.isArray(params.status) ? params.status : [params.status];
        const ids = new Set<string>();
        for (const status of statuses) {
          for (const runId of await collectIndexKeys(runsByStatusBucket, `${status}.`)) {
            ids.add(runId);
          }
        }
        candidateRunIds = [...ids];
      }

      const runs: (WorkflowRun | WorkflowRunWithoutData)[] = [];

      if (candidateRunIds !== null) {
        // Fetch each run by primary key
        for (const runId of candidateRunIds) {
          try {
            const entry = await getLiveEntry(runsBucket, runId);
            if (!entry) continue;

            const data = kvValueToString(entry.value);
            const run = parse<WorkflowRun>(data);

            const nameMatches = !params?.workflowName || run.workflowName === params.workflowName;
            if (nameMatches) {
              const parsed = WorkflowRunSchema.parse(compact(run));
              runs.push(filterRunData(parsed, resolveData));
            }
          } catch {
            // Run may have been deleted between index read and primary fetch
            debug(`Stale index entry for run ${runId}, skipping`);
          }
        }
      } else {
        // No status filter: fall back to a scan of live entries
        for await (const entry of listLiveEntries(runsBucket)) {
          const data = kvValueToString(entry.value);
          const run: WorkflowRun = parse<WorkflowRun>(data);

          const nameMatches = !params?.workflowName || run.workflowName === params.workflowName;

          if (nameMatches) {
            const parsed = WorkflowRunSchema.parse(compact(run));
            runs.push(filterRunData(parsed, resolveData));
          }
        }
      }

      // Sort by runId descending (monotonic ULIDs; matches world-postgres)
      runs.sort((a, b) => compareIds(b.runId, a.runId));

      // Apply cursor-based pagination
      let startIdx = 0;
      if (params?.pagination?.cursor) {
        const cursorIdx = runs.findIndex((r) => r.runId === params.pagination!.cursor);
        if (cursorIdx !== -1) {
          startIdx = cursorIdx + 1;
        }
      }

      const values = runs.slice(startIdx, startIdx + limit);
      const hasMore = startIdx + limit < runs.length;

      return {
        data: values,
        hasMore,
        cursor: values.at(-1)?.runId ?? null,
      };
    }) as Storage['runs']['list'],
  };
}

// ---------------------------------------------------------------------------
// Events storage
// ---------------------------------------------------------------------------

/**
 * Create storage for workflow events using JetStream KV Store
 */
export function createEventsStorage(config: NatsStorageConfig): Storage['events'] {
  const { getJetStream, keyPrefix, maxEventsPerRun } = config;
  const worldSpecVersion = config.specVersion ?? SPEC_VERSION_CURRENT;
  const ulid = monotonicFactory();

  let eventsBucket: KV;
  let runsBucket: KV;
  let stepsBucket: KV;
  let hooksBucket: KV;
  let hooksTokenBucket: KV;
  let waitsBucket: KV;
  // Secondary index buckets
  let runsByStatusBucket: KV;
  let stepsByRunBucket: KV;
  let hooksByRunBucket: KV;
  let eventsByRunBucket: KV;
  let runEventsBucket: KV;
  let eventHeadsBucket: KV;
  let creationClaimsBucket: KV;

  let bucketsReady: Promise<void> | undefined;
  // Memoized: concurrent first calls share one open, so none of them proceeds
  // while a later bucket is still unassigned.
  const initBuckets = (): Promise<void> =>
    (bucketsReady ??= openBuckets().catch((err: unknown) => {
      bucketsReady = undefined;
      throw err;
    }));
  const openBuckets = async () => {
    if (!eventsBucket) {
      const jetstream = await getJetStream();
      eventsBucket = await new Kvm(jetstream).create(`${keyPrefix}events`, {
        history: 10,
      });
      runsBucket = await new Kvm(jetstream).create(`${keyPrefix}runs`, {
        history: 10,
      });
      stepsBucket = await new Kvm(jetstream).create(`${keyPrefix}steps`, {
        history: 10,
      });
      hooksBucket = await new Kvm(jetstream).create(`${keyPrefix}hooks`, {
        history: 10,
      });
      hooksTokenBucket = await new Kvm(jetstream).create(`${keyPrefix}hooks_by_token`, {
        history: 1,
      });
      waitsBucket = await new Kvm(jetstream).create(`${keyPrefix}waits`, {
        history: 1,
      });
      // Secondary indexes
      runsByStatusBucket = await new Kvm(jetstream).create(`${keyPrefix}runs_by_status`, {
        history: 1,
      });
      stepsByRunBucket = await new Kvm(jetstream).create(`${keyPrefix}steps_by_run`, {
        history: 1,
      });
      hooksByRunBucket = await new Kvm(jetstream).create(`${keyPrefix}hooks_by_run`, {
        history: 1,
      });
      eventsByRunBucket = await new Kvm(jetstream).create(`${keyPrefix}events_by_run`, {
        history: 1,
      });
      // The run's event log: key `<runId>.<eventId>`, where the event id is
      // the event's slot (`slotToEventId`). An event is committed by an
      // atomic create() of its slot key, so the create is both the slot
      // claim and the write; a loser moves to the next slot.
      runEventsBucket = await new Kvm(jetstream).create(`${keyPrefix}run_events`, {
        history: 1,
      });
      // Advisory per-run head: the highest slot known committed. Appends
      // start probing just above it; it never runs ahead of the log, so
      // probing forward from it always finds the first free slot.
      eventHeadsBucket = await new Kvm(jetstream).create(`${keyPrefix}event_heads`, {
        history: 1,
      });
      // Exactly-once arbiter for entity-creating events: one creation event
      // per (runId, correlationId, eventType). The NATS equivalent of
      // world-postgres's `workflow_events_entity_creation_unique` index. The
      // steps/hooks sub-storages below never write creation events, so only
      // the events storage (and compaction) opens this bucket.
      creationClaimsBucket = await new Kvm(jetstream).create(`${keyPrefix}creation_claims`, {
        history: 1,
      });
    }
  };

  // ------------------------------------------------------------------
  // Index maintenance helpers
  // ------------------------------------------------------------------

  /** Write a run into the status index. */
  async function indexRunStatus(runId: string, status: string): Promise<void> {
    await runsByStatusBucket.put(`${status}.${runId}`, runId);
  }

  /** Move a run from one status to another in the index. */
  async function reindexRunStatus(
    runId: string,
    oldStatus: string | undefined,
    newStatus: string,
  ): Promise<void> {
    if (oldStatus && oldStatus !== newStatus) {
      try {
        await runsByStatusBucket.delete(`${oldStatus}.${runId}`);
      } catch {
        // Key may not exist (e.g. backfill hasn't run)
      }
    }
    await indexRunStatus(runId, newStatus);
  }

  /** Index a step under its run. */
  async function indexStep(runId: string, stepId: string): Promise<void> {
    await stepsByRunBucket.put(`${runId}.${stepId}`, stepId);
  }

  /** Index a hook under its run. */
  async function indexHook(runId: string, hookId: string): Promise<void> {
    await hooksByRunBucket.put(`${runId}.${hookId}`, hookId);
  }

  /** Remove a hook from the run index. */
  async function removeHookIndex(runId: string, hookId: string): Promise<void> {
    try {
      await hooksByRunBucket.delete(`${runId}.${hookId}`);
    } catch {
      // May not exist
    }
  }

  // ------------------------------------------------------------------
  // Event log: slot allocation
  // ------------------------------------------------------------------

  /** Key of an event in {@link runEventsBucket}. */
  const runEventKey = (runId: string, eventId: string) => `${runId}.${eventId}`;

  /** Advisory head for a run: a slot at or below the last committed one. */
  async function readHead(runId: string): Promise<number> {
    const entry = await getLiveEntry(eventHeadsBucket, runId);
    if (!entry) return 0;
    const head = Number(kvValueToString(entry.value));
    return Number.isInteger(head) && head > 0 ? head : 0;
  }

  /** Raise the advisory head to `slot`, never lowering it. Best effort: a
   * lagging head only costs the next append a few extra probes. */
  async function raiseHead(runId: string, slot: number): Promise<void> {
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
      const entry = await getLiveEntry(eventHeadsBucket, runId);
      try {
        if (!entry) {
          await eventHeadsBucket.create(runId, `${slot}`);
          return;
        }
        if (Number(kvValueToString(entry.value)) >= slot) return;
        await eventHeadsBucket.update(runId, `${slot}`, entry.revision);
        return;
      } catch (err) {
        if (!isWrongLastSequence(err)) throw err;
      }
    }
  }

  /** Max slots one append probes before giving up. A writer only loses a
   * slot to another writer's committed event, so this bounds contention,
   * not log length. */
  const MAX_APPEND_PROBES = 1000;

  /**
   * Append `event` to its run's log at the first free slot and return it with
   * its event id. The slot is claimed by an atomic create() of the event's
   * own key, so the claim and the write are one operation: no slot is handed
   * out without its event, and a writer that loses a slot retries against
   * the store at the next one. Probing starts just above the advisory head,
   * which never exceeds the committed log, so the first free slot found is
   * the first free slot of the run and the log stays dense from 1.
   */
  async function appendEvent<T extends { runId: string }>(
    event: T,
  ): Promise<T & { eventId: string }> {
    let slot = (await readHead(event.runId)) + 1;
    for (let probe = 0; probe < MAX_APPEND_PROBES; probe++, slot++) {
      const eventId = slotToEventId(slot);
      const committed = { ...event, eventId };
      try {
        await runEventsBucket.create(runEventKey(event.runId, eventId), stringify(committed));
      } catch (err) {
        if (isWrongLastSequence(err)) continue;
        throw err;
      }
      await raiseHead(event.runId, slot);
      return committed;
    }
    throw new WorkflowWorldError(
      `Could not allocate an event slot for run "${event.runId}" after ${MAX_APPEND_PROBES} probes`,
      { status: 409 },
    );
  }

  /** Read the events at `fromSlot..toSlot` (inclusive). Every slot below a
   * committed one is committed, so these are all present. */
  async function readSlots(runId: string, fromSlot: number, toSlot: number): Promise<Event[]> {
    const entries = await Promise.all(
      Array.from({ length: Math.max(0, toSlot - fromSlot + 1) }, (_, i) =>
        getLiveEntry(runEventsBucket, runEventKey(runId, slotToEventId(fromSlot + i))),
      ),
    );
    return entries.flatMap((entry) => (entry ? [parse<Event>(kvValueToString(entry.value))] : []));
  }

  /**
   * The report half of bump-and-report: the events on the slots between the
   * one the writer expected (`eventCount + 1`) and the one its write landed
   * on. Undefined when the write took the slot it asked for, or the caller
   * sent no count.
   */
  async function reportSkippedSlots(
    runId: string,
    committedEventId: string,
    eventCount: number | undefined,
    resolveData: EventsResolveData,
  ): Promise<Pick<EventResult, 'events' | 'cursor' | 'hasMore'> | undefined> {
    const committedSlot = eventIdToSlot(committedEventId);
    if (eventCount === undefined || committedSlot === null || committedSlot <= eventCount + 1) {
      return undefined;
    }
    const skipped = await readSlots(runId, Math.max(eventCount, 0) + 1, committedSlot - 1);
    if (skipped.length === 0) return undefined;
    return {
      events: skipped.map((e) => stripEventDataRefs(EventSchema.parse(compact(e)), resolveData)),
      cursor: skipped.at(-1)!.eventId,
      hasMore: false,
    };
  }

  /** Value a creation claim holds while its winner is appending the event. */
  const CREATION_CLAIM_PENDING = 'pending';
  /** Age after which a pending creation claim is treated as abandoned by a
   * crashed winner and may be taken over. */
  const CREATION_CLAIM_STALE_MS = 30_000;

  /**
   * Arbitrate which delivery appends the creation event for an entity, so a
   * redelivered or concurrent creation never appends it twice.
   *
   * `creationClaimsBucket.create()` is atomic, so exactly one delivery claims
   * (runId, correlationId, eventType) and appends; the claim then records the
   * committed event id. Every other delivery gets EntityConflictError, the
   * runtime's duplicate signal. A claim left pending longer than
   * {@link CREATION_CLAIM_STALE_MS} belongs to a winner that crashed between
   * creating the entity and appending its event; the next delivery takes it
   * over with a revision-checked update and appends instead.
   *
   * `entityExisted` marks deliveries that lost the entity create: those may
   * hit entities predating the claims bucket, so the event log is probed for
   * the creation event before appending one.
   *
   * Returns the function that records the committed event id on the claim.
   */
  async function claimCreationAppend(
    runId: string,
    correlationId: string,
    eventType: Event['eventType'],
    entityExisted: boolean,
    conflictMessage: string,
  ): Promise<(eventId: string) => Promise<void>> {
    const claimKey = `${runId}.${correlationId}.${eventType}`;
    const record = async (eventId: string) => {
      await creationClaimsBucket.put(claimKey, eventId);
    };
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
      const claimed = await creationClaimsBucket
        .create(claimKey, CREATION_CLAIM_PENDING)
        .then(() => true)
        .catch((err) => {
          if (isWrongLastSequence(err)) return false;
          throw err;
        });
      if (claimed) {
        if (entityExisted) {
          const existingEvent = (await loadEventsForRun(runId)).find(
            (e) => e.eventType === eventType && e.correlationId === correlationId,
          );
          if (existingEvent) {
            await record(existingEvent.eventId);
            throw new EntityConflictError(conflictMessage);
          }
        }
        return record;
      }
      const entry = await getLiveEntry(creationClaimsBucket, claimKey);
      if (!entry) continue; // Deleted between create() and get(): retry.
      if (kvValueToString(entry.value) !== CREATION_CLAIM_PENDING) {
        throw new EntityConflictError(conflictMessage);
      }
      if (Date.now() - entry.created.getTime() < CREATION_CLAIM_STALE_MS) {
        // The winner is still appending; it will commit the event.
        throw new EntityConflictError(conflictMessage);
      }
      try {
        await creationClaimsBucket.update(claimKey, CREATION_CLAIM_PENDING, entry.revision);
        return record;
      } catch (err) {
        if (!isWrongLastSequence(err)) throw err;
      }
    }
    throw new EntityConflictError(conflictMessage);
  }

  /** Every event of a run, in slot order. Runs created before slot-numbered
   * event ids keep their ULID log in the legacy buckets and are read from
   * there. */
  async function loadEventsForRun(runId: string): Promise<Event[]> {
    const slotKeys = await collectIndexKeys(runEventsBucket, `${runId}.`);
    if (slotKeys.length > 0) {
      const head = Math.max(...slotKeys.map((id) => eventIdToSlot(id) ?? 0));
      return readSlots(runId, 1, head);
    }
    return loadLegacyEventsForRun(runId);
  }

  /** Events of a run created before slot-numbered ids, sorted by ULID. */
  async function loadLegacyEventsForRun(runId: string): Promise<Event[]> {
    const events: Event[] = [];
    const eventIds = await collectIndexKeys(eventsByRunBucket, `${runId}.`);
    const entries = await Promise.all(
      eventIds.map((eventId) => getLiveEntry(eventsBucket, eventId)),
    );
    for (const entry of entries) {
      if (!entry) continue;
      events.push(parse<Event>(kvValueToString(entry.value)));
    }
    events.sort((a, b) => compareIds(a.eventId, b.eventId));
    return events;
  }

  // Helper: Clean up hooks when run reaches terminal status
  async function cleanupHooks(runId: string): Promise<void> {
    await initBuckets();

    // Try index-based lookup first
    const hookIds = await collectIndexKeys(hooksByRunBucket, `${runId}.`);

    if (hookIds.length > 0) {
      for (const hookId of hookIds) {
        try {
          const hookEntry = await getLiveEntry(hooksBucket, hookId);
          if (hookEntry) {
            const hookData = kvValueToString(hookEntry.value);
            const hook = parse<Hook>(hookData);
            await hooksBucket.delete(hook.hookId);
            await hooksTokenBucket.delete(hook.token);
          }
          await removeHookIndex(runId, hookId);
        } catch {
          debug(`Failed to clean up hook ${hookId} for run ${runId}`);
        }
      }
    } else {
      // Fallback: full scan (handles data created before indexes existed)
      for await (const entry of listLiveEntries(hooksBucket)) {
        const data = kvValueToString(entry.value);
        const hook = parse<Hook>(data);

        if (hook.runId === runId) {
          await hooksBucket.delete(hook.hookId);
          await hooksTokenBucket.delete(hook.token);
        }
      }
    }
  }

  // Helper: Clean up wait entities when run reaches terminal status
  async function cleanupWaits(runId: string): Promise<void> {
    await initBuckets();
    const correlationIds = await collectIndexKeys(waitsBucket, `${runId}.`);
    for (const correlationId of correlationIds) {
      try {
        await waitsBucket.delete(`${runId}.${correlationId}`);
      } catch {
        debug(`Failed to clean up wait ${correlationId} for run ${runId}`);
      }
    }
  }

  /**
   * Handle events for legacy runs (pre-event-sourcing, specVersion < 2).
   */
  async function handleLegacyEvent(
    runId: string,
    data: CreateEventRequest | RunCreatedEventRequest,
    currentRun: { status: string; specVersion?: number },
    params?: { resolveData?: EventsResolveData },
  ): Promise<EventResult> {
    await initBuckets();
    const resolveData = params?.resolveData ?? 'all';
    const entityData = entityResolveData(resolveData);

    switch (data.eventType) {
      case 'run_cancelled': {
        const entry = await getLiveEntry(runsBucket, runId);
        if (entry) {
          const existingData = kvValueToString(entry.value);
          const existing = parse<WorkflowRun>(existingData);
          const now = new Date();
          const updatedRun = {
            ...existing,
            status: 'cancelled' as const,
            completedAt: now,
            updatedAt: now,
          };
          await runsBucket.put(runId, stringify(updatedRun));
          await reindexRunStatus(runId, currentRun.status, 'cancelled');
          await cleanupHooks(runId);

          const parsed = WorkflowRunSchema.parse(compact(updatedRun));
          return {
            run: filterRunData(parsed, entityData) as WorkflowRun,
          };
        }
        return {};
      }

      case 'wait_completed':
      case 'hook_received': {
        // Pre-event-sourcing runs keep a ULID log in the legacy buckets.
        const eventId = `wevt_${ulid()}`;
        const createdAt = new Date();
        const event: Event = {
          ...data,
          runId,
          eventId,
          createdAt,
          specVersion: SPEC_VERSION_CURRENT,
        };

        await eventsBucket.put(eventId, stringify(event));
        await eventsByRunBucket.put(`${runId}.${eventId}`, eventId);
        const parsed = EventSchema.parse(event);
        return { event: stripEventDataRefs(parsed, resolveData) };
      }

      default:
        throw new Error(
          `Event type '${data.eventType}' not supported for legacy runs ` +
            `(specVersion: ${currentRun.specVersion || 'undefined'}). ` +
            `Please upgrade @workflow packages.`,
        );
    }
  }

  return {
    async create(
      runId: string | null,
      data: AnyEventRequest,
      params?: CreateEventParams,
    ): Promise<EventResult> {
      await initBuckets();

      const now = new Date();
      const resolveData = params?.resolveData ?? 'all';
      // Set by an entity creation that won its creation claim: records the
      // committed event id on the claim once the event is appended.
      let recordCreation: ((eventId: string) => Promise<void>) | undefined;
      // Lazy step start: a step_started carrying step-creation data (stepName
      // + input) may arrive with no prior step_created, and creates the step.
      const lazyStepStart = data.eventType === 'step_started' && isChildEntityCreationEvent(data);
      let stepCreated = false;

      // For run_created events, generate runId server-side if null or empty
      let effectiveRunId: string;
      if (data.eventType === 'run_created' && (!runId || runId === '')) {
        effectiveRunId = `wrun_${ulid()}`;
      } else if (!runId) {
        throw new Error('runId is required for non-run_created events');
      } else {
        effectiveRunId = runId;
      }

      const effectiveSpecVersion = data.specVersion ?? worldSpecVersion;

      let run: WorkflowRun | undefined;
      let step: Step | undefined;
      let hook: Hook | undefined;
      let wait: Wait | undefined;

      const isRunTerminal = (status: string) =>
        ['completed', 'failed', 'cancelled'].includes(status);

      const isStepTerminal = (status: string) =>
        ['completed', 'failed', 'cancelled'].includes(status);

      // Validation
      let currentRun: {
        status: string;
        specVersion?: number;
      } | null = null;

      const skipRunValidationEvents = ['step_completed', 'step_retrying'];
      if (data.eventType !== 'run_created' && !skipRunValidationEvents.includes(data.eventType)) {
        const runEntry = await getLiveEntry(runsBucket, effectiveRunId);
        if (runEntry) {
          const runData = kvValueToString(runEntry.value);
          const parsed = parse<WorkflowRun>(runData);
          currentRun = {
            status: parsed.status,
            specVersion: parsed.specVersion,
          };
        }
      }

      // ============================================================
      // RESILIENT START: Bootstrap run from run_started eventData
      // ============================================================
      if (
        data.eventType === 'run_started' &&
        !currentRun &&
        'eventData' in data &&
        data.eventData
      ) {
        const runInputData = data.eventData as {
          deploymentId?: string;
          workflowName?: string;
          input?: unknown;
          executionContext?: Record<string, unknown>;
          attributes?: Record<string, string>;
        };
        if (
          runInputData.deploymentId &&
          runInputData.workflowName &&
          runInputData.input !== undefined
        ) {
          const newRun = {
            runId: effectiveRunId,
            deploymentId: runInputData.deploymentId,
            workflowName: runInputData.workflowName,
            specVersion: effectiveSpecVersion,
            input: runInputData.input,
            executionContext: runInputData.executionContext,
            attributes: runInputData.attributes ?? {},
            status: 'pending' as const,
            output: undefined,
            error: undefined,
            completedAt: undefined,
            startedAt: undefined,
            createdAt: now,
            updatedAt: now,
          };
          // Atomically create the run so only the first writer wins. This
          // prevents a TOCTOU race where a concurrent run_created from
          // start() (which runs in parallel with the queue publish) could
          // overwrite a run that was already transitioned to 'running'.
          const created = await runsBucket
            .create(effectiveRunId, stringify(newRun))
            .then(() => true)
            .catch(() => false);
          if (created) {
            await indexRunStatus(effectiveRunId, 'pending');
            // Synthetic run_created event, appended before the run_started
            // that bootstrapped it so the log keeps the creation event first.
            await appendEvent({
              eventType: 'run_created' as const,
              eventData: {
                deploymentId: runInputData.deploymentId,
                workflowName: runInputData.workflowName,
                input: runInputData.input,
                executionContext: runInputData.executionContext,
                ...(runInputData.attributes ? { attributes: runInputData.attributes } : {}),
              },
              runId: effectiveRunId,
              createdAt: now,
              specVersion: effectiveSpecVersion,
            });
            currentRun = { status: 'pending', specVersion: effectiveSpecVersion };
          } else {
            // Run already exists (concurrent run_created won the race):
            // re-read so downstream logic sees the real state.
            const existing = await getLiveEntry(runsBucket, effectiveRunId);
            if (existing) {
              const existingData = kvValueToString(existing.value);
              const parsed = parse<WorkflowRun>(existingData);
              currentRun = { status: parsed.status, specVersion: parsed.specVersion };
            }
          }
        }
      }

      // Version compatibility
      if (currentRun) {
        if (requiresNewerWorld(currentRun.specVersion)) {
          throw new RunNotSupportedError(currentRun.specVersion!, worldSpecVersion);
        }

        if (isLegacySpecVersion(currentRun.specVersion)) {
          return handleLegacyEvent(effectiveRunId, data, currentRun, params);
        }

        // A run created before slot-numbered event ids keeps its ULID log,
        // which this World cannot append to. It stays readable, and
        // cancellable without an event; anything else is refused.
        if ((currentRun.specVersion ?? 0) < SPEC_VERSION_SUPPORTS_SLOT_IDENTITY) {
          if (data.eventType === 'run_cancelled') {
            return handleLegacyEvent(effectiveRunId, data, currentRun, params);
          }
          throw new WorkflowWorldError(
            `Workflow run "${effectiveRunId}" was created at spec version ` +
              `${currentRun.specVersion ?? 'unknown'}, before slot-numbered event ids, and ` +
              `cannot be extended by this World. Finish it on a 4.x deployment.`,
            { status: 409 },
          );
        }
      }

      // Run terminal state validation
      if (currentRun && isRunTerminal(currentRun.status)) {
        const runTerminalEvents = ['run_started', 'run_completed', 'run_failed'];

        // Idempotent operation
        if (data.eventType === 'run_cancelled' && currentRun.status === 'cancelled') {
          const fullRunEntry = await getLiveEntry(runsBucket, effectiveRunId);
          const event = await appendEvent({
            ...data,
            runId: effectiveRunId,
            createdAt: new Date(),
            specVersion: effectiveSpecVersion,
          });

          const parsed = EventSchema.parse(event);
          return {
            event: stripEventDataRefs(parsed, resolveData),
            run: fullRunEntry
              ? (parse<WorkflowRun>(kvValueToString(fullRunEntry.value)) as WorkflowRun)
              : undefined,
          };
        }

        // For run_started on terminal runs, use RunExpiredError so the
        // runtime knows to exit without retrying.
        if (data.eventType === 'run_started') {
          throw new RunExpiredError(
            `Workflow run "${effectiveRunId}" is already in terminal state "${currentRun.status}"`,
          );
        }

        // Other run state transitions are not allowed on terminal runs
        if (runTerminalEvents.includes(data.eventType) || data.eventType === 'run_cancelled') {
          throw new EntityConflictError(
            `Cannot transition run from terminal state "${currentRun.status}"`,
          );
        }

        // Creating new entities on terminal runs is not allowed. A lazy
        // step_started is a creation too, but a step_started on a terminal
        // run is refused with RunExpiredError below.
        if (
          data.eventType === 'step_created' ||
          data.eventType === 'hook_created' ||
          data.eventType === 'wait_created'
        ) {
          throw new EntityConflictError(
            `Cannot create new entities on run in terminal state "${currentRun.status}"`,
          );
        }

        if (data.eventType === 'attr_set') {
          throw new EntityConflictError(
            `Cannot set attributes on run in terminal state "${currentRun.status}"`,
          );
        }

        // A step_started on a terminal run is refused even while the step
        // reads running: it is a redelivery of a start an earlier delivery
        // already claimed, and nothing will read its outcome.
        if (data.eventType === 'step_started') {
          throw new RunExpiredError(
            `Cannot start a step on run in terminal state "${currentRun.status}"`,
          );
        }
      }

      // Step validation. The CAS mutators below re-run these guards against
      // the freshest revision; this pre-check exists to fail fast (and to
      // reject events for steps that don't exist at all).
      let validatedStep: { status: string } | null = null;
      const stepEventsNeedingValidation = ['step_started', 'step_retrying'];
      if (stepEventsNeedingValidation.includes(data.eventType) && data.correlationId) {
        const stepKey = `${effectiveRunId}.${data.correlationId}`;
        const stepEntry = await getLiveEntry(stepsBucket, stepKey);
        if (stepEntry) {
          const stepData = kvValueToString(stepEntry.value);
          const parsed = parse<Step>(stepData);
          validatedStep = { status: parsed.status };
        }

        if (!validatedStep && !lazyStepStart) {
          throw new WorkflowWorldError(`Step "${data.correlationId}" not found`, { status: 404 });
        }

        // A lazy start that finds the step already created lost the
        // create-claim: the runtime treats this as "skipped".
        if (lazyStepStart && validatedStep) {
          throw new EntityConflictError(`Step "${data.correlationId}" already exists`);
        }

        // Core catches EntityConflictError by name to gracefully skip an
        // already-terminal step and re-enqueue the workflow.
        if (validatedStep && isStepTerminal(validatedStep.status)) {
          throw new EntityConflictError(
            `Cannot modify step in terminal state "${validatedStep.status}"`,
          );
        }

        if (validatedStep && currentRun && isRunTerminal(currentRun.status)) {
          throw new RunExpiredError(
            `Cannot modify step on run in terminal state "${currentRun.status}"`,
          );
        }
      }

      // Hook validation. Core treats HookNotFoundError as a benign
      // "already disposed" signal during suspension replay.
      const hookEventsRequiringExistence = ['hook_disposed', 'hook_received'];
      if (hookEventsRequiringExistence.includes(data.eventType) && data.correlationId) {
        const existingHook = await getLiveEntry(hooksBucket, data.correlationId);
        if (!existingHook) {
          throw new HookNotFoundError(data.correlationId);
        }
      }

      // Entity creation/updates
      if (data.eventType === 'run_created') {
        const eventData = data.eventData as {
          deploymentId: string;
          workflowName: string;
          input: unknown[];
          executionContext?: Record<string, unknown>;
          attributes?: Record<string, string>;
        };

        const newRun = {
          runId: effectiveRunId,
          deploymentId: eventData.deploymentId,
          workflowName: eventData.workflowName,
          specVersion: effectiveSpecVersion,
          input: eventData.input,
          executionContext: eventData.executionContext,
          // Initial attributes, including lineage ($parentRunId and
          // $rootRunId for a child run); attr_set changes them later.
          attributes: eventData.attributes ?? {},
          status: 'pending' as const,
          output: undefined,
          error: undefined,
          completedAt: undefined,
          startedAt: undefined,
          createdAt: now,
          updatedAt: now,
        };

        // Atomically create the run so only the first writer wins. A
        // concurrent resilient-start (run_started on the queue) may have
        // already created (and even started) this run; overwriting it
        // here would reset a running run back to 'pending'.
        const created = await runsBucket
          .create(effectiveRunId, stringify(newRun))
          .then(() => true)
          .catch(() => false);
        if (!created) {
          // Duplicate run_created: reject with the runtime's dedup signal
          // instead of returning the existing run AND appending a second
          // run_created row to the log. Core treats this 409 as benign on
          // its concurrent-create path ("the run already exists").
          throw new EntityConflictError(`Workflow run "${effectiveRunId}" already exists`);
        }
        await indexRunStatus(effectiveRunId, 'pending');
        run = WorkflowRunSchema.parse(compact(newRun));
      }

      if (data.eventType === 'run_started') {
        // Idempotency: if run is already past pending, this is a replay.
        // Return existing run state without creating a duplicate event.
        if (currentRun?.status === 'running') {
          const entry = await getLiveEntry(runsBucket, effectiveRunId);
          if (entry) {
            const existingData = kvValueToString(entry.value);
            run = WorkflowRunSchema.parse(compact(parse<WorkflowRun>(existingData)));
          }
          // The ceiling must ride every `run_started` response, not just the
          // first: the runtime re-reads it on each replay and drops the limit
          // entirely when it is absent.
          return {
            run: run
              ? (filterRunData(run, entityResolveData(resolveData)) as WorkflowRun)
              : undefined,
            ...(run ? { maxEvents: resolveMaxEventsPerRun(maxEventsPerRun) } : {}),
          };
        }

        let oldStatus: string | undefined;
        const result = await casMutate<WorkflowRun>(runsBucket, effectiveRunId, (existing) => {
          if (isRunTerminal(existing.status)) {
            throw new RunExpiredError(
              `Workflow run "${effectiveRunId}" is already in terminal state "${existing.status}"`,
            );
          }
          if (existing.status === 'running') {
            return { write: false, value: existing };
          }
          oldStatus = existing.status;
          return {
            write: true,
            value: {
              ...existing,
              status: 'running' as const,
              // Only set startedAt on first start.
              startedAt: existing.startedAt ?? now,
              updatedAt: now,
            },
          };
        });

        if (result.type === 'unchanged') {
          // A concurrent run_started won the CAS race; same replay
          // semantics as the pre-check above: no duplicate event.
          const parsedRun = WorkflowRunSchema.parse(compact(result.value));
          return {
            run: filterRunData(parsedRun, entityResolveData(resolveData)) as WorkflowRun,
            maxEvents: resolveMaxEventsPerRun(maxEventsPerRun),
          };
        }
        if (result.type === 'updated') {
          await reindexRunStatus(effectiveRunId, oldStatus, 'running');
          run = WorkflowRunSchema.parse(compact(result.value));
        }
      }

      if (data.eventType === 'run_completed') {
        const eventData = data.eventData as { output?: unknown };
        let oldStatus: string | undefined;
        const result = await casMutate<WorkflowRun>(runsBucket, effectiveRunId, (existing) => {
          if (isRunTerminal(existing.status)) {
            throw new EntityConflictError(
              `Cannot transition run from terminal state "${existing.status}"`,
            );
          }
          oldStatus = existing.status;
          return {
            write: true,
            value: {
              ...existing,
              status: 'completed' as const,
              output: eventData.output,
              completedAt: now,
              updatedAt: now,
            },
          };
        });
        if (result.type === 'updated') {
          await reindexRunStatus(effectiveRunId, oldStatus, 'completed');
          await cleanupHooks(effectiveRunId);
          await cleanupWaits(effectiveRunId);
          run = WorkflowRunSchema.parse(compact(result.value));
        }
      }

      if (data.eventType === 'run_failed') {
        const eventData = data.eventData as { error: unknown; errorCode?: string };

        let oldStatus: string | undefined;
        const result = await casMutate<WorkflowRun>(runsBucket, effectiveRunId, (existing) => {
          if (isRunTerminal(existing.status)) {
            throw new EntityConflictError(
              `Cannot transition run from terminal state "${existing.status}"`,
            );
          }
          oldStatus = existing.status;
          return {
            write: true,
            value: {
              ...existing,
              status: 'failed' as const,
              // The error is the thrown value as the runtime serialized it;
              // consumers hydrate it, so it is stored verbatim.
              error: eventData.error,
              errorCode: eventData.errorCode,
              completedAt: now,
              updatedAt: now,
            },
          };
        });
        if (result.type === 'updated') {
          await reindexRunStatus(effectiveRunId, oldStatus, 'failed');
          await cleanupHooks(effectiveRunId);
          await cleanupWaits(effectiveRunId);
          run = WorkflowRunSchema.parse(compact(result.value));
        }
      }

      if (data.eventType === 'run_cancelled') {
        let oldStatus: string | undefined;
        const result = await casMutate<WorkflowRun>(runsBucket, effectiveRunId, (existing) => {
          // Idempotent: cancelling an already-cancelled run just records the
          // event (the common case is handled in pre-validation; this guards
          // the race where a concurrent cancel wins between read and write).
          if (existing.status === 'cancelled') {
            return { write: false, value: existing };
          }
          if (isRunTerminal(existing.status)) {
            throw new EntityConflictError(
              `Cannot transition run from terminal state "${existing.status}"`,
            );
          }
          oldStatus = existing.status;
          return {
            write: true,
            value: {
              ...existing,
              status: 'cancelled' as const,
              completedAt: now,
              updatedAt: now,
            },
          };
        });
        if (result.type === 'updated') {
          await reindexRunStatus(effectiveRunId, oldStatus, 'cancelled');
          await cleanupHooks(effectiveRunId);
          await cleanupWaits(effectiveRunId);
          run = WorkflowRunSchema.parse(compact(result.value));
        } else if (result.type === 'unchanged') {
          run = WorkflowRunSchema.parse(compact(result.value));
        }
      }

      if (data.eventType === 'step_created' || lazyStepStart) {
        const eventData = data.eventData as {
          stepName: string;
          input: unknown;
        };

        // A lazy start creates the step already running, on its first attempt.
        const newStep = {
          runId: effectiveRunId,
          stepId: data.correlationId!,
          stepName: eventData.stepName,
          input: eventData.input,
          status: lazyStepStart ? ('running' as const) : ('pending' as const),
          attempt: lazyStepStart ? 1 : 0,
          ...(lazyStepStart ? { startedAt: now } : {}),
          specVersion: effectiveSpecVersion,
          createdAt: now,
          updatedAt: now,
        };

        const stepKey = `${effectiveRunId}.${data.correlationId}`;
        // Atomically create the step so only the first writer wins.
        const created = await stepsBucket
          .create(stepKey, stringify(newStep))
          .then(() => true)
          .catch(() => false);
        // The claims bucket admits ONE delivery to append this creation
        // event: a duplicate rejects here with EntityConflictError (for a
        // lazy start, the losers of the create-claim), and a delivery
        // following a crashed winner takes the claim over and appends.
        recordCreation = await claimCreationAppend(
          effectiveRunId,
          data.correlationId!,
          'step_created',
          !created,
          `Step "${data.correlationId}" already exists`,
        );
        if (created) {
          await indexStep(effectiveRunId, data.correlationId!);
          step = StepSchema.parse(compact(newStep));
          stepCreated = lazyStepStart;
        } else {
          // Crash orphan (entity written, event write lost): reuse the
          // existing entity and fall through to the event write below, which
          // completes the partial write.
          const existing = await getLiveEntry(stepsBucket, stepKey);
          if (!existing) {
            throw new WorkflowWorldError(
              `Step "${data.correlationId}" could not be created or read back`,
              { status: 500 },
            );
          }
          const existingData = kvValueToString(existing.value);
          step = StepSchema.parse(compact(parse<Step>(existingData)));
        }
      }

      if (data.eventType === 'step_started' && !lazyStepStart) {
        const stepKey = `${effectiveRunId}.${data.correlationId}`;
        const result = await casMutate<Step>(stepsBucket, stepKey, (existing) => {
          if (isStepTerminal(existing.status)) {
            throw new EntityConflictError(
              `Cannot modify step in terminal state "${existing.status}"`,
            );
          }
          // Retried steps may be scheduled for later. Core handles
          // TooEarlyError by re-enqueueing with the remaining backoff, so
          // configured retry delays are enforced at the storage layer.
          if (existing.retryAfter && existing.retryAfter.getTime() > Date.now()) {
            throw new TooEarlyError(
              `Cannot start step "${data.correlationId}": retryAfter timestamp has not been reached yet`,
              {
                retryAfter: Math.ceil((existing.retryAfter.getTime() - Date.now()) / 1000),
              },
            );
          }
          return {
            write: true,
            value: {
              ...existing,
              status: 'running' as const,
              attempt: existing.attempt + 1,
              // Only set startedAt on first start.
              startedAt: existing.startedAt ?? now,
              // Always clear retryAfter now that the step has started.
              retryAfter: undefined,
              updatedAt: now,
            },
          };
        });
        if (result.type === 'missing') {
          throw new WorkflowWorldError(`Step "${data.correlationId}" not found`, { status: 404 });
        }
        step = StepSchema.parse(compact(result.value));
      }

      if (data.eventType === 'step_completed') {
        const eventData = data.eventData as { result?: unknown };
        const stepKey = `${effectiveRunId}.${data.correlationId}`;
        const result = await casMutate<Step>(stepsBucket, stepKey, (existing) => {
          if (isStepTerminal(existing.status)) {
            throw new EntityConflictError(
              `Cannot modify step in terminal state "${existing.status}"`,
            );
          }
          return {
            write: true,
            value: {
              ...existing,
              status: 'completed' as const,
              output: eventData.result,
              completedAt: now,
              updatedAt: now,
            },
          };
        });
        if (result.type === 'missing') {
          throw new WorkflowWorldError(`Step "${data.correlationId}" not found`, { status: 404 });
        }
        step = StepSchema.parse(compact(result.value));
      }

      if (data.eventType === 'step_failed') {
        const eventData = data.eventData as { error?: unknown };

        const stepKey = `${effectiveRunId}.${data.correlationId}`;
        const result = await casMutate<Step>(stepsBucket, stepKey, (existing) => {
          if (isStepTerminal(existing.status)) {
            throw new EntityConflictError(
              `Cannot modify step in terminal state "${existing.status}"`,
            );
          }
          return {
            write: true,
            value: {
              ...existing,
              status: 'failed' as const,
              // Stored verbatim: the runtime's serialized error payload.
              error: eventData.error,
              completedAt: now,
              updatedAt: now,
            },
          };
        });
        if (result.type === 'missing') {
          throw new WorkflowWorldError(`Step "${data.correlationId}" not found`, { status: 404 });
        }
        step = StepSchema.parse(compact(result.value));
      }

      if (data.eventType === 'step_retrying') {
        const eventData = data.eventData as { error?: unknown; retryAfter?: Date };

        const stepKey = `${effectiveRunId}.${data.correlationId}`;
        const result = await casMutate<Step>(stepsBucket, stepKey, (existing) => {
          if (isStepTerminal(existing.status)) {
            throw new EntityConflictError(
              `Cannot modify step in terminal state "${existing.status}"`,
            );
          }
          return {
            write: true,
            value: {
              ...existing,
              status: 'pending' as const,
              error: eventData.error,
              retryAfter: eventData.retryAfter,
              updatedAt: now,
            },
          };
        });
        if (result.type === 'missing') {
          throw new WorkflowWorldError(`Step "${data.correlationId}" not found`, { status: 404 });
        }
        step = StepSchema.parse(compact(result.value));
      }

      if (data.eventType === 'hook_created') {
        const eventData = data.eventData as {
          token: string;
          metadata?: unknown;
          isWebhook?: boolean;
        };
        const hookId = data.correlationId!;

        // Token-first arbitration. The by-token entry is claimed with an
        // atomic create(); a plain put() would let the second of two
        // concurrent deliveries silently overwrite the first holder. A
        // delivery that finds the token taken classifies the holder:
        //   - same (runId, hookId)  -> duplicate/orphan, arbitrated below
        //   - different holder      -> hook_conflict event
        //   - holder entity missing -> our own partial write resumes, a
        //     foreign dangling token (crash during cleanup) heals + retries
        let tokenOutcome: 'claimed' | 'same-hook' | { conflictingRunId: string } | null = null;
        let existingHook: Hook | null = null;
        for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS && tokenOutcome === null; attempt++) {
          const tokenEntry = await getLiveEntry(hooksTokenBucket, eventData.token);
          if (!tokenEntry) {
            const claimed = await hooksTokenBucket
              .create(eventData.token, hookId)
              .then(() => true)
              .catch(() => false);
            if (claimed) tokenOutcome = 'claimed';
            // Lost the race: loop and re-read the new holder.
            continue;
          }
          const holderHookId = kvValueToString(tokenEntry.value);
          const holderEntry = await getLiveEntry(hooksBucket, holderHookId);
          if (!holderEntry) {
            if (holderHookId === hookId) {
              // Our own hookId holds the token but its entity write was
              // lost: resume the partial create.
              tokenOutcome = 'claimed';
            } else {
              // Dangling token index (crash during hook cleanup): the owning
              // entity is gone, so the token is free; heal and retry.
              await hooksTokenBucket.delete(eventData.token).catch(() => {});
            }
            continue;
          }
          existingHook = parse<Hook>(kvValueToString(holderEntry.value));
          tokenOutcome =
            existingHook.runId === effectiveRunId && existingHook.hookId === hookId
              ? 'same-hook'
              : { conflictingRunId: existingHook.runId };
        }
        if (tokenOutcome === null) {
          throw new WorkflowWorldError(
            `Concurrent hook_created for token did not settle after ${MAX_CAS_ATTEMPTS} attempts`,
            { status: 409 },
          );
        }

        if (typeof tokenOutcome === 'object') {
          // Cross-run / cross-hook conflict: a different (runId, hookId)
          // holds this token. Record a hook_conflict event (with the
          // conflicting holder) so the workflow fails gracefully when the
          // hook is awaited, instead of throwing here. The rightful owner's
          // token mapping is left untouched.
          const conflictEventData = {
            token: eventData.token,
            conflictingRunId: tokenOutcome.conflictingRunId,
          };
          const conflictEvent = await appendEvent({
            eventType: 'hook_conflict' as const,
            correlationId: data.correlationId,
            eventData: conflictEventData,
            runId: effectiveRunId,
            createdAt: new Date(),
            specVersion: effectiveSpecVersion,
          });

          const parsedConflict = EventSchema.parse(conflictEvent);
          const conflictResult: EventResult = {
            event: stripEventDataRefs(parsedConflict, resolveData),
            run,
            step,
            hook: undefined,
          };
          const skipped = await reportSkippedSlots(
            effectiveRunId,
            conflictEvent.eventId,
            params?.eventCount,
            resolveData,
          );
          return (skipped ? { ...conflictResult, ...skipped } : conflictResult) as EventResult;
        }

        if (tokenOutcome === 'same-hook') {
          // The *same* (runId, hookId) already holds this token: a replayed
          // hook_created, or an orphan from a crash between the entity and
          // event writes. The claims bucket arbitrates: a true duplicate
          // throws EntityConflictError (so the runtime's replay catch path
          // swallows it instead of logging a self hook_conflict), an orphan
          // adopts the canonical id and completes the write below.
          recordCreation = await claimCreationAppend(
            effectiveRunId,
            hookId,
            'hook_created',
            true,
            `Hook "${hookId}" already created`,
          );
          hook = HookSchema.parse(compact(existingHook!));
        } else {
          const newHook: Hook = {
            runId: effectiveRunId,
            hookId,
            token: eventData.token,
            ownerId: '',
            projectId: '',
            environment: '',
            metadata: eventData.metadata,
            isWebhook: eventData.isWebhook,
            specVersion: effectiveSpecVersion,
            createdAt: now,
          };

          await hooksBucket.put(hookId, stringify(newHook));
          await indexHook(effectiveRunId, hookId);
          recordCreation = await claimCreationAppend(
            effectiveRunId,
            hookId,
            'hook_created',
            false,
            `Hook "${hookId}" already created`,
          );
          hook = HookSchema.parse(compact(newHook));
        }
      }

      if (data.eventType === 'hook_disposed' && data.correlationId) {
        const hookEntry = await getLiveEntry(hooksBucket, data.correlationId);
        if (!hookEntry) {
          // The pre-validation above saw the hook; it vanished in between,
          // so a concurrent disposal won the race.
          throw new EntityConflictError(`Hook "${data.correlationId}" already disposed`);
        }
        const hookData = kvValueToString(hookEntry.value);
        const existingHook = parse<Hook>(hookData);
        await hooksBucket.delete(data.correlationId);
        await hooksTokenBucket.delete(existingHook.token);
        await removeHookIndex(effectiveRunId, data.correlationId);
      }

      if (data.eventType === 'wait_created') {
        const eventData = data.eventData as { resumeAt?: Date };
        const waitKey = `${effectiveRunId}.${data.correlationId}`;
        const newWait = {
          waitId: `${effectiveRunId}-${data.correlationId}`,
          runId: effectiveRunId,
          status: 'waiting' as const,
          resumeAt: eventData.resumeAt,
          specVersion: effectiveSpecVersion,
          createdAt: now,
          updatedAt: now,
        };
        // Atomically create the wait so only the first writer wins.
        const created = await waitsBucket
          .create(waitKey, stringify(newWait))
          .then(() => true)
          .catch(() => false);
        // Same arbitration as step_created above: a true duplicate rejects,
        // a delivery following a crashed winner appends the event.
        recordCreation = await claimCreationAppend(
          effectiveRunId,
          data.correlationId!,
          'wait_created',
          !created,
          `Wait "${data.correlationId}" already exists`,
        );
        if (created) {
          wait = WaitSchema.parse(compact(newWait));
        } else {
          // Crash orphan: reuse the existing entity; the event write below
          // completes the partial write.
          const existing = await getLiveEntry(waitsBucket, waitKey);
          if (!existing) {
            throw new WorkflowWorldError(
              `Wait "${data.correlationId}" could not be created or read back`,
              { status: 500 },
            );
          }
          wait = WaitSchema.parse(compact(parse<Wait>(kvValueToString(existing.value))));
        }
      }

      if (data.eventType === 'wait_completed') {
        const waitKey = `${effectiveRunId}.${data.correlationId}`;
        const result = await casMutate<Wait>(waitsBucket, waitKey, (existing) => {
          // Core catches EntityConflictError here as "wait already
          // completed, skipping" during replay.
          if (existing.status === 'completed') {
            throw new EntityConflictError(`Wait "${data.correlationId}" already completed`);
          }
          return {
            write: true,
            value: {
              ...existing,
              status: 'completed' as const,
              completedAt: now,
              updatedAt: now,
            },
          };
        });
        if (result.type === 'missing') {
          throw new WorkflowWorldError(`Wait "${data.correlationId}" not found`, { status: 404 });
        }
        wait = WaitSchema.parse(compact(result.value));
      }

      if (data.eventType === 'attr_set') {
        const { changes, allowReservedAttributes } = data.eventData;
        const result = await casMutate<WorkflowRun>(runsBucket, effectiveRunId, (existing) => {
          if (isRunTerminal(existing.status)) {
            throw new EntityConflictError(
              `Cannot set attributes on run in terminal state "${existing.status}"`,
            );
          }
          validateAttributeChanges(changes, {
            existingKeys: Object.keys(existing.attributes ?? {}),
            allowReservedAttributes: allowReservedAttributes === true,
          });
          return {
            write: true,
            value: {
              ...existing,
              attributes: applyAttributeChanges(existing.attributes ?? undefined, changes),
              updatedAt: now,
            },
          };
        });
        if (result.type === 'missing') {
          throw new WorkflowRunNotFoundError(effectiveRunId);
        }
        run = WorkflowRunSchema.parse(compact(result.value));
      }

      // Append the event at the run's next free slot.
      const toStore: Record<string, unknown> = {
        ...data,
        runId: effectiveRunId,
        createdAt: new Date(),
        specVersion: effectiveSpecVersion,
      };

      // Strip eventData from run_started events before storage
      if (data.eventType === 'run_started') {
        delete toStore.eventData;
      }

      // A lazy start journals the step_created it implies first, so the log
      // reads as if the step had been created in the usual order. The stored
      // step_started keeps its stepName (replay checks it) but drops the
      // input, which lives on the step_created.
      if (lazyStepStart) {
        const { input, stepName, ...startedData } = data.eventData as Record<string, unknown>;
        const createdEvent = await appendEvent({
          eventType: 'step_created' as const,
          correlationId: data.correlationId,
          eventData: { stepName, input },
          runId: effectiveRunId,
          createdAt: now,
          specVersion: effectiveSpecVersion,
        });
        await recordCreation?.(createdEvent.eventId);
        recordCreation = undefined;
        toStore.eventData = { ...startedData, stepName };
      }

      const event = await appendEvent(toStore as typeof toStore & { runId: string });
      await recordCreation?.(event.eventId);

      const parsed = EventSchema.parse(compact(event));

      // Preload all events for run_started to reduce TTFB
      let allEvents: Event[] | undefined;
      if (data.eventType === 'run_started' && run) {
        const eventsList = await loadEventsForRun(effectiveRunId);
        allEvents = eventsList.map((e) =>
          stripEventDataRefs(EventSchema.parse(compact(e)), resolveData),
        );
      }

      // The run_started preload already carries the whole log, which covers
      // any span this write skipped. The three delta fields travel together.
      const delta: Pick<EventResult, 'events' | 'cursor' | 'hasMore'> | undefined = allEvents
        ? { events: allEvents, cursor: allEvents.at(-1)?.eventId ?? null, hasMore: false }
        : await reportSkippedSlots(effectiveRunId, event.eventId, params?.eventCount, resolveData);

      return {
        event: stripEventDataRefs(parsed, resolveData),
        run,
        step,
        hook,
        wait,
        ...(stepCreated ? { stepCreated: true as const } : {}),
        ...delta,
        // The runtime reads the per-run event ceiling from the `run_started`
        // response and nowhere else.
        ...(data.eventType === 'run_started' && run
          ? { maxEvents: resolveMaxEventsPerRun(maxEventsPerRun) }
          : {}),
      } as EventResult;
    },

    async get(runId: string, eventId: string, params?: GetEventParams): Promise<Event> {
      await initBuckets();
      // Slot ids live under the run; a ULID id belongs to a pre-slot run.
      const entry =
        eventIdToSlot(eventId) !== null
          ? await getLiveEntry(runEventsBucket, runEventKey(runId, eventId))
          : await getLiveEntry(eventsBucket, eventId);
      if (!entry) {
        throw new WorkflowWorldError(`Event not found: ${eventId}`, {
          status: 404,
        });
      }
      const data = kvValueToString(entry.value);
      const event = parse<Event>(data);
      if (event.runId !== runId) {
        throw new WorkflowWorldError(`Event not found: ${eventId}`, {
          status: 404,
        });
      }
      const parsed = EventSchema.parse(compact(event));
      return stripEventDataRefs(parsed, params?.resolveData ?? 'all');
    },

    async list(params: ListEventsParams): Promise<PaginatedResponse<Event>> {
      await initBuckets();
      const limit = params?.pagination?.limit ?? 100;
      const sortOrder = params.pagination?.sortOrder || 'asc';
      const resolveData = params?.resolveData ?? 'all';

      // In log order: slot ids sort by position (fixed width), ULIDs by time.
      const events = await loadEventsForRun(params.runId);
      if (sortOrder === 'desc') events.reverse();

      // Apply cursor
      let startIdx = 0;
      if (params?.pagination?.cursor) {
        const cursorIdx = events.findIndex((e) => e.eventId === params.pagination!.cursor);
        if (cursorIdx !== -1) {
          startIdx = cursorIdx + 1;
        }
      }

      const values = events.slice(startIdx, startIdx + limit);
      const hasMore = startIdx + limit < events.length;

      return {
        data: values.map((v) => {
          const parsed = EventSchema.parse(compact(v));
          return stripEventDataRefs(parsed, resolveData);
        }),
        cursor: values.at(-1)?.eventId ?? null,
        hasMore,
      };
    },

    async listByCorrelationId(
      params: ListEventsByCorrelationIdParams,
    ): Promise<PaginatedResponse<Event>> {
      await initBuckets();
      const limit = params?.pagination?.limit ?? 100;
      const sortOrder = params.pagination?.sortOrder || 'asc';
      const resolveData = params?.resolveData ?? 'all';

      // A correlation id identifies a step, hook or wait within its run, so
      // the lookup is always run-scoped. Filtering before the cursor and
      // limit are applied keeps cursor and hasMore honest.
      const events = (await loadEventsForRun(params.runId)).filter(
        (event) => event.correlationId === params.correlationId,
      );
      if (sortOrder === 'desc') events.reverse();

      // Apply cursor
      let startIdx = 0;
      if (params?.pagination?.cursor) {
        const cursorIdx = events.findIndex((e) => e.eventId === params.pagination!.cursor);
        if (cursorIdx !== -1) {
          startIdx = cursorIdx + 1;
        }
      }

      const values = events.slice(startIdx, startIdx + limit);
      const hasMore = startIdx + limit < events.length;

      return {
        data: values.map((v) => {
          const parsed = EventSchema.parse(compact(v));
          return stripEventDataRefs(parsed, resolveData);
        }),
        cursor: values.at(-1)?.eventId ?? null,
        hasMore,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Steps storage
// ---------------------------------------------------------------------------

/**
 * Create storage for workflow steps using JetStream KV Store.
 *
 * Uses a secondary index bucket (`<prefix>steps_by_run`) so that
 * `steps.list({ runId })` can look up step IDs by run without scanning.
 */
export function createStepsStorage(config: NatsStorageConfig): Storage['steps'] {
  const { getJetStream, keyPrefix } = config;
  let stepsBucket: KV;
  let stepsByRunBucket: KV;

  let bucketsReady: Promise<void> | undefined;
  // Memoized: concurrent first calls share one open, so none of them proceeds
  // while a later bucket is still unassigned.
  const initBuckets = (): Promise<void> =>
    (bucketsReady ??= openBuckets().catch((err: unknown) => {
      bucketsReady = undefined;
      throw err;
    }));
  const openBuckets = async () => {
    if (!stepsBucket) {
      const jetstream = await getJetStream();
      stepsBucket = await new Kvm(jetstream).create(`${keyPrefix}steps`, {
        history: 10,
      });
      stepsByRunBucket = await new Kvm(jetstream).create(`${keyPrefix}steps_by_run`, {
        history: 1,
      });
    }
  };

  return {
    get: (async (runId: string | undefined, stepId: string, params?: GetStepParams) => {
      await initBuckets();

      // If runId provided, use direct lookup
      if (runId) {
        const stepKey = `${runId}.${stepId}`;
        const entry = await getLiveEntry(stepsBucket, stepKey);
        if (!entry) {
          throw new WorkflowWorldError(`Step not found: ${stepId}`, {
            status: 404,
          });
        }
        const data = kvValueToString(entry.value);
        const step = parse<Step>(data);
        const parsed = StepSchema.parse(compact(step));
        const resolveData = params?.resolveData ?? 'all';
        return filterStepData(parsed, resolveData);
      }

      // Otherwise scan live entries (one per step, latest revision only)
      for await (const entry of listLiveEntries(stepsBucket)) {
        const data = kvValueToString(entry.value);
        const step = parse<Step>(data);

        if (step.stepId === stepId) {
          const parsed = StepSchema.parse(compact(step));
          const resolveData = params?.resolveData ?? 'all';
          return filterStepData(parsed, resolveData);
        }
      }

      throw new WorkflowWorldError(`Step not found: ${stepId}`, {
        status: 404,
      });
    }) as Storage['steps']['get'],

    list: (async (params: ListWorkflowRunStepsParams) => {
      await initBuckets();
      const limit = params?.pagination?.limit ?? 20;
      const resolveData = params?.resolveData ?? 'all';

      const steps: (Step | StepWithoutData)[] = [];

      // Try index-based lookup first
      const stepIds = await collectIndexKeys(stepsByRunBucket, `${params.runId}.`);

      if (stepIds.length > 0) {
        for (const stepId of stepIds) {
          const stepKey = `${params.runId}.${stepId}`;
          try {
            const entry = await getLiveEntry(stepsBucket, stepKey);
            if (!entry) continue;

            const data = kvValueToString(entry.value);
            const step = parse<Step>(data);
            const parsed = StepSchema.parse(compact(step));
            steps.push(filterStepData(parsed, resolveData));
          } catch {
            debug(`Stale index entry for step ${stepId}, skipping`);
          }
        }
      } else {
        // Fallback: full scan of live entries (handles data created before
        // indexes existed)
        for await (const entry of listLiveEntries(stepsBucket)) {
          const data = kvValueToString(entry.value);
          const step = parse<Step>(data);

          if (step.runId === params.runId) {
            const parsed = StepSchema.parse(compact(step));
            steps.push(filterStepData(parsed, resolveData));
          }
        }
      }

      // Sort by stepId descending (matches world-postgres)
      steps.sort((a, b) => compareIds(b.stepId, a.stepId));

      // Apply cursor
      let startIdx = 0;
      if (params?.pagination?.cursor) {
        const cursorIdx = steps.findIndex((s) => s.stepId === params.pagination!.cursor);
        if (cursorIdx !== -1) {
          startIdx = cursorIdx + 1;
        }
      }

      const values = steps.slice(startIdx, startIdx + limit);
      const hasMore = startIdx + limit < steps.length;

      return {
        data: values,
        hasMore,
        cursor: (values.at(-1) as Step | undefined)?.stepId ?? null,
      };
    }) as Storage['steps']['list'],
  };
}

// ---------------------------------------------------------------------------
// Hooks storage
// ---------------------------------------------------------------------------

/**
 * Create storage for hooks using JetStream KV Store.
 *
 * Uses a secondary index bucket (`<prefix>hooks_by_run`) so that
 * `hooks.list({ runId })` can look up hook IDs by run without scanning.
 */
export function createHooksStorage(config: NatsStorageConfig): Storage['hooks'] {
  const { getJetStream, keyPrefix } = config;
  let hooksBucket: KV;
  let hooksTokenBucket: KV;
  let hooksByRunBucket: KV;

  let bucketsReady: Promise<void> | undefined;
  // Memoized: concurrent first calls share one open, so none of them proceeds
  // while a later bucket is still unassigned.
  const initBuckets = (): Promise<void> =>
    (bucketsReady ??= openBuckets().catch((err: unknown) => {
      bucketsReady = undefined;
      throw err;
    }));
  const openBuckets = async () => {
    if (!hooksBucket) {
      const jetstream = await getJetStream();
      hooksBucket = await new Kvm(jetstream).create(`${keyPrefix}hooks`, {
        history: 10,
      });
      hooksTokenBucket = await new Kvm(jetstream).create(`${keyPrefix}hooks_by_token`, {
        history: 1,
      });
      hooksByRunBucket = await new Kvm(jetstream).create(`${keyPrefix}hooks_by_run`, {
        history: 1,
      });
    }
  };

  return {
    async get(hookId: string, params?: GetHookParams): Promise<Hook> {
      await initBuckets();
      const entry = await getLiveEntry(hooksBucket, hookId);
      if (!entry) {
        // Core treats HookNotFoundError as benign "already disposed".
        throw new HookNotFoundError(hookId);
      }
      const data = kvValueToString(entry.value);
      const hook = parse<Hook>(data);
      const parsed = HookSchema.parse(compact(hook));
      const resolveData = params?.resolveData ?? 'all';
      return filterHookData(parsed, resolveData);
    },

    async getByToken(token: string, params?: GetHookParams): Promise<Hook> {
      await initBuckets();
      const entry = await getLiveEntry(hooksTokenBucket, token);
      if (!entry) {
        throw new HookNotFoundError(token);
      }
      const hookId = kvValueToString(entry.value);
      return this.get(hookId, params);
    },

    async list(params: ListHooksParams): Promise<PaginatedResponse<Hook>> {
      await initBuckets();
      const limit = params?.pagination?.limit ?? 100;

      if (!params.runId) {
        return { data: [], cursor: null, hasMore: false };
      }

      const hooks: Hook[] = [];

      // Try index-based lookup first
      const hookIds = await collectIndexKeys(hooksByRunBucket, `${params.runId}.`);

      if (hookIds.length > 0) {
        for (const hookId of hookIds) {
          try {
            const entry = await getLiveEntry(hooksBucket, hookId);
            if (!entry) continue;

            const data = kvValueToString(entry.value);
            const hook = parse<Hook>(data);
            const parsed = HookSchema.parse(compact(hook));
            const filtered = filterHookData(parsed, params?.resolveData ?? 'all');
            hooks.push(filtered);
          } catch {
            debug(`Stale index entry for hook ${hookId}, skipping`);
          }
        }
      } else {
        // Fallback: full scan of live entries (handles data created before
        // indexes existed)
        for await (const entry of listLiveEntries(hooksBucket)) {
          const data = kvValueToString(entry.value);
          const hook = parse<Hook>(data);

          if (hook.runId === params.runId) {
            const parsed = HookSchema.parse(compact(hook));
            const filtered = filterHookData(parsed, params?.resolveData ?? 'all');
            hooks.push(filtered);
          }
        }
      }

      // Sort by hookId, ascending by default (matches world-postgres)
      const sortOrder = params?.pagination?.sortOrder ?? 'asc';
      if (sortOrder === 'asc') {
        hooks.sort((a, b) => compareIds(a.hookId, b.hookId));
      } else {
        hooks.sort((a, b) => compareIds(b.hookId, a.hookId));
      }

      // Apply cursor
      let startIdx = 0;
      if (params?.pagination?.cursor) {
        const cursorIdx = hooks.findIndex((h) => h.hookId === params.pagination!.cursor);
        if (cursorIdx !== -1) {
          startIdx = cursorIdx + 1;
        }
      }

      const values = hooks.slice(startIdx, startIdx + limit);
      const hasMore = startIdx + limit < hooks.length;

      return {
        data: values,
        cursor: values.at(-1)?.hookId ?? null,
        hasMore,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Compaction
// ---------------------------------------------------------------------------

const TERMINAL_STATUSES = ['completed', 'failed', 'cancelled'] as const;

/**
 * Compact terminal runs that exceed the configured TTL.
 *
 * Deletes the run plus its associated steps, hooks, events, and index
 * entries. Intended to be called periodically (e.g. via `setInterval`).
 */
export async function compactTerminalRuns(config: NatsStorageConfig): Promise<number> {
  const { getJetStream, keyPrefix, terminalRunTTLMs } = config;
  const ttl = terminalRunTTLMs ?? DEFAULT_TERMINAL_RUN_TTL_MS;

  // 0 means retain indefinitely
  if (ttl === 0) return 0;

  const cutoff = Date.now() - ttl;

  const jetstream = await getJetStream();
  const runsBucket = await new Kvm(jetstream).create(`${keyPrefix}runs`, { history: 10 });
  const runsByStatusBucket = await new Kvm(jetstream).create(`${keyPrefix}runs_by_status`, {
    history: 1,
  });
  const stepsBucket = await new Kvm(jetstream).create(`${keyPrefix}steps`, { history: 10 });
  const stepsByRunBucket = await new Kvm(jetstream).create(`${keyPrefix}steps_by_run`, {
    history: 1,
  });
  const hooksBucket = await new Kvm(jetstream).create(`${keyPrefix}hooks`, { history: 10 });
  const hooksByRunBucket = await new Kvm(jetstream).create(`${keyPrefix}hooks_by_run`, {
    history: 1,
  });
  const hooksTokenBucket = await new Kvm(jetstream).create(`${keyPrefix}hooks_by_token`, {
    history: 1,
  });
  const eventsBucket = await new Kvm(jetstream).create(`${keyPrefix}events`, { history: 10 });
  const eventsByRunBucket = await new Kvm(jetstream).create(`${keyPrefix}events_by_run`, {
    history: 1,
  });
  const waitsBucket = await new Kvm(jetstream).create(`${keyPrefix}waits`, { history: 1 });
  const runEventsBucket = await new Kvm(jetstream).create(`${keyPrefix}run_events`, {
    history: 1,
  });
  const eventHeadsBucket = await new Kvm(jetstream).create(`${keyPrefix}event_heads`, {
    history: 1,
  });
  const creationClaimsBucket = await new Kvm(jetstream).create(`${keyPrefix}creation_claims`, {
    history: 1,
  });

  let compactedCount = 0;

  // Iterate terminal run index entries
  for (const status of TERMINAL_STATUSES) {
    const runIds = await collectIndexKeys(runsByStatusBucket, `${status}.`);

    for (const runId of runIds) {
      try {
        const entry = await getLiveEntry(runsBucket, runId);
        if (!entry) {
          // Stale index: clean up
          try {
            await runsByStatusBucket.delete(`${status}.${runId}`);
          } catch {
            /* noop */
          }
          continue;
        }

        const data = kvValueToString(entry.value);
        const run = parse<WorkflowRun>(data);

        if (!run.completedAt || run.completedAt.getTime() >= cutoff) continue;

        // Delete associated steps
        const stepIds = await collectIndexKeys(stepsByRunBucket, `${runId}.`);
        for (const stepId of stepIds) {
          try {
            await stepsBucket.delete(`${runId}.${stepId}`);
          } catch {
            /* noop */
          }
          try {
            await stepsByRunBucket.delete(`${runId}.${stepId}`);
          } catch {
            /* noop */
          }
        }

        // Delete associated hooks
        const hookIds = await collectIndexKeys(hooksByRunBucket, `${runId}.`);
        for (const hookId of hookIds) {
          try {
            const hookEntry = await getLiveEntry(hooksBucket, hookId);
            if (hookEntry) {
              const hookData = kvValueToString(hookEntry.value);
              const hook = parse<Hook>(hookData);
              try {
                await hooksTokenBucket.delete(hook.token);
              } catch {
                /* noop */
              }
            }
            await hooksBucket.delete(hookId);
          } catch {
            /* noop */
          }
          try {
            await hooksByRunBucket.delete(`${runId}.${hookId}`);
          } catch {
            /* noop */
          }
        }

        // Delete associated waits
        const waitCorrelationIds = await collectIndexKeys(waitsBucket, `${runId}.`);
        for (const correlationId of waitCorrelationIds) {
          try {
            await waitsBucket.delete(`${runId}.${correlationId}`);
          } catch {
            /* noop */
          }
        }

        // Delete associated events (via the per-run index; fall back to a
        // live scan for events written before the index existed)
        const eventIds = await collectIndexKeys(eventsByRunBucket, `${runId}.`);
        if (eventIds.length > 0) {
          for (const eventId of eventIds) {
            try {
              await eventsBucket.delete(eventId);
            } catch {
              /* noop */
            }
            try {
              await eventsByRunBucket.delete(`${runId}.${eventId}`);
            } catch {
              /* noop */
            }
          }
        } else {
          for await (const evtEntry of listLiveEntries(eventsBucket)) {
            const evtData = kvValueToString(evtEntry.value);
            const evt = parse<Event>(evtData);
            if (evt.runId === runId) {
              try {
                await eventsBucket.delete(evt.eventId);
              } catch {
                /* noop */
              }
            }
          }
        }

        // Delete the run's creation-event claims (keys are
        // `<runId>.<correlationId>.<eventType>`; runIds are ULIDs and never
        // reused, so tombstoned claim keys are never re-created)
        const claimSuffixes = await collectIndexKeys(creationClaimsBucket, `${runId}.`);
        for (const suffix of claimSuffixes) {
          try {
            await creationClaimsBucket.delete(`${runId}.${suffix}`);
          } catch {
            /* noop */
          }
        }

        // Delete the run's slot-numbered log and its head. Run ids are never
        // reused, so tombstoned slot keys are never re-created.
        for (const eventId of await collectIndexKeys(runEventsBucket, `${runId}.`)) {
          try {
            await runEventsBucket.delete(`${runId}.${eventId}`);
          } catch {
            /* noop */
          }
        }
        try {
          await eventHeadsBucket.delete(runId);
        } catch {
          /* noop */
        }

        // Delete the run itself and its index entry
        try {
          await runsBucket.delete(runId);
        } catch {
          /* noop */
        }
        try {
          await runsByStatusBucket.delete(`${status}.${runId}`);
        } catch {
          /* noop */
        }

        compactedCount++;
        debug(`Compacted terminal run ${runId} (status=${status})`);
      } catch (err) {
        debug(`Failed to compact run ${runId}`, { error: err });
      }
    }
  }

  return compactedCount;
}

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
  EventSchema,
  HookSchema,
  isLegacySpecVersion,
  requiresNewerWorld,
  SPEC_VERSION_CURRENT,
  StepSchema,
  stripEventDataRefs,
  WaitSchema,
  WorkflowRunSchema,
} from '@workflow/world';
import type { JetStreamClient, KV, KvEntry } from 'nats';
import { decodeTime, monotonicFactory } from 'ulid';
import { parse, stringify } from '@fantasticfour/shared';
import { compact, debug } from './util.js';

interface NatsStorageConfig {
  getJetStream: () => Promise<JetStreamClient>;
  keyPrefix: string;
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

/** Decode the ULID time embedded in a prefixed id (e.g. `wevt_01J...`).
 * Matches the runtime: strip through the *last* underscore, then decode. */
function idTime(id: string): number {
  return decodeTime(id.slice(id.lastIndexOf('_') + 1));
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

  const initBuckets = async () => {
    if (!runsBucket) {
      const jetstream = await getJetStream();
      runsBucket = await jetstream.views.kv(`${keyPrefix}runs`, {
        history: 10,
      });
      runsByStatusBucket = await jetstream.views.kv(`${keyPrefix}runs_by_status`, {
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

      // If filtering by status, use the secondary index for a fast lookup
      if (params?.status) {
        const prefix = `${params.status}.`;
        candidateRunIds = await collectIndexKeys(runsByStatusBucket, prefix);
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

          const statusMatches = !params?.status || run.status === params.status;
          const nameMatches = !params?.workflowName || run.workflowName === params.workflowName;

          if (statusMatches && nameMatches) {
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
  let runStateMarkersBucket: KV;
  let creationClaimsBucket: KV;

  const initBuckets = async () => {
    if (!eventsBucket) {
      const jetstream = await getJetStream();
      eventsBucket = await jetstream.views.kv(`${keyPrefix}events`, {
        history: 10,
      });
      runsBucket = await jetstream.views.kv(`${keyPrefix}runs`, {
        history: 10,
      });
      stepsBucket = await jetstream.views.kv(`${keyPrefix}steps`, {
        history: 10,
      });
      hooksBucket = await jetstream.views.kv(`${keyPrefix}hooks`, {
        history: 10,
      });
      hooksTokenBucket = await jetstream.views.kv(`${keyPrefix}hooks_by_token`, {
        history: 1,
      });
      waitsBucket = await jetstream.views.kv(`${keyPrefix}waits`, {
        history: 1,
      });
      // Secondary indexes
      runsByStatusBucket = await jetstream.views.kv(`${keyPrefix}runs_by_status`, {
        history: 1,
      });
      stepsByRunBucket = await jetstream.views.kv(`${keyPrefix}steps_by_run`, {
        history: 1,
      });
      hooksByRunBucket = await jetstream.views.kv(`${keyPrefix}hooks_by_run`, {
        history: 1,
      });
      eventsByRunBucket = await jetstream.views.kv(`${keyPrefix}events_by_run`, {
        history: 1,
      });
      // Optimistic-concurrency markers (one per run); only the latest matters.
      runStateMarkersBucket = await jetstream.views.kv(`${keyPrefix}run_state_markers`, {
        history: 1,
      });
      // Exactly-once arbiter for entity-creating events: one canonical
      // eventId per (runId, correlationId, eventType), elected via atomic
      // create(). The NATS equivalent of world-postgres's
      // `workflow_events_entity_creation_unique` index. The steps/hooks
      // sub-storages below never write creation events, so only the events
      // storage (and compaction) opens this bucket.
      creationClaimsBucket = await jetstream.views.kv(`${keyPrefix}creation_claims`, {
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
  // Optimistic-concurrency marker (CreateEventParams.stateUpdatedAt)
  // ------------------------------------------------------------------

  /** Read a run's state marker: the ULID time of the most recent
   * externally-originated event. `null` (none yet) passes the guard. */
  async function readStateMarker(runId: string): Promise<number | null> {
    const entry = await getLiveEntry(runStateMarkersBucket, runId);
    if (!entry) return null;
    const marker = Number(kvValueToString(entry.value));
    if (!Number.isInteger(marker)) {
      throw new WorkflowWorldError(`Corrupt state marker for run "${runId}"`, { status: 500 });
    }
    return marker;
  }

  /** Advance a run's state marker to `markerTime`, never backwards.
   * Revision-checked: a lost update would regress the marker and silently
   * disable the guard for every later create. */
  async function advanceStateMarker(runId: string, markerTime: number): Promise<void> {
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
      const entry = await getLiveEntry(runStateMarkersBucket, runId);
      if (!entry) {
        // `create` only succeeds while the key is absent, so a concurrent
        // writer cannot be clobbered; it just sends us round again.
        const created = await runStateMarkersBucket
          .create(runId, `${markerTime}`)
          .then(() => true)
          .catch(() => false);
        if (created) return;
        continue;
      }
      const current = Number(kvValueToString(entry.value));
      if (!Number.isInteger(current)) {
        throw new WorkflowWorldError(`Corrupt state marker for run "${runId}"`, { status: 500 });
      }
      if (current >= markerTime) return;
      try {
        await runStateMarkersBucket.update(runId, `${markerTime}`, entry.revision);
        return;
      } catch (err) {
        if (!isWrongLastSequence(err)) throw err;
        // Lost the race: re-read and re-compare.
      }
    }
    throw new WorkflowWorldError(
      `Concurrent state-marker update for run "${runId}" did not settle after ${MAX_CAS_ATTEMPTS} attempts`,
      { status: 409 },
    );
  }

  /** Persist an event and index it under its run for efficient per-run reads. */
  async function putEvent(runId: string, eventId: string, event: unknown): Promise<void> {
    await eventsBucket.put(eventId, stringify(event));
    await eventsByRunBucket.put(`${runId}.${eventId}`, eventId);
  }

  /**
   * Elect the canonical eventId for an entity-creating event.
   *
   * `creationClaimsBucket.create()` is atomic, so exactly one delivery wins
   * the claim per (runId, correlationId, eventType). Every other delivery
   * either rejects (the canonical event is already durable, a true
   * duplicate -> EntityConflictError) or adopts the canonical id and
   * completes the crashed winner's write, so concurrent redeliveries racing
   * an orphan window converge on ONE event row instead of double-appending.
   *
   * `entityExisted` marks deliveries that lost the entity create: those may
   * hit runs predating the claims bucket (no claim yet), so the event log is
   * probed as the legacy fallback arbiter before healing.
   */
  async function claimCreationEvent(
    runId: string,
    correlationId: string,
    eventType: Event['eventType'],
    proposedEventId: string,
    entityExisted: boolean,
    conflictMessage: string,
  ): Promise<string> {
    const claimKey = `${runId}.${correlationId}.${eventType}`;
    const claimed = await creationClaimsBucket
      .create(claimKey, proposedEventId)
      .then(() => true)
      .catch(() => false);
    if (claimed) {
      if (entityExisted) {
        // Legacy entity (predates the claims bucket) or crash orphan: the
        // event log is the only witness. Event durable -> converge the claim
        // on it and reject; missing -> heal under our own id.
        const existingEvent = await loadEventsForRun(runId).then((events) =>
          events.find((e) => e.eventType === eventType && e.correlationId === correlationId),
        );
        if (existingEvent) {
          // Point the claim at the durable event so later redeliveries
          // arbitrate against the real canonical id, not our unwritten one.
          await creationClaimsBucket.put(claimKey, existingEvent.eventId);
          throw new EntityConflictError(conflictMessage);
        }
      }
      return proposedEventId;
    }
    // Lost the claim: converge on the winner's canonical eventId.
    const claimEntry = await getLiveEntry(creationClaimsBucket, claimKey);
    if (!claimEntry) {
      // Claim tombstoned between create() and get() (compaction race).
      // Reject rather than risk a duplicate append.
      throw new EntityConflictError(conflictMessage);
    }
    const canonicalEventId = kvValueToString(claimEntry.value);
    const canonicalEvent = await getLiveEntry(eventsBucket, canonicalEventId);
    if (canonicalEvent) {
      throw new EntityConflictError(conflictMessage);
    }
    // The winner crashed (or is mid-flight) between claim and event write:
    // complete the write under its id. putEvent to the same key is
    // idempotent, so both racers produce a single canonical row.
    return canonicalEventId;
  }

  /**
   * Load all events for a run. Uses the events-by-run index when populated,
   * falling back to a full live scan for events written before the index
   * existed. Returned events are unsorted.
   */
  async function loadEventsForRun(runId: string): Promise<Event[]> {
    const events: Event[] = [];
    const eventIds = await collectIndexKeys(eventsByRunBucket, `${runId}.`);
    if (eventIds.length > 0) {
      for (const eventId of eventIds) {
        const entry = await getLiveEntry(eventsBucket, eventId);
        if (!entry) continue;
        events.push(parse<Event>(kvValueToString(entry.value)));
      }
    } else {
      for await (const entry of listLiveEntries(eventsBucket)) {
        const event = parse<Event>(kvValueToString(entry.value));
        if (event.runId === runId) events.push(event);
      }
    }
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
    eventId: string,
    data: CreateEventRequest | RunCreatedEventRequest,
    currentRun: { status: string; specVersion?: number },
    params?: { resolveData?: ResolveData },
  ): Promise<EventResult> {
    await initBuckets();
    const resolveData = params?.resolveData ?? 'all';

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
            run: filterRunData(parsed, resolveData) as WorkflowRun,
          };
        }
        return {};
      }

      case 'wait_completed':
      case 'hook_received': {
        const createdAt = new Date();
        const event: Event = {
          ...data,
          runId,
          eventId,
          createdAt,
          specVersion: SPEC_VERSION_CURRENT,
        };

        await putEvent(runId, eventId, event);
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
      data: CreateEventRequest | RunCreatedEventRequest,
      params?: CreateEventParams,
    ): Promise<EventResult> {
      await initBuckets();

      // `let`: a delivery that loses the creation-claim arbitration adopts
      // the winner's canonical eventId instead of appending under its own.
      let eventId = `wevt_${ulid()}`;
      let adoptedCreatedAt: Date | undefined;
      const now = new Date();

      // Adopt a canonical eventId elected by claimCreationEvent. The
      // timestamp is re-derived from the winner's ULID so both racers
      // persist an identical canonical row.
      const adoptCanonicalEventId = (canonicalEventId: string) => {
        if (canonicalEventId !== eventId) {
          eventId = canonicalEventId;
          adoptedCreatedAt = new Date(idTime(canonicalEventId));
        }
      };

      // For run_created events, generate runId server-side if null or empty
      let effectiveRunId: string;
      if (data.eventType === 'run_created' && (!runId || runId === '')) {
        effectiveRunId = `wrun_${ulid()}`;
      } else if (!runId) {
        throw new Error('runId is required for non-run_created events');
      } else {
        effectiveRunId = runId;
      }

      const effectiveSpecVersion = data.specVersion ?? SPEC_VERSION_CURRENT;

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
            // Create synthetic run_created event
            const runCreatedEventId = `wevt_${ulid()}`;
            const runCreatedEvent = {
              eventType: 'run_created' as const,
              eventData: {
                deploymentId: runInputData.deploymentId,
                workflowName: runInputData.workflowName,
                input: runInputData.input,
                executionContext: runInputData.executionContext,
              },
              runId: effectiveRunId,
              eventId: runCreatedEventId,
              createdAt: now,
              specVersion: effectiveSpecVersion,
            };
            await putEvent(effectiveRunId, runCreatedEventId, runCreatedEvent);
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
          throw new (await import('@workflow/errors')).RunNotSupportedError(
            currentRun.specVersion!,
            SPEC_VERSION_CURRENT,
          );
        }

        if (isLegacySpecVersion(currentRun.specVersion)) {
          return handleLegacyEvent(effectiveRunId, eventId, data, currentRun, params);
        }
      }

      // Run terminal state validation
      if (currentRun && isRunTerminal(currentRun.status)) {
        const runTerminalEvents = ['run_started', 'run_completed', 'run_failed'];

        // Idempotent operation
        if (data.eventType === 'run_cancelled' && currentRun.status === 'cancelled') {
          const fullRunEntry = await getLiveEntry(runsBucket, effectiveRunId);
          const createdAt = new Date();
          const event = {
            ...data,
            runId: effectiveRunId,
            eventId,
            createdAt,
            specVersion: effectiveSpecVersion,
          };
          await putEvent(effectiveRunId, eventId, event);

          const parsed = EventSchema.parse(event);
          const resolveData = params?.resolveData ?? 'all';
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

        // Creating new entities on terminal runs is not allowed
        if (
          data.eventType === 'step_created' ||
          data.eventType === 'hook_created' ||
          data.eventType === 'wait_created'
        ) {
          throw new EntityConflictError(
            `Cannot create new entities on run in terminal state "${currentRun.status}"`,
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

        if (!validatedStep) {
          throw new WorkflowWorldError(`Step "${data.correlationId}" not found`, { status: 404 });
        }

        // Core catches EntityConflictError by name to gracefully skip an
        // already-terminal step and re-enqueue the workflow.
        if (isStepTerminal(validatedStep.status)) {
          throw new EntityConflictError(
            `Cannot modify step in terminal state "${validatedStep.status}"`,
          );
        }

        if (currentRun && isRunTerminal(currentRun.status)) {
          if (validatedStep.status !== 'running') {
            throw new RunExpiredError(
              `Cannot modify non-running step on run in terminal state "${currentRun.status}"`,
            );
          }
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

      // Reject a replay-origin create whose snapshot predates the newest
      // externally-originated event; equal passes, absent disables the guard.
      // Checked here, as close to the write as a multi-bucket KV store allows.
      if (params?.stateUpdatedAt !== undefined) {
        const marker = await readStateMarker(effectiveRunId);
        if (marker !== null && params.stateUpdatedAt < marker) {
          throw new PreconditionFailedError(
            `Event log for run "${effectiveRunId}" changed since ` +
              `${new Date(params.stateUpdatedAt).toISOString()}: a newer externally-originated ` +
              `event was recorded at ${new Date(marker).toISOString()}`,
          );
        }
      }

      // Entity creation/updates
      if (data.eventType === 'run_created') {
        const eventData = data.eventData as {
          deploymentId: string;
          workflowName: string;
          input: unknown[];
          executionContext?: Record<string, unknown>;
        };

        const newRun = {
          runId: effectiveRunId,
          deploymentId: eventData.deploymentId,
          workflowName: eventData.workflowName,
          specVersion: effectiveSpecVersion,
          input: eventData.input,
          executionContext: eventData.executionContext,
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
          const resolveData = params?.resolveData ?? 'all';
          // The ceiling must ride every `run_started` response, not just the
          // first: the runtime re-reads it on each replay and drops the limit
          // entirely when it is absent.
          return {
            run: run ? (filterRunData(run, resolveData) as WorkflowRun) : undefined,
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
          const resolveData = params?.resolveData ?? 'all';
          return {
            run: filterRunData(parsedRun, resolveData) as WorkflowRun,
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
        const eventData = data.eventData as {
          error: string | { message?: string; stack?: string };
          errorCode?: string;
        };
        const errorMessage =
          typeof eventData.error === 'string'
            ? eventData.error
            : (eventData.error?.message ?? 'Unknown error');
        const errorStack = typeof eventData.error === 'string' ? undefined : eventData.error?.stack;

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
              error: {
                message: errorMessage,
                stack: errorStack,
                code: eventData.errorCode,
              },
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

      if (data.eventType === 'step_created') {
        const eventData = data.eventData as {
          stepName: string;
          input: unknown;
        };

        const newStep = {
          runId: effectiveRunId,
          stepId: data.correlationId!,
          stepName: eventData.stepName,
          input: eventData.input,
          status: 'pending' as const,
          attempt: 0,
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
        // The claims bucket elects ONE canonical eventId for this creation:
        // a true duplicate rejects here with EntityConflictError, while a
        // delivery racing a crashed (or in-flight) winner adopts the
        // canonical id, so the event write below is idempotent.
        adoptCanonicalEventId(
          await claimCreationEvent(
            effectiveRunId,
            data.correlationId!,
            'step_created',
            eventId,
            !created,
            `Step "${data.correlationId}" already exists`,
          ),
        );
        if (created) {
          await indexStep(effectiveRunId, data.correlationId!);
          step = StepSchema.parse(compact(newStep));
        } else {
          // Crash orphan (entity written, event write lost): reuse the
          // existing entity and fall through to the event write below, which
          // completes the partial write under the canonical eventId.
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

      if (data.eventType === 'step_started') {
        const stepKey = `${effectiveRunId}.${data.correlationId}`;
        const result = await casMutate<Step>(stepsBucket, stepKey, (existing) => {
          if (isStepTerminal(existing.status)) {
            throw new EntityConflictError(
              `Cannot modify step in terminal state "${existing.status}"`,
            );
          }
          if (currentRun && isRunTerminal(currentRun.status) && existing.status !== 'running') {
            throw new RunExpiredError(
              `Cannot modify non-running step on run in terminal state "${currentRun.status}"`,
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
        const eventData = data.eventData as {
          error?: string | { message?: string };
          stack?: string;
        };
        const errorMessage =
          typeof eventData.error === 'string'
            ? eventData.error
            : (eventData.error?.message ?? 'Unknown error');

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
              error: {
                message: errorMessage,
                stack: eventData.stack,
              },
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
        const eventData = data.eventData as {
          error?: string | { message?: string };
          stack?: string;
          retryAfter?: Date;
        };
        const errorMessage =
          typeof eventData.error === 'string'
            ? eventData.error
            : (eventData.error?.message ?? 'Unknown error');

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
              error: {
                message: errorMessage,
                stack: eventData.stack,
              },
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
          const createdAt = new Date();
          const conflictEvent = {
            eventType: 'hook_conflict' as const,
            correlationId: data.correlationId,
            eventData: conflictEventData,
            runId: effectiveRunId,
            eventId,
            createdAt,
            specVersion: effectiveSpecVersion,
          };

          await putEvent(effectiveRunId, eventId, conflictEvent);

          const parsedConflict = EventSchema.parse(conflictEvent);
          const resolveData = params?.resolveData ?? 'all';
          return {
            event: stripEventDataRefs(parsedConflict, resolveData),
            run,
            step,
            hook: undefined,
          };
        }

        if (tokenOutcome === 'same-hook') {
          // The *same* (runId, hookId) already holds this token: a replayed
          // hook_created, or an orphan from a crash between the entity and
          // event writes. The claims bucket arbitrates: a true duplicate
          // throws EntityConflictError (so the runtime's replay catch path
          // swallows it instead of logging a self hook_conflict), an orphan
          // adopts the canonical id and completes the write below.
          adoptCanonicalEventId(
            await claimCreationEvent(
              effectiveRunId,
              hookId,
              'hook_created',
              eventId,
              true,
              `Hook "${hookId}" already created`,
            ),
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
          adoptCanonicalEventId(
            await claimCreationEvent(
              effectiveRunId,
              hookId,
              'hook_created',
              eventId,
              false,
              `Hook "${hookId}" already created`,
            ),
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
        // a racer adopts the canonical eventId and completes the write.
        adoptCanonicalEventId(
          await claimCreationEvent(
            effectiveRunId,
            data.correlationId!,
            'wait_created',
            eventId,
            !created,
            `Wait "${data.correlationId}" already exists`,
          ),
        );
        if (created) {
          wait = WaitSchema.parse(compact(newWait));
        } else {
          // Crash orphan: reuse the existing entity; the event write below
          // completes the partial write under the canonical eventId.
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

      // Store the event. An adopted (canonical) eventId carries the winner's
      // ULID-derived timestamp so racing deliveries write identical rows.
      const createdAt = adoptedCreatedAt ?? new Date();
      const event = {
        ...data,
        runId: effectiveRunId,
        eventId,
        createdAt,
        specVersion: effectiveSpecVersion,
      };

      // Strip eventData from run_started events before storage
      if (data.eventType === 'run_started') {
        delete (event as { eventData?: unknown }).eventData;
      }

      await putEvent(effectiveRunId, eventId, event);

      // Only externally-originated events advance the marker; advancing on the
      // lifecycle events core sends unguarded would reject every replay. Advanced
      // only after the event is durable, or the marker outruns the log.
      if (
        params?.stateUpdatedAt === undefined &&
        (data.eventType === 'hook_received' || data.eventType === 'step_completed')
      ) {
        await advanceStateMarker(effectiveRunId, idTime(eventId));
      }

      const parsed = EventSchema.parse(event);
      const resolveData = params?.resolveData ?? 'all';

      // Preload all events for run_started to reduce TTFB
      let allEvents: Event[] | undefined;
      if (data.eventType === 'run_started' && run) {
        const eventsList = await loadEventsForRun(effectiveRunId);
        // Sort by eventId ascending (monotonic ULIDs, the log order)
        eventsList.sort((a, b) => compareIds(a.eventId, b.eventId));
        allEvents = eventsList.map((e) =>
          stripEventDataRefs(EventSchema.parse(compact(e)), resolveData),
        );
      }

      return {
        event: stripEventDataRefs(parsed, resolveData),
        run,
        step,
        hook,
        wait,
        events: allEvents,
        // Preloaded events are complete; expose a cursor with the same
        // semantics as events.list so the runtime can reload incrementally.
        ...(allEvents ? { cursor: allEvents.at(-1)?.eventId ?? null, hasMore: false } : {}),
        // The runtime reads the per-run event ceiling from the `run_started`
        // response and nowhere else.
        ...(data.eventType === 'run_started' && run
          ? { maxEvents: resolveMaxEventsPerRun(maxEventsPerRun) }
          : {}),
      };
    },

    async get(runId: string, eventId: string, params?: GetEventParams): Promise<Event> {
      await initBuckets();
      const entry = await getLiveEntry(eventsBucket, eventId);
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

      const events = await loadEventsForRun(params.runId);

      // Sort by eventId (monotonic ULIDs, the log order)
      if (sortOrder === 'asc') {
        events.sort((a, b) => compareIds(a.eventId, b.eventId));
      } else {
        events.sort((a, b) => compareIds(b.eventId, a.eventId));
      }

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

      const events: Event[] = [];

      if (params.runId !== undefined) {
        // A correlationId is only unique within its run, so an unscoped
        // lookup can return a sibling run's events under the same id. Core
        // sends runId from 4.5.0 on; it stays optional for older callers.
        // The events-by-run index makes the scoped read targeted instead of
        // a full bucket scan, and filtering here (before the cursor and
        // limit are applied) keeps cursor and hasMore honest.
        for (const event of await loadEventsForRun(params.runId)) {
          if (event.correlationId === params.correlationId) {
            events.push(event);
          }
        }
      } else {
        // correlationIds are not indexed; scan live entries (one per event)
        for await (const entry of listLiveEntries(eventsBucket)) {
          const data = kvValueToString(entry.value);
          const event = parse<Event>(data);

          if (event.correlationId === params.correlationId) {
            events.push(event);
          }
        }
      }

      // Sort by eventId (monotonic ULIDs, the log order)
      if (sortOrder === 'asc') {
        events.sort((a, b) => compareIds(a.eventId, b.eventId));
      } else {
        events.sort((a, b) => compareIds(b.eventId, a.eventId));
      }

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

  const initBuckets = async () => {
    if (!stepsBucket) {
      const jetstream = await getJetStream();
      stepsBucket = await jetstream.views.kv(`${keyPrefix}steps`, {
        history: 10,
      });
      stepsByRunBucket = await jetstream.views.kv(`${keyPrefix}steps_by_run`, {
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

  const initBuckets = async () => {
    if (!hooksBucket) {
      const jetstream = await getJetStream();
      hooksBucket = await jetstream.views.kv(`${keyPrefix}hooks`, {
        history: 10,
      });
      hooksTokenBucket = await jetstream.views.kv(`${keyPrefix}hooks_by_token`, {
        history: 1,
      });
      hooksByRunBucket = await jetstream.views.kv(`${keyPrefix}hooks_by_run`, {
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
  const runsBucket = await jetstream.views.kv(`${keyPrefix}runs`, { history: 10 });
  const runsByStatusBucket = await jetstream.views.kv(`${keyPrefix}runs_by_status`, { history: 1 });
  const stepsBucket = await jetstream.views.kv(`${keyPrefix}steps`, { history: 10 });
  const stepsByRunBucket = await jetstream.views.kv(`${keyPrefix}steps_by_run`, { history: 1 });
  const hooksBucket = await jetstream.views.kv(`${keyPrefix}hooks`, { history: 10 });
  const hooksByRunBucket = await jetstream.views.kv(`${keyPrefix}hooks_by_run`, { history: 1 });
  const hooksTokenBucket = await jetstream.views.kv(`${keyPrefix}hooks_by_token`, { history: 1 });
  const eventsBucket = await jetstream.views.kv(`${keyPrefix}events`, { history: 10 });
  const eventsByRunBucket = await jetstream.views.kv(`${keyPrefix}events_by_run`, { history: 1 });
  const waitsBucket = await jetstream.views.kv(`${keyPrefix}waits`, { history: 1 });
  const runStateMarkersBucket = await jetstream.views.kv(`${keyPrefix}run_state_markers`, {
    history: 1,
  });
  const creationClaimsBucket = await jetstream.views.kv(`${keyPrefix}creation_claims`, {
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

        // Delete the run's optimistic-concurrency marker
        try {
          await runStateMarkersBucket.delete(runId);
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

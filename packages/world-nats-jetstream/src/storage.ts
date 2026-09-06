import { setTimeout as delay } from 'node:timers/promises';
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
  isHookEventRequiringExistence,
  isLegacySpecVersion,
  isStepEventType,
  isTerminalRunEventType,
  isTerminalStepStatus,
  isTerminalWorkflowRunStatus,
  requiresNewerWorld,
  slotToEventId,
  SPEC_VERSION_CURRENT,
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

/** True when a KV create/update failed because the revision precondition was
 * violated, i.e. the key already exists (create) or moved (update). */
function isWrongLastSequence(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const apiError = (err as Error & { api_error?: { err_code?: number } }).api_error;
  return apiError?.err_code === 10071 || err.message.includes('wrong last sequence');
}

/** Atomic create; false means the key already exists. Infra errors rethrow:
 * misreading them as "taken" would walk the slot probe past real holes. */
async function tryCreate(bucket: KV, key: string, value: string): Promise<boolean> {
  try {
    await bucket.create(key, value);
    return true;
  } catch (err) {
    if (isWrongLastSequence(err)) return false;
    throw err;
  }
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

/** Compare two fixed-width IDs (slot event ids, ULID run ids) lexicographically. */
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

/** An event object as persisted (before schema validation). */
interface StoredEventShape {
  eventType: string;
  runId: string;
  eventId: string;
  createdAt: Date;
  specVersion: number;
  correlationId?: string;
  eventData?: unknown;
}

/** Events live at `<runId>.<eventId>` so the run's log is one prefix scan
 * and fixed-width slot ids make key order the log order. */
function eventKey(runId: string, eventId: string): string {
  return `${runId}.${eventId}`;
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
  const initBuckets = () =>
    (bucketsReady ??= (async () => {
      const jetstream = await getJetStream();
      runsBucket = await new Kvm(jetstream).create(`${keyPrefix}runs`, {
        history: 10,
      });
      runsByStatusBucket = await new Kvm(jetstream).create(`${keyPrefix}runs_by_status`, {
        history: 1,
      });
    })());

  const experimentalSetAttributes: NonNullable<Storage['runs']['experimentalSetAttributes']> =
    async (runId, changes, options) => {
      await initBuckets();
      let attributes: Record<string, string> = {};
      const result = await casMutate<WorkflowRun>(runsBucket, runId, (existing) => {
        const currentAttributes = existing.attributes ?? {};
        validateAttributeChanges(changes, {
          existingKeys: Object.keys(currentAttributes),
          allowReservedAttributes: options?.allowReservedAttributes === true,
        });
        attributes = applyAttributeChanges(currentAttributes, changes);
        return {
          write: true,
          value: { ...existing, attributes, updatedAt: new Date() },
        };
      });
      if (result.type === 'missing') {
        throw new WorkflowRunNotFoundError(runId);
      }
      return { attributes };
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

    experimentalSetAttributes,
  };
}

// ---------------------------------------------------------------------------
// Events storage
// ---------------------------------------------------------------------------

/** Bound on slot probes for one append. Each losing probe means another
 * writer committed that slot, so the bound is only reachable under
 * pathological sustained contention. */
const MAX_SLOT_PROBES = 4096;

/** Claim-arbitration states; anything else stored in a claim is the
 * committed creation event's id. */
const CLAIM_PENDING = 'pending';
const CLAIM_HEALING = 'healing';
const CLAIM_POLL_INTERVAL_MS = 25;
const CLAIM_POLL_TIMEOUT_MS = 3_000;

/**
 * Create storage for workflow events using JetStream KV Store
 */
export function createEventsStorage(config: NatsStorageConfig): Storage['events'] {
  const { getJetStream, keyPrefix } = config;
  const ulid = monotonicFactory();
  const maxEventsPerRun = resolveMaxEventsPerRun(config.maxEventsPerRun);

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
  // Advisory per-run event counter: probe start for slot allocation. Only
  // advanced after a commit, so it never exceeds the true log length and a
  // stale value only costs extra probes, never density.
  let eventCountsBucket: KV;
  // Exactly-once arbiter for entity-creating events: one creation event per
  // (runId, correlationId, eventType), elected via atomic create(). The NATS
  // equivalent of world-postgres's entity-creation unique index. Also holds
  // the attr_set dedup claims.
  let creationClaimsBucket: KV;

  // Memoized: a caller arriving mid-init must wait for every bucket, not
  // skip init because the first bucket variable is already assigned.
  let bucketsReady: Promise<void> | undefined;
  const initBuckets = () =>
    (bucketsReady ??= (async () => {
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
      eventCountsBucket = await new Kvm(jetstream).create(`${keyPrefix}event_counts`, {
        history: 1,
      });
      creationClaimsBucket = await new Kvm(jetstream).create(`${keyPrefix}creation_claims`, {
        history: 1,
      });
    })());

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
  // Slot allocation
  // ------------------------------------------------------------------

  /** The run's committed event count: the advisory counter, or (cold counter)
   * the max slot found in the stored log. Never overstates the log. */
  async function readEventCount(runId: string): Promise<number> {
    const entry = await getLiveEntry(eventCountsBucket, runId);
    if (entry) {
      const count = Number(kvValueToString(entry.value));
      if (!Number.isInteger(count) || count < 0) {
        throw new WorkflowWorldError(`Corrupt event counter for run "${runId}"`, { status: 500 });
      }
      return count;
    }
    let max = 0;
    for (const eventId of await collectIndexKeys(eventsBucket, `${runId}.`)) {
      const slot = eventIdToSlot(eventId);
      if (slot !== null && slot > max) max = slot;
    }
    return max;
  }

  /** Advance the advisory counter to `slot`, forward-only. Best effort: the
   * committed event is the truth, a stale counter only costs probes. */
  async function advanceEventCount(runId: string, slot: number): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const entry = await getLiveEntry(eventCountsBucket, runId);
      if (!entry) {
        if (await tryCreate(eventCountsBucket, runId, `${slot}`)) return;
        continue;
      }
      const current = Number(kvValueToString(entry.value));
      if (Number.isInteger(current) && current >= slot) return;
      try {
        await eventCountsBucket.update(runId, `${slot}`, entry.revision);
        return;
      } catch (err) {
        if (!isWrongLastSequence(err)) throw err;
      }
    }
    debug(`event counter for ${runId} not advanced to ${slot}; next append re-probes`);
  }

  /**
   * Append an event at the next free slot of the run's log.
   *
   * The slot is taken by the same KV `create()` that lands the event: the
   * key `<runId>.<slotToEventId(slot)>` can be created exactly once, so two
   * concurrent appends can never share a position. A losing probe means the
   * store advanced; the loser takes the next position, keeping the log dense
   * from slot 1 (the probe start never exceeds the committed count + 1).
   */
  async function appendEventAtNextSlot(
    event: Omit<StoredEventShape, 'eventId'>,
  ): Promise<StoredEventShape> {
    const start = (await readEventCount(event.runId)) + FIRST_EVENT_SLOT;
    for (let slot = start; slot < start + MAX_SLOT_PROBES; slot++) {
      const eventId = slotToEventId(slot);
      const stored: StoredEventShape = { ...event, eventId };
      if (await tryCreate(eventsBucket, eventKey(event.runId, eventId), stringify(stored))) {
        await advanceEventCount(event.runId, slot);
        return stored;
      }
    }
    throw new WorkflowWorldError(
      `Slot contention on run "${event.runId}" did not settle after ${MAX_SLOT_PROBES} probes`,
      { status: 409 },
    );
  }

  type CreationOutcome = { type: 'appended'; event: StoredEventShape } | { type: 'exists' };

  /**
   * Exactly-once gate for a creation event: the atomic claim `create()`
   * elects one appender per (runId, correlationId, eventType); everyone else
   * observes the committed event id ('exists'). A claim stuck at 'pending'
   * past the poll window means the winner crashed between claim and append;
   * one healer takes over via revision CAS and completes the append. A claim
   * stuck at 'healing' means the healer crashed too: give up with 'exists'
   * rather than risk a duplicate append.
   */
  async function ensureCreationEvent(
    runId: string,
    claimSuffix: string,
    append: () => Promise<StoredEventShape>,
  ): Promise<CreationOutcome> {
    const claimKey = `${runId}.${claimSuffix}`;
    if (await tryCreate(creationClaimsBucket, claimKey, CLAIM_PENDING)) {
      const event = await append();
      await creationClaimsBucket.put(claimKey, event.eventId);
      return { type: 'appended', event };
    }
    let deadline = Date.now() + CLAIM_POLL_TIMEOUT_MS;
    let sawHealing = false;
    for (;;) {
      const entry = await getLiveEntry(creationClaimsBucket, claimKey);
      if (!entry) {
        // Tombstoned between create() and get() (compaction race): reject
        // rather than risk a duplicate append.
        return { type: 'exists' };
      }
      const value = kvValueToString(entry.value);
      if (value !== CLAIM_PENDING && value !== CLAIM_HEALING) {
        return { type: 'exists' };
      }
      if (value === CLAIM_HEALING && !sawHealing) {
        sawHealing = true;
        deadline = Date.now() + CLAIM_POLL_TIMEOUT_MS;
      }
      if (Date.now() >= deadline) {
        if (sawHealing) return { type: 'exists' };
        try {
          await creationClaimsBucket.update(claimKey, CLAIM_HEALING, entry.revision);
        } catch (err) {
          if (!isWrongLastSequence(err)) throw err;
          continue; // another delivery moved the claim; re-read
        }
        const event = await append();
        await creationClaimsBucket.put(claimKey, event.eventId);
        return { type: 'appended', event };
      }
      await delay(CLAIM_POLL_INTERVAL_MS);
    }
  }

  /**
   * Load all events for a run via one prefix scan over the per-run keys.
   * Returned events are unsorted.
   */
  async function loadEventsForRun(runId: string): Promise<Event[]> {
    const events: Event[] = [];
    const eventIds = await collectIndexKeys(eventsBucket, `${runId}.`);
    // Batched: a serial per-event loop cost N sequential KV round trips.
    const entries = await Promise.all(
      eventIds.map((eventId) => getLiveEntry(eventsBucket, eventKey(runId, eventId))),
    );
    for (const entry of entries) {
      if (!entry) continue;
      events.push(parse<Event>(kvValueToString(entry.value)));
    }
    return events;
  }

  /** The full replay page returned on `run_started`, sorted in log order. */
  async function preloadAllEvents(
    runId: string,
    resolveData: ResolveData,
  ): Promise<{ events: Event[]; cursor: string | null; hasMore: boolean }> {
    const eventsList = await loadEventsForRun(runId);
    eventsList.sort((a, b) => compareIds(a.eventId, b.eventId));
    const events = eventsList.map((e) =>
      stripEventDataRefs(EventSchema.parse(compact(e)), resolveData),
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
    const runId = result.event.runId;
    const entries = await Promise.all(
      Array.from({ length: span }, (_, i) =>
        getLiveEntry(eventsBucket, eventKey(runId, slotToEventId(askedFor + 1 + i))),
      ),
    );
    const events: Event[] = [];
    for (const entry of entries) {
      if (!entry) continue;
      const parsed = EventSchema.parse(compact(parse<Event>(kvValueToString(entry.value))));
      events.push(stripEventDataRefs(parsed, resolveData));
    }
    return {
      ...result,
      events,
      cursor: null,
      hasMore: events.length < span,
    };
  }

  // Helper: Clean up hooks when run reaches terminal status
  async function cleanupHooks(runId: string): Promise<void> {
    await initBuckets();

    const hookIds = await collectIndexKeys(hooksByRunBucket, `${runId}.`);
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
   * Handle events for legacy runs (pre-event-sourcing, specVersion <= 1).
   * Legacy runs keep their `wevt_` ULID event ids; slot allocation never
   * applies to them.
   */
  async function handleLegacyEvent(
    runId: string,
    data: CreateEventRequest | RunCreatedEventRequest,
    currentRun: { status: string; specVersion?: number },
    params?: { resolveData?: ResolveData },
  ): Promise<EventResult> {
    await initBuckets();
    const resolveData = params?.resolveData ?? 'all';
    const eventId = `wevt_${ulid()}`;

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
        const event: StoredEventShape = {
          ...data,
          runId,
          eventId,
          createdAt,
          specVersion: SPEC_VERSION_CURRENT,
        };

        await eventsBucket.put(eventKey(runId, eventId), stringify(event));
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

  async function createImpl(
    runId: string | null,
    data: CreateEventRequest | RunCreatedEventRequest,
    params?: CreateEventParams,
  ): Promise<EventResult> {
    await initBuckets();
    const now = new Date();
    const resolveData = params?.resolveData ?? 'all';

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
    // Set when a lazy step_started atomically created its step: the runtime's
    // exactly-once inline-execution ownership signal.
    let stepCreatedLazily = false;

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
    if (data.eventType === 'run_started' && !currentRun && 'eventData' in data && data.eventData) {
      const runInputData = data.eventData;
      if (
        runInputData.deploymentId &&
        runInputData.workflowName &&
        runInputData.input !== undefined
      ) {
        validateAttributeChanges(
          Object.entries(runInputData.attributes ?? {}).map(([key, value]) => ({ key, value })),
          { allowReservedAttributes: runInputData.allowReservedAttributes === true },
        );
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
          attributes: runInputData.attributes ?? {},
          encryptionPublicKey: runInputData.encryptionPublicKey,
          createdAt: now,
          updatedAt: now,
        };
        const runCreatedBody: Omit<StoredEventShape, 'eventId'> = {
          eventType: 'run_created',
          eventData: {
            deploymentId: runInputData.deploymentId,
            workflowName: runInputData.workflowName,
            input: runInputData.input,
            executionContext: runInputData.executionContext,
            attributes: runInputData.attributes,
            allowReservedAttributes: runInputData.allowReservedAttributes,
            encryptionPublicKey: runInputData.encryptionPublicKey,
          },
          runId: effectiveRunId,
          createdAt: now,
          specVersion: effectiveSpecVersion,
        };
        // Atomically create the run so only the first writer wins. This
        // prevents a TOCTOU race where a concurrent run_created from
        // start() (which runs in parallel with the queue publish) could
        // overwrite a run that was already transitioned to 'running'.
        const created = await tryCreate(runsBucket, effectiveRunId, stringify(newRun));
        if (created) {
          await indexRunStatus(effectiveRunId, 'pending');
          // The synthetic run_created lands before the run_started appended
          // below, so it takes the earlier slot and replays first. The claim
          // makes it exactly-once against a concurrent run_created writer.
          await ensureCreationEvent(effectiveRunId, `__run__.run_created`, () =>
            appendEventAtNextSlot(runCreatedBody),
          );
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
          // Heal a run_created writer that crashed between its entity create
          // and its event append: the claim protocol keeps this exactly-once.
          if ((await readEventCount(effectiveRunId)) === 0) {
            await ensureCreationEvent(effectiveRunId, `__run__.run_created`, () =>
              appendEventAtNextSlot(runCreatedBody),
            );
          }
        }
      }
    }

    // Match the first-party worlds: these events reject on a non-existent run
    // rather than persisting an orphan event.
    if (
      !currentRun &&
      (data.eventType === 'run_failed' ||
        data.eventType === 'attr_set' ||
        data.eventType === 'run_started')
    ) {
      throw new WorkflowRunNotFoundError(effectiveRunId);
    }

    // Version compatibility
    if (currentRun) {
      if (requiresNewerWorld(currentRun.specVersion)) {
        throw new RunNotSupportedError(currentRun.specVersion!, SPEC_VERSION_CURRENT);
      }

      if (isLegacySpecVersion(currentRun.specVersion)) {
        return handleLegacyEvent(effectiveRunId, data, currentRun, params);
      }
    }

    // Lazy step start: a step_started carrying step-creation data (stepName +
    // input) may arrive with no prior step_created and creates the step on
    // the fly, mirroring the resilient run_started path.
    const createsChildEntity = isChildEntityCreationEvent(data);
    const lazyStepStart = createsChildEntity && data.eventType === 'step_started';

    // Run terminal state validation
    if (currentRun && isTerminalWorkflowRunStatus(currentRun.status)) {
      // Idempotent operation
      if (data.eventType === 'run_cancelled' && currentRun.status === 'cancelled') {
        const fullRunEntry = await getLiveEntry(runsBucket, effectiveRunId);
        const stored = await appendEventAtNextSlot({
          ...data,
          runId: effectiveRunId,
          createdAt: new Date(),
          specVersion: effectiveSpecVersion,
        });

        const parsed = EventSchema.parse(stored);
        return {
          event: stripEventDataRefs(parsed, resolveData),
          run: fullRunEntry
            ? (filterRunData(
                WorkflowRunSchema.parse(
                  compact(parse<WorkflowRun>(kvValueToString(fullRunEntry.value))),
                ),
                resolveData,
              ) as WorkflowRun)
            : undefined,
          maxEvents: maxEventsPerRun,
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
      if (isTerminalRunEventType(data.eventType)) {
        throw new EntityConflictError(
          `Cannot transition run from terminal state "${currentRun.status}"`,
        );
      }

      // Creating new entities on terminal runs is not allowed. A lazy
      // step_started creates a step, so it is rejected here too.
      if (createsChildEntity) {
        throw new EntityConflictError(
          `Cannot create new entities on run in terminal state "${currentRun.status}"`,
        );
      }

      if (data.eventType === 'attr_set') {
        throw new EntityConflictError(
          `Cannot set attributes on run in terminal state "${currentRun.status}"`,
        );
      }
    }

    // Step-related event validation (ordering and terminal state). The CAS
    // mutators below re-run these guards against the freshest revision; this
    // pre-check exists to fail fast.
    let validatedStep: Step | null = null;
    const stepEventRequiresExistingStep =
      isStepEventType(data.eventType) && data.eventType !== 'step_created';
    if (stepEventRequiresExistingStep && data.correlationId) {
      const stepEntry = await getLiveEntry(stepsBucket, `${effectiveRunId}.${data.correlationId}`);
      if (stepEntry) {
        validatedStep = StepSchema.parse(
          compact(parse<Step>(kvValueToString(stepEntry.value))),
        );
      }

      if (!validatedStep && !lazyStepStart) {
        throw new WorkflowWorldError(`Step "${data.correlationId}" not found`, { status: 404 });
      }

      // Lazy start exactly-once gate: a lazy step_started always CREATES the
      // step. An existing step means a concurrent handler won the create;
      // EntityConflictError maps to `skipped` in the runtime's executeStep.
      if (lazyStepStart && validatedStep) {
        throw new EntityConflictError(`Step "${data.correlationId}" already created`);
      }

      if (validatedStep) {
        // Core catches EntityConflictError by name to gracefully skip an
        // already-terminal step and re-enqueue the workflow.
        if (isTerminalStepStatus(validatedStep.status)) {
          throw new EntityConflictError(
            `Cannot modify step in terminal state "${validatedStep.status}"`,
          );
        }

        if (currentRun && isTerminalWorkflowRunStatus(currentRun.status)) {
          if (validatedStep.status !== 'running') {
            throw new RunExpiredError(
              `Cannot modify non-running step on run in terminal state "${currentRun.status}"`,
            );
          }
        }
      }
    }

    // Hook validation. Core treats HookNotFoundError as a benign
    // "already disposed" signal during suspension replay.
    if (isHookEventRequiringExistence(data.eventType) && data.correlationId) {
      const existingHook = await getLiveEntry(hooksBucket, data.correlationId);
      if (!existingHook) {
        throw new HookNotFoundError(data.correlationId);
      }
    }

    // ============================================================
    // Entity creation events: the entity is created with an atomic KV
    // create() and the creation event is gated by the claims bucket, so
    // duplicates reject with EntityConflictError (which the runtime treats
    // as benign) instead of appending a second creation event.
    // ============================================================

    if (data.eventType === 'run_created') {
      const eventData = data.eventData;
      validateAttributeChanges(
        Object.entries(eventData.attributes ?? {}).map(([key, value]) => ({ key, value })),
        { allowReservedAttributes: eventData.allowReservedAttributes === true },
      );

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
        attributes: eventData.attributes ?? {},
        encryptionPublicKey: eventData.encryptionPublicKey,
        createdAt: now,
        updatedAt: now,
      };

      // Atomically create the run so only the first writer wins. A duplicate
      // run_created always rejects: core treats this 409 as benign on its
      // concurrent-create path ("the run already exists").
      const created = await tryCreate(runsBucket, effectiveRunId, stringify(newRun));
      if (!created) {
        throw new EntityConflictError(`Workflow run "${effectiveRunId}" already exists`);
      }
      await indexRunStatus(effectiveRunId, 'pending');
      run = WorkflowRunSchema.parse(compact(newRun));

      const outcome = await ensureCreationEvent(effectiveRunId, `__run__.run_created`, () =>
        appendEventAtNextSlot({
          ...data,
          runId: effectiveRunId,
          createdAt: now,
          specVersion: effectiveSpecVersion,
        }),
      );
      // 'exists' here means the resilient-start bootstrap healed the event
      // between our entity create and our claim; read it back from slot 1.
      const storedEvent =
        outcome.type === 'appended'
          ? outcome.event
          : await (async () => {
              const entry = await getLiveEntry(
                eventsBucket,
                eventKey(effectiveRunId, slotToEventId(FIRST_EVENT_SLOT)),
              );
              if (!entry) {
                throw new WorkflowWorldError(
                  `run_created event for "${effectiveRunId}" could not be read back`,
                  { status: 500 },
                );
              }
              return parse<StoredEventShape>(kvValueToString(entry.value));
            })();
      const parsed = EventSchema.parse(storedEvent);
      return {
        event: stripEventDataRefs(parsed, resolveData),
        run,
        maxEvents: maxEventsPerRun,
      };
    }

    if (data.eventType === 'step_created') {
      const eventData = data.eventData;

      const newStep = {
        runId: effectiveRunId,
        stepId: data.correlationId,
        stepName: eventData.stepName,
        input: eventData.input,
        status: 'pending' as const,
        attempt: 0,
        specVersion: effectiveSpecVersion,
        createdAt: now,
        updatedAt: now,
      };

      const stepKey = `${effectiveRunId}.${data.correlationId}`;
      const created = await tryCreate(stepsBucket, stepKey, stringify(newStep));
      const outcome = await ensureCreationEvent(
        effectiveRunId,
        `${data.correlationId}.step_created`,
        () =>
          appendEventAtNextSlot({
            ...data,
            runId: effectiveRunId,
            createdAt: now,
            specVersion: effectiveSpecVersion,
          }),
      );
      if (outcome.type === 'exists') {
        throw new EntityConflictError(`Step "${data.correlationId}" already exists`);
      }
      if (created) {
        await indexStep(effectiveRunId, data.correlationId);
        step = StepSchema.parse(compact(newStep));
      } else {
        // Crash orphan (entity written, event write lost): reuse the
        // existing entity; the claim elected us to complete the event.
        const existing = await getLiveEntry(stepsBucket, stepKey);
        if (!existing) {
          throw new WorkflowWorldError(
            `Step "${data.correlationId}" could not be created or read back`,
            { status: 500 },
          );
        }
        step = StepSchema.parse(compact(parse<Step>(kvValueToString(existing.value))));
      }
      const parsed = EventSchema.parse(outcome.event);
      return { event: stripEventDataRefs(parsed, resolveData), step };
    }

    if (data.eventType === 'hook_created') {
      const eventData = data.eventData;
      const hookId = data.correlationId;

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
          if (await tryCreate(hooksTokenBucket, eventData.token, hookId)) {
            tokenOutcome = 'claimed';
          }
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
        const conflictEvent = await appendEventAtNextSlot({
          eventType: 'hook_conflict',
          correlationId: data.correlationId,
          eventData: {
            token: eventData.token,
            conflictingRunId: tokenOutcome.conflictingRunId,
          },
          runId: effectiveRunId,
          createdAt: now,
          specVersion: effectiveSpecVersion,
        });

        const parsedConflict = EventSchema.parse(conflictEvent);
        return {
          event: stripEventDataRefs(parsedConflict, resolveData),
          hook: undefined,
        };
      }

      if (tokenOutcome === 'same-hook') {
        // The *same* (runId, hookId) already holds this token: a replayed
        // hook_created, or an orphan from a crash between the entity and
        // event writes. The claims bucket arbitrates: a true duplicate
        // throws EntityConflictError (so the runtime's replay catch path
        // swallows it), an orphan is healed by the claim winner.
        const outcome = await ensureCreationEvent(effectiveRunId, `${hookId}.hook_created`, () =>
          appendEventAtNextSlot({
            ...data,
            runId: effectiveRunId,
            createdAt: now,
            specVersion: effectiveSpecVersion,
          }),
        );
        if (outcome.type === 'exists') {
          throw new EntityConflictError(`Hook "${hookId}" already created`);
        }
        hook = HookSchema.parse(compact(existingHook!));
        const parsed = EventSchema.parse(outcome.event);
        return { event: stripEventDataRefs(parsed, resolveData), hook };
      }

      const newHook: Hook = {
        runId: effectiveRunId,
        hookId,
        token: eventData.token,
        ownerId: '',
        projectId: '',
        environment: '',
        metadata: eventData.metadata,
        specVersion: effectiveSpecVersion,
        createdAt: now,
        ...(eventData.isWebhook !== undefined ? { isWebhook: eventData.isWebhook } : {}),
        ...(eventData.isSystem !== undefined ? { isSystem: eventData.isSystem } : {}),
      };

      await hooksBucket.put(hookId, stringify(newHook));
      await indexHook(effectiveRunId, hookId);
      const outcome = await ensureCreationEvent(effectiveRunId, `${hookId}.hook_created`, () =>
        appendEventAtNextSlot({
          ...data,
          runId: effectiveRunId,
          createdAt: now,
          specVersion: effectiveSpecVersion,
        }),
      );
      if (outcome.type === 'exists') {
        throw new EntityConflictError(`Hook "${hookId}" already created`);
      }
      hook = HookSchema.parse(compact(newHook));
      const parsed = EventSchema.parse(outcome.event);
      return { event: stripEventDataRefs(parsed, resolveData), hook };
    }

    if (data.eventType === 'wait_created') {
      const eventData = data.eventData;
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
      const created = await tryCreate(waitsBucket, waitKey, stringify(newWait));
      const outcome = await ensureCreationEvent(
        effectiveRunId,
        `${data.correlationId}.wait_created`,
        () =>
          appendEventAtNextSlot({
            ...data,
            runId: effectiveRunId,
            createdAt: now,
            specVersion: effectiveSpecVersion,
          }),
      );
      if (outcome.type === 'exists') {
        throw new EntityConflictError(`Wait "${data.correlationId}" already exists`);
      }
      if (created) {
        wait = WaitSchema.parse(compact(newWait));
      } else {
        // Crash orphan: reuse the existing entity; the claim elected us to
        // complete the event write.
        const existing = await getLiveEntry(waitsBucket, waitKey);
        if (!existing) {
          throw new WorkflowWorldError(
            `Wait "${data.correlationId}" could not be created or read back`,
            { status: 500 },
          );
        }
        wait = WaitSchema.parse(compact(parse<Wait>(kvValueToString(existing.value))));
      }
      const parsed = EventSchema.parse(outcome.event);
      return { event: stripEventDataRefs(parsed, resolveData), wait };
    }

    // ============================================================
    // Entity transition events (entity updated via CAS, then the event is
    // appended by the generic store below)
    // ============================================================

    if (data.eventType === 'run_started') {
      // Idempotency: if run is already past pending, this is a replay.
      // Return existing run state without creating a duplicate event.
      if (currentRun?.status === 'running') {
        const entry = await getLiveEntry(runsBucket, effectiveRunId);
        if (!entry) {
          throw new WorkflowRunNotFoundError(effectiveRunId);
        }
        const parsedRun = WorkflowRunSchema.parse(
          compact(parse<WorkflowRun>(kvValueToString(entry.value))),
        );
        // The ceiling must ride every `run_started` response, not just the
        // first: the runtime re-reads it on each replay and drops the limit
        // entirely when it is absent.
        if (params?.skipPreload) {
          return {
            run: filterRunData(parsedRun, resolveData) as WorkflowRun,
            maxEvents: maxEventsPerRun,
          };
        }
        const preloaded = await preloadAllEvents(effectiveRunId, resolveData);
        return {
          run: filterRunData(parsedRun, resolveData) as WorkflowRun,
          events: preloaded.events,
          cursor: preloaded.cursor,
          hasMore: preloaded.hasMore,
          maxEvents: maxEventsPerRun,
        };
      }

      let oldStatus: string | undefined;
      const result = await casMutate<WorkflowRun>(runsBucket, effectiveRunId, (existing) => {
        if (isTerminalWorkflowRunStatus(existing.status)) {
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

      if (result.type === 'missing') {
        throw new WorkflowRunNotFoundError(effectiveRunId);
      }
      if (result.type === 'unchanged') {
        // A concurrent run_started won the CAS race; same replay
        // semantics as the pre-check above: no duplicate event.
        const parsedRun = WorkflowRunSchema.parse(compact(result.value));
        if (params?.skipPreload) {
          return {
            run: filterRunData(parsedRun, resolveData) as WorkflowRun,
            maxEvents: maxEventsPerRun,
          };
        }
        const preloaded = await preloadAllEvents(effectiveRunId, resolveData);
        return {
          run: filterRunData(parsedRun, resolveData) as WorkflowRun,
          events: preloaded.events,
          cursor: preloaded.cursor,
          hasMore: preloaded.hasMore,
          maxEvents: maxEventsPerRun,
        };
      }
      await reindexRunStatus(effectiveRunId, oldStatus, 'running');
      run = WorkflowRunSchema.parse(compact(result.value));
    }

    if (data.eventType === 'run_completed') {
      const eventData = data.eventData;
      let oldStatus: string | undefined;
      const result = await casMutate<WorkflowRun>(runsBucket, effectiveRunId, (existing) => {
        if (isTerminalWorkflowRunStatus(existing.status)) {
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
            output: eventData?.output,
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
      const eventData = data.eventData;
      let oldStatus: string | undefined;
      const result = await casMutate<WorkflowRun>(runsBucket, effectiveRunId, (existing) => {
        if (isTerminalWorkflowRunStatus(existing.status)) {
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
        if (isTerminalWorkflowRunStatus(existing.status)) {
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

    // attr_set: merge the changes onto the run entity via CAS. A
    // workflow-writer attr_set with a correlationId is deduplicated by an
    // atomic claim, so a replayed event cannot apply (or log) twice.
    if (data.eventType === 'attr_set') {
      const eventData = data.eventData;
      let claimed = false;
      for (let attempt = 0; ; attempt++) {
        if (attempt >= MAX_CAS_ATTEMPTS) {
          throw new WorkflowWorldError(`Concurrent update contention on run "${effectiveRunId}"`, {
            status: 500,
          });
        }
        const entry = await getLiveEntry(runsBucket, effectiveRunId);
        if (!entry) {
          throw new WorkflowRunNotFoundError(effectiveRunId);
        }
        const existing = parse<WorkflowRun>(kvValueToString(entry.value));
        validateAttributeChanges(eventData.changes, {
          existingKeys: Object.keys(existing.attributes ?? {}),
          allowReservedAttributes: eventData.allowReservedAttributes === true,
        });
        // Claim only after validation: a validation failure must leave the
        // correlationId unclaimed so a retry is not misreported as a dup.
        if (!claimed && data.correlationId && eventData.writer.type === 'workflow') {
          const won = await tryCreate(
            creationClaimsBucket,
            `${effectiveRunId}.${data.correlationId}.attr_set`,
            'claimed',
          );
          if (!won) {
            throw new EntityConflictError(
              `Attribute event "${data.correlationId}" already exists`,
            );
          }
          claimed = true;
        }
        const updated = {
          ...existing,
          attributes: applyAttributeChanges(existing.attributes ?? {}, eventData.changes),
          updatedAt: now,
        };
        try {
          await runsBucket.update(effectiveRunId, stringify(updated), entry.revision);
          run = WorkflowRunSchema.parse(compact(updated));
          break;
        } catch (err) {
          if (!isWrongLastSequence(err)) throw err;
          // Lost the race: re-read and re-apply.
        }
      }
    }

    // step_started: increment attempt, set status to 'running'. The lazy
    // path first creates the step (the entity create is the exactly-once
    // ownership claim) plus a synthetic step_created event at the prior slot.
    if (data.eventType === 'step_started' && data.correlationId) {
      const stepId = data.correlationId;
      const stepKey = `${effectiveRunId}.${stepId}`;
      if (!validatedStep && lazyStepStart) {
        const lazyData = data.eventData as { stepName: string; input: unknown };
        const newStep = {
          runId: effectiveRunId,
          stepId,
          stepName: lazyData.stepName,
          input: lazyData.input,
          status: 'pending' as const,
          attempt: 0,
          specVersion: effectiveSpecVersion,
          createdAt: now,
          updatedAt: now,
        };
        const created = await tryCreate(stepsBucket, stepKey, stringify(newStep));
        if (!created) {
          // A concurrent handler won the create claim: the runtime maps this
          // to `skipped`, so the loser never runs the step body.
          throw new EntityConflictError(`Step "${stepId}" already created`);
        }
        await indexStep(effectiveRunId, stepId);
        const outcome = await ensureCreationEvent(effectiveRunId, `${stepId}.step_created`, () =>
          appendEventAtNextSlot({
            eventType: 'step_created',
            runId: effectiveRunId,
            createdAt: now,
            specVersion: effectiveSpecVersion,
            correlationId: stepId,
            eventData: { stepName: lazyData.stepName, input: lazyData.input },
          }),
        );
        if (outcome.type === 'exists') {
          throw new EntityConflictError(`Step "${stepId}" already created`);
        }
        stepCreatedLazily = true;
      }
      const result = await casMutate<Step>(stepsBucket, stepKey, (existing) => {
        if (isTerminalStepStatus(existing.status)) {
          throw new EntityConflictError(
            `Cannot modify step in terminal state "${existing.status}"`,
          );
        }
        if (
          currentRun &&
          isTerminalWorkflowRunStatus(currentRun.status) &&
          existing.status !== 'running'
        ) {
          throw new RunExpiredError(
            `Cannot modify non-running step on run in terminal state "${currentRun.status}"`,
          );
        }
        // Retried steps may be scheduled for later. Core handles
        // TooEarlyError by re-enqueueing with the remaining backoff, so
        // configured retry delays are enforced at the storage layer.
        if (existing.retryAfter && existing.retryAfter.getTime() > Date.now()) {
          throw new TooEarlyError(
            `Cannot start step "${stepId}": retryAfter timestamp has not been reached yet`,
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
        throw new WorkflowWorldError(`Step "${stepId}" not found`, { status: 404 });
      }
      step = StepSchema.parse(compact(result.value));
    }

    if (data.eventType === 'step_completed' && data.correlationId) {
      const eventData = data.eventData;
      const result = await casMutate<Step>(
        stepsBucket,
        `${effectiveRunId}.${data.correlationId}`,
        (existing) => {
          if (isTerminalStepStatus(existing.status)) {
            throw new EntityConflictError(
              `Cannot modify step in terminal state "${existing.status}"`,
            );
          }
          return {
            write: true,
            value: {
              ...existing,
              status: 'completed' as const,
              output: eventData?.result,
              completedAt: now,
              updatedAt: now,
            },
          };
        },
      );
      if (result.type === 'missing') {
        throw new WorkflowWorldError(`Step "${data.correlationId}" not found`, { status: 404 });
      }
      step = StepSchema.parse(compact(result.value));
    }

    if (data.eventType === 'step_failed' && data.correlationId) {
      const eventData = data.eventData;
      const result = await casMutate<Step>(
        stepsBucket,
        `${effectiveRunId}.${data.correlationId}`,
        (existing) => {
          if (isTerminalStepStatus(existing.status)) {
            throw new EntityConflictError(
              `Cannot modify step in terminal state "${existing.status}"`,
            );
          }
          return {
            write: true,
            value: {
              ...existing,
              status: 'failed' as const,
              error: eventData.error,
              completedAt: now,
              updatedAt: now,
            },
          };
        },
      );
      if (result.type === 'missing') {
        throw new WorkflowWorldError(`Step "${data.correlationId}" not found`, { status: 404 });
      }
      step = StepSchema.parse(compact(result.value));
    }

    if (data.eventType === 'step_retrying' && data.correlationId) {
      const eventData = data.eventData;
      const result = await casMutate<Step>(
        stepsBucket,
        `${effectiveRunId}.${data.correlationId}`,
        (existing) => {
          if (isTerminalStepStatus(existing.status)) {
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
        },
      );
      if (result.type === 'missing') {
        throw new WorkflowWorldError(`Step "${data.correlationId}" not found`, { status: 404 });
      }
      step = StepSchema.parse(compact(result.value));
    }

    if (data.eventType === 'hook_disposed' && data.correlationId) {
      const hookEntry = await getLiveEntry(hooksBucket, data.correlationId);
      if (!hookEntry) {
        // The pre-validation above saw the hook; it vanished in between,
        // so a concurrent disposal won the race.
        throw new EntityConflictError(`Hook "${data.correlationId}" already disposed`);
      }
      const existingHook = parse<Hook>(kvValueToString(hookEntry.value));
      await hooksBucket.delete(data.correlationId);
      await hooksTokenBucket.delete(existingHook.token);
      await removeHookIndex(effectiveRunId, data.correlationId);
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

    // Store the event: the slot is allocated at this commit, so a terminal
    // event appended here dominates everything already in the log.
    const eventBody: Omit<StoredEventShape, 'eventId'> = {
      ...data,
      runId: effectiveRunId,
      createdAt: new Date(),
      specVersion: effectiveSpecVersion,
    };

    // Strip eventData from run_started events before storage
    if (data.eventType === 'run_started' && 'eventData' in eventBody) {
      delete (eventBody as { eventData?: unknown }).eventData;
    }

    const storedEvent = await appendEventAtNextSlot(eventBody);
    const parsed = EventSchema.parse(storedEvent);

    // Preload all events for run_started to reduce TTFB
    let eventPage: { events: Event[]; cursor: string | null; hasMore: boolean } | undefined;
    if (data.eventType === 'run_started' && run && !params?.skipPreload) {
      eventPage = await preloadAllEvents(effectiveRunId, resolveData);
    }

    const base: EventResult = {
      event: stripEventDataRefs(parsed, resolveData),
      run,
      step,
      hook,
      wait,
      ...(stepCreatedLazily ? { stepCreated: true as const } : {}),
      // Server-owned per-run event ceiling; the runtime enforces it. Only
      // meaningful when a run entity is attached (run-lifecycle responses).
      ...(run ? { maxEvents: maxEventsPerRun } : {}),
    };
    if (!eventPage) {
      return base;
    }
    return {
      ...base,
      events: eventPage.events,
      cursor: eventPage.cursor,
      hasMore: eventPage.hasMore,
    };
  }

  async function listEvents(params: ListEventsParams): Promise<PaginatedResponse<Event>> {
    await initBuckets();
    const limit = params?.pagination?.limit ?? 100;
    const sortOrder = params.pagination?.sortOrder || 'asc';
    const resolveData = params?.resolveData ?? 'all';

    const events = await loadEventsForRun(params.runId);

    // Sort by eventId (fixed-width slot ids, so string order is log order)
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
  }

  const create = (async (
    runId: string | null,
    data: CreateEventRequest | RunCreatedEventRequest,
    params?: CreateEventParams,
  ): Promise<EventResult> => {
    const result = await createImpl(runId, data, params);
    const resolveData = params?.resolveData ?? 'all';

    // Inline-delta optimization: the delta of events strictly after
    // `sinceCursor`, exactly what `events.list` would return right now. It
    // wins over the skipped-slot report (it is a strict superset and the
    // only one of the two that advances the caller's cursor).
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

  return {
    create,

    async get(runId: string, eventId: string, params?: GetEventParams): Promise<Event> {
      await initBuckets();
      const entry = await getLiveEntry(eventsBucket, eventKey(runId, eventId));
      if (!entry) {
        throw new WorkflowWorldError(`Event not found: ${eventId}`, {
          status: 404,
        });
      }
      const event = parse<Event>(kvValueToString(entry.value));
      const parsed = EventSchema.parse(compact(event));
      return stripEventDataRefs(parsed, params?.resolveData ?? 'all');
    },

    list: listEvents,

    async listByCorrelationId(
      params: ListEventsByCorrelationIdParams,
    ): Promise<PaginatedResponse<Event>> {
      await initBuckets();
      const limit = params?.pagination?.limit ?? 100;
      const sortOrder = params.pagination?.sortOrder || 'asc';
      const resolveData = params?.resolveData ?? 'all';

      // A correlation id identifies a step/hook/wait within its run, so the
      // lookup is scoped by run; the per-run key prefix makes it targeted.
      const events: Event[] = [];
      for (const event of await loadEventsForRun(params.runId)) {
        if (event.correlationId === params.correlationId) {
          events.push(event);
        }
      }

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

  let bucketsReady: Promise<void> | undefined;
  const initBuckets = () =>
    (bucketsReady ??= (async () => {
      const jetstream = await getJetStream();
      stepsBucket = await new Kvm(jetstream).create(`${keyPrefix}steps`, {
        history: 10,
      });
      stepsByRunBucket = await new Kvm(jetstream).create(`${keyPrefix}steps_by_run`, {
        history: 1,
      });
    })());

  return {
    get: (async (runId: string, stepId: string, params?: GetStepParams) => {
      await initBuckets();

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
    }) as Storage['steps']['get'],

    list: (async (params: ListWorkflowRunStepsParams) => {
      await initBuckets();
      const limit = params?.pagination?.limit ?? 20;
      const resolveData = params?.resolveData ?? 'all';

      const steps: (Step | StepWithoutData)[] = [];

      const stepIds = await collectIndexKeys(stepsByRunBucket, `${params.runId}.`);
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
  const initBuckets = () =>
    (bucketsReady ??= (async () => {
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
    })());

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

      const hookIds = await collectIndexKeys(hooksByRunBucket, `${params.runId}.`);
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
 * Deletes the run plus its associated steps, hooks, events, claims, counter
 * and index entries. Intended to be called periodically.
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
  const waitsBucket = await new Kvm(jetstream).create(`${keyPrefix}waits`, { history: 1 });
  const eventCountsBucket = await new Kvm(jetstream).create(`${keyPrefix}event_counts`, {
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

        // Delete associated events (keyed `<runId>.<eventId>`)
        const eventIds = await collectIndexKeys(eventsBucket, `${runId}.`);
        for (const eventId of eventIds) {
          try {
            await eventsBucket.delete(`${runId}.${eventId}`);
          } catch {
            /* noop */
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

        // Delete the run's advisory event counter
        try {
          await eventCountsBucket.delete(runId);
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

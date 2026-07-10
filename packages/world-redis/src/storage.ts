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
  EventSchema,
  HookSchema,
  isLegacySpecVersion,
  isTerminalStepStatus,
  isTerminalWorkflowRunStatus,
  requiresNewerWorld,
  SPEC_VERSION_CURRENT,
  StepSchema,
  WaitSchema,
  WorkflowRunSchema,
} from '@workflow/world';
import type { Redis } from 'ioredis';
import { monotonicFactory } from 'ulid';
import { compact, debug, parseWithUint8Array, stringifyWithUint8Array } from './util.js';

interface RedisStorageConfig {
  redis: Redis;
  keyPrefix: string;
}

/** Max retries for optimistic (compare-and-swap) entity updates. Statuses
 * only move forward (pending → running → terminal), so contention resolves
 * in at most a couple of iterations — hitting this limit indicates a bug. */
const MAX_CAS_ATTEMPTS = 5;

/** Cap for the per-run event stream mirror (`events:stream:{runId}`), so the
 * observability mirror cannot grow unbounded. Trimming is approximate (`~`)
 * for efficiency. */
const EVENT_STREAM_MAXLEN = 1000;

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

function filterEventData(event: Event, resolveData: ResolveData): Event {
  if (resolveData === 'none' && 'eventData' in event) {
    const { eventData: _, ...rest } = event;
    return rest as Event;
  }
  return event;
}

// ============================================================
// Lua Scripts for Atomic Multi-Key Writes
// ============================================================
// Each script encapsulates a multi-key write operation to ensure
// atomicity. Lua scripts execute as a single atomic operation in
// Redis, preventing partial writes on connection failures AND
// check-then-write races between concurrent replays.

/**
 * Atomically create a run entity with all its indexes AND its creation
 * event. SETNX arbitrates duplicates: when the run already exists, NO
 * index or event write happens (a replayed run_created must not reset
 * index scores, re-insert the run into the pending status index, or
 * append a second creation event).
 *
 * KEYS[1] = run key
 * KEYS[2] = runs index key
 * KEYS[3] = runs by name key
 * KEYS[4] = runs by status key (pending)
 * KEYS[5] = event key
 * KEYS[6] = events by run index key
 * KEYS[7] = events by correlation index key (or placeholder)
 * ARGV[1] = run JSON
 * ARGV[2] = run ID
 * ARGV[3] = score (timestamp)
 * ARGV[4] = event JSON
 * ARGV[5] = event ID
 * ARGV[6] = has correlation ("1" or "0")
 * Returns: [wasCreated (0|1), runJson]
 */
const LUA_CREATE_RUN_WITH_EVENT = `
  local wasCreated = redis.call('SETNX', KEYS[1], ARGV[1])
  if wasCreated == 0 then
    return {0, redis.call('GET', KEYS[1])}
  end
  local score = tonumber(ARGV[3])
  redis.call('ZADD', KEYS[2], score, ARGV[2])
  redis.call('ZADD', KEYS[3], score, ARGV[2])
  redis.call('ZADD', KEYS[4], score, ARGV[2])
  redis.call('SET', KEYS[5], ARGV[4])
  redis.call('ZADD', KEYS[6], score, ARGV[5])
  if ARGV[6] == '1' then
    redis.call('ZADD', KEYS[7], score, ARGV[5])
  end
  return {1, ARGV[1]}
`;

/**
 * Atomically update a run via compare-and-swap and move it between status
 * indexes. The stored JSON must be byte-identical to the caller's snapshot
 * (ARGV[1]) — otherwise nothing is written and the caller re-reads and
 * re-validates, so concurrent terminal transitions can never overwrite each
 * other or leave the run in two status indexes.
 *
 * KEYS[1] = run key
 * KEYS[2] = old status index key
 * KEYS[3] = new status index key
 * ARGV[1] = expected current run JSON
 * ARGV[2] = updated run JSON
 * ARGV[3] = run ID
 * ARGV[4] = score (timestamp)
 * Returns: nil if run doesn't exist, [0, currentJson] on CAS mismatch,
 *          [1, updatedJson] on success
 */
const LUA_CAS_UPDATE_RUN = `
  local existing = redis.call('GET', KEYS[1])
  if not existing then
    return nil
  end
  if existing ~= ARGV[1] then
    return {0, existing}
  end
  redis.call('SET', KEYS[1], ARGV[2])
  redis.call('ZREM', KEYS[2], ARGV[3])
  redis.call('ZADD', KEYS[3], tonumber(ARGV[4]), ARGV[3])
  return {1, ARGV[2]}
`;

/**
 * Atomically create a step entity with its index AND its creation event.
 * SETNX arbitrates duplicates: a replayed step_created appends nothing.
 *
 * KEYS[1] = step key
 * KEYS[2] = steps index key
 * KEYS[3] = event key
 * KEYS[4] = events by run index key
 * KEYS[5] = events by correlation index key
 * ARGV[1] = step JSON
 * ARGV[2] = step ID (correlationId)
 * ARGV[3] = score (timestamp)
 * ARGV[4] = event JSON
 * ARGV[5] = event ID
 * Returns: [wasCreated (0|1), stepJson]
 */
const LUA_CREATE_STEP_WITH_EVENT = `
  local wasCreated = redis.call('SETNX', KEYS[1], ARGV[1])
  if wasCreated == 0 then
    return {0, redis.call('GET', KEYS[1])}
  end
  local score = tonumber(ARGV[3])
  redis.call('ZADD', KEYS[2], score, ARGV[2])
  redis.call('SET', KEYS[3], ARGV[4])
  redis.call('ZADD', KEYS[4], score, ARGV[5])
  redis.call('ZADD', KEYS[5], score, ARGV[5])
  return {1, ARGV[1]}
`;

/**
 * Atomically update a step via compare-and-swap. Same contract as
 * LUA_CAS_UPDATE_RUN, minus index moves (steps have no status index).
 *
 * KEYS[1] = step key
 * ARGV[1] = expected current step JSON
 * ARGV[2] = updated step JSON
 * Returns: nil if step doesn't exist, [0, currentJson] on CAS mismatch,
 *          [1, updatedJson] on success
 */
const LUA_CAS_UPDATE_STEP = `
  local existing = redis.call('GET', KEYS[1])
  if not existing then
    return nil
  end
  if existing ~= ARGV[1] then
    return {0, existing}
  end
  redis.call('SET', KEYS[1], ARGV[2])
  return {1, ARGV[2]}
`;

/**
 * Atomically claim a hook token and create the hook entity, indexes, and
 * creation event. The by-token key is the claim arbiter (SETNX):
 * - A DIFFERENT hookId already owning the token → cross-run conflict; the
 *   rightful owner's token mapping is left untouched.
 * - The SAME hookId owning the token with the entity present → duplicate.
 * Entity + event are written in the same atomic script, so a crash can
 * never leave a hook entity without its hook_created event (or vice versa).
 *
 * KEYS[1] = hook key
 * KEYS[2] = hooks by token key
 * KEYS[3] = hooks index key
 * KEYS[4] = event key
 * KEYS[5] = events by run index key
 * KEYS[6] = events by correlation index key
 * ARGV[1] = hook JSON
 * ARGV[2] = hook ID (correlationId)
 * ARGV[3] = score (timestamp)
 * ARGV[4] = event JSON
 * ARGV[5] = event ID
 * Returns: [2, owningHookId] on token conflict,
 *          [0, hookJson] when the hook already exists,
 *          [1, hookJson] on success
 */
const LUA_CREATE_HOOK_WITH_EVENT = `
  local claimed = redis.call('SETNX', KEYS[2], ARGV[2])
  if claimed == 0 then
    local owner = redis.call('GET', KEYS[2])
    if owner ~= ARGV[2] then
      return {2, owner}
    end
  end
  local wasCreated = redis.call('SETNX', KEYS[1], ARGV[1])
  if wasCreated == 0 then
    return {0, redis.call('GET', KEYS[1])}
  end
  local score = tonumber(ARGV[3])
  redis.call('ZADD', KEYS[3], score, ARGV[2])
  redis.call('SET', KEYS[4], ARGV[4])
  redis.call('ZADD', KEYS[5], score, ARGV[5])
  redis.call('ZADD', KEYS[6], score, ARGV[5])
  return {1, ARGV[1]}
`;

/**
 * Atomically dispose a hook: delete hook key, token lookup, and index entry.
 *
 * KEYS[1] = hook key
 * KEYS[2] = hooks by token key
 * KEYS[3] = hooks index key
 * ARGV[1] = hook ID (correlationId)
 * Returns: 1 if deleted, 0 if not found
 */
const LUA_DISPOSE_HOOK = `
  local hookKey = KEYS[1]
  local byTokenKey = KEYS[2]
  local hooksIndex = KEYS[3]
  local hookId = ARGV[1]

  local deleted = redis.call('DEL', hookKey)
  redis.call('DEL', byTokenKey)
  redis.call('ZREM', hooksIndex, hookId)
  return deleted
`;

/**
 * Atomically create a wait entity with its index AND its creation event.
 * SETNX arbitrates duplicates so concurrent replays cannot append a second
 * wait_created event.
 *
 * KEYS[1] = wait key
 * KEYS[2] = waits by run index key
 * KEYS[3] = event key
 * KEYS[4] = events by run index key
 * KEYS[5] = events by correlation index key
 * ARGV[1] = wait JSON
 * ARGV[2] = wait correlation ID
 * ARGV[3] = score (timestamp)
 * ARGV[4] = event JSON
 * ARGV[5] = event ID
 * Returns: [wasCreated (0|1), waitJson]
 */
const LUA_CREATE_WAIT_WITH_EVENT = `
  local wasCreated = redis.call('SETNX', KEYS[1], ARGV[1])
  if wasCreated == 0 then
    return {0, redis.call('GET', KEYS[1])}
  end
  local score = tonumber(ARGV[3])
  redis.call('ZADD', KEYS[2], score, ARGV[2])
  redis.call('SET', KEYS[3], ARGV[4])
  redis.call('ZADD', KEYS[4], score, ARGV[5])
  redis.call('ZADD', KEYS[5], score, ARGV[5])
  return {1, ARGV[1]}
`;

/**
 * Atomically complete a wait via compare-and-swap AND store its
 * wait_completed event. The CAS makes concurrent completions lose cleanly:
 * the loser re-reads, sees status 'completed', and rejects with
 * EntityConflictError instead of appending a duplicate event.
 *
 * KEYS[1] = wait key
 * KEYS[2] = event key
 * KEYS[3] = events by run index key
 * KEYS[4] = events by correlation index key
 * ARGV[1] = expected current wait JSON
 * ARGV[2] = updated wait JSON
 * ARGV[3] = score (timestamp)
 * ARGV[4] = event JSON
 * ARGV[5] = event ID
 * Returns: [-1, ''] if the wait doesn't exist, [0, currentJson] on CAS
 *          mismatch, [1, updatedJson] on success
 */
const LUA_CAS_COMPLETE_WAIT_WITH_EVENT = `
  local existing = redis.call('GET', KEYS[1])
  if not existing then
    return {-1, ''}
  end
  if existing ~= ARGV[1] then
    return {0, existing}
  end
  local score = tonumber(ARGV[3])
  redis.call('SET', KEYS[1], ARGV[2])
  redis.call('SET', KEYS[2], ARGV[4])
  redis.call('ZADD', KEYS[3], score, ARGV[5])
  redis.call('ZADD', KEYS[4], score, ARGV[5])
  return {1, ARGV[2]}
`;

/**
 * Atomically store an event and add it to run + correlation indexes.
 *
 * KEYS[1] = event key
 * KEYS[2] = events by run index key
 * KEYS[3] = events by correlation index key (or empty string if no correlationId)
 * ARGV[1] = event JSON
 * ARGV[2] = event ID
 * ARGV[3] = score (timestamp)
 * ARGV[4] = has correlation ("1" or "0")
 */
const LUA_STORE_EVENT = `
  local eventKey = KEYS[1]
  local byRunIndex = KEYS[2]
  local byCorrelationIndex = KEYS[3]
  local eventJson = ARGV[1]
  local eventId = ARGV[2]
  local score = tonumber(ARGV[3])
  local hasCorrelation = ARGV[4]

  redis.call('SET', eventKey, eventJson)
  redis.call('ZADD', byRunIndex, score, eventId)
  if hasCorrelation == "1" then
    redis.call('ZADD', byCorrelationIndex, score, eventId)
  end
  return 1
`;

/**
 * Resolve a pagination cursor to its rank in the index. A cursor that no
 * longer resolves (bogus input, or the entity was deleted while paginating)
 * fails loudly instead of silently skipping the first item of the index.
 */
async function resolveCursorRank(
  redis: Redis,
  indexKey: string,
  cursor: string,
  direction: 'asc' | 'desc',
): Promise<number> {
  const rank =
    direction === 'desc'
      ? await redis.zrevrank(indexKey, cursor)
      : await redis.zrank(indexKey, cursor);
  if (rank === null) {
    throw new WorkflowWorldError(`Invalid pagination cursor "${cursor}"`, { status: 400 });
  }
  return rank + 1;
}

/**
 * Create storage for workflow runs using Redis hashes and sorted sets
 */
export function createRunsStorage(config: RedisStorageConfig): Storage['runs'] {
  const { redis, keyPrefix } = config;

  const runKey = (id: string) => `${keyPrefix}run:${id}`;
  const runsIndexKey = () => `${keyPrefix}runs:index`;
  const runsByNameKey = (name: string) => `${keyPrefix}runs:by_name:${name}`;
  const runsByStatusKey = (status: string) => `${keyPrefix}runs:by_status:${status}`;

  // Helper: Select appropriate index key based on filters
  function selectIndexKey(params?: ListWorkflowRunsParams): string {
    if (params?.workflowName && params?.status) {
      // Use workflowName index and filter by status in memory
      return runsByNameKey(params.workflowName);
    }
    if (params?.workflowName) {
      return runsByNameKey(params.workflowName);
    }
    if (params?.status) {
      return runsByStatusKey(params.status);
    }
    return runsIndexKey();
  }

  // Helper: Fetch and parse runs from pipeline results
  function parseRunsFromPipeline(
    results: [error: Error | null, result: unknown][] | null,
    params?: ListWorkflowRunsParams,
  ): (WorkflowRun | WorkflowRunWithoutData)[] {
    const runs: (WorkflowRun | WorkflowRunWithoutData)[] = [];

    for (const result of results ?? []) {
      if (!result?.[1]) {
        continue;
      }

      const run: WorkflowRun = parseWithUint8Array<WorkflowRun>(result[1] as string);

      // Apply filters
      const statusMatches = !params?.status || run.status === params.status;
      const nameMatches = !params?.workflowName || run.workflowName === params.workflowName;

      if (statusMatches && nameMatches) {
        const resolveData = params?.resolveData ?? 'all';
        const parsed = WorkflowRunSchema.parse(compact(run));
        runs.push(filterRunData(parsed, resolveData));
      }
    }

    return runs;
  }

  return {
    get: (async (id: string, params?: GetWorkflowRunParams) => {
      const data = await redis.get(runKey(id));
      if (!data) {
        throw new WorkflowRunNotFoundError(id);
      }
      const run = parseWithUint8Array<WorkflowRun>(data);
      const parsed = WorkflowRunSchema.parse(compact(run));
      const resolveData = params?.resolveData ?? 'all';
      return filterRunData(parsed, resolveData);
    }) as Storage['runs']['get'],

    list: (async (params?: ListWorkflowRunsParams) => {
      const limit = params?.pagination?.limit ?? 20;
      const fromCursor = params?.pagination?.cursor;

      const indexKey = selectIndexKey(params);
      let start = fromCursor ? await resolveCursorRank(redis, indexKey, fromCursor, 'desc') : 0;

      // Window through the index until we have limit+1 matches or the index
      // is exhausted. A single fetch of limit+1 candidates under-fetches when
      // the in-memory status filter (used for combined workflowName+status
      // listings) rejects candidates, silently dropping matching runs.
      const runs: (WorkflowRun | WorkflowRunWithoutData)[] = [];
      const batchSize = limit + 1;
      while (runs.length <= limit) {
        const runIds = await redis.zrevrange(indexKey, start, start + batchSize - 1);
        if (runIds.length === 0) break;

        const pipeline = redis.pipeline();
        for (const runId of runIds) {
          pipeline.get(runKey(runId));
        }
        const results = await pipeline.exec();
        runs.push(...parseRunsFromPipeline(results, params));

        start += runIds.length;
        if (runIds.length < batchSize) break;
      }

      const values = runs.slice(0, limit);
      const hasMore = runs.length > limit;

      return {
        data: values,
        hasMore,
        cursor: values.at(-1)?.runId ?? null,
      };
    }) as Storage['runs']['list'],
  };
}

/**
 * Create storage for workflow events using Redis hashes and sorted sets
 */
export function createEventsStorage(config: RedisStorageConfig): Storage['events'] {
  const { redis, keyPrefix } = config;
  const ulid = monotonicFactory();

  const eventKey = (id: string) => `${keyPrefix}event:${id}`;
  const eventsIndexKey = (runId: string) => `${keyPrefix}events:by_run:${runId}`;
  const eventsByCorrelationKey = (correlationId: string) =>
    `${keyPrefix}events:by_correlation:${correlationId}`;

  // Run key helpers (needed for event-sourced entity mutations)
  const runKey = (id: string) => `${keyPrefix}run:${id}`;
  const runsIndexKey = () => `${keyPrefix}runs:index`;
  const runsByNameKey = (name: string) => `${keyPrefix}runs:by_name:${name}`;
  const runsByStatusKey = (status: string) => `${keyPrefix}runs:by_status:${status}`;

  // Step key helpers
  const stepKey = (runId: string, stepId: string) => `${keyPrefix}step:${runId}:${stepId}`;
  const stepsIndexKey = (runId: string) => `${keyPrefix}steps:by_run:${runId}`;

  // Hook key helpers
  const hookKey = (hookId: string) => `${keyPrefix}hook:${hookId}`;
  const hooksByTokenKey = (token: string) => `${keyPrefix}hooks:by_token:${token}`;
  const hooksIndexKey = (runId: string) => `${keyPrefix}hooks:by_run:${runId}`;

  // Wait key helpers
  const waitKey = (runId: string, correlationId: string) =>
    `${keyPrefix}wait:${runId}:${correlationId}`;
  const waitsIndexKey = (runId: string) => `${keyPrefix}waits:by_run:${runId}`;

  // Helper: Clean up hooks when run reaches terminal status
  async function cleanupHooks(runId: string): Promise<void> {
    const indexKey = hooksIndexKey(runId);
    const hookIds = await redis.zrange(indexKey, 0, -1);

    const pipeline = redis.pipeline();
    for (const hookId of hookIds) {
      const hookData = await redis.get(hookKey(hookId));
      if (hookData) {
        const hook = parseWithUint8Array<Hook>(hookData);
        pipeline.del(hookKey(hookId));
        pipeline.del(hooksByTokenKey(hook.token));
      }
    }
    pipeline.del(indexKey);
    await pipeline.exec();
  }

  // Helper: Clean up waits when run reaches terminal status
  async function cleanupWaits(runId: string): Promise<void> {
    const indexKey = waitsIndexKey(runId);
    const correlationIds = await redis.zrange(indexKey, 0, -1);

    const pipeline = redis.pipeline();
    for (const correlationId of correlationIds) {
      pipeline.del(waitKey(runId, correlationId));
    }
    pipeline.del(indexKey);
    await pipeline.exec();
  }

  // Helper: Fetch event IDs with proper sort order
  async function fetchEventIds(
    indexKey: string,
    start: number,
    limit: number,
    sortOrder: 'asc' | 'desc',
  ): Promise<string[]> {
    const rangeFn = sortOrder === 'desc' ? 'zrevrange' : 'zrange';
    return redis[rangeFn](indexKey, start, start + limit);
  }

  // Helper: Parse events from pipeline results
  function parseEventsFromPipeline(
    results: [error: Error | null, result: unknown][] | null,
  ): Event[] {
    const events: Event[] = [];

    for (const result of results ?? []) {
      if (result?.[1]) {
        const event = parseWithUint8Array<Event>(result[1] as string);
        events.push(event);
      }
    }

    return events;
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

  /**
   * Mirror an event to the per-run Redis Stream for external event log
   * consumers, capped so the mirror cannot grow unbounded.
   */
  async function mirrorEventToStream(event: StoredEventShape): Promise<void> {
    const eventStreamKey = `${keyPrefix}events:stream:${event.runId}`;
    await redis.xadd(
      eventStreamKey,
      'MAXLEN',
      '~',
      EVENT_STREAM_MAXLEN,
      '*',
      'eventId',
      event.eventId,
      'eventType',
      event.eventType,
      'payload',
      stringifyWithUint8Array(event),
    );
  }

  /** Store an event (entity writes already done) and mirror it. */
  async function storeEventGeneric(event: StoredEventShape): Promise<void> {
    const score = event.createdAt.getTime();
    await redis.eval(
      LUA_STORE_EVENT,
      3,
      eventKey(event.eventId),
      eventsIndexKey(event.runId),
      event.correlationId ? eventsByCorrelationKey(event.correlationId) : '__unused__',
      stringifyWithUint8Array(event),
      event.eventId,
      score.toString(),
      event.correlationId ? '1' : '0',
    );
    await mirrorEventToStream(event);
  }

  /**
   * Compare-and-swap a run update, moving it between status indexes.
   * Returns true when the swap landed; false when the stored run changed
   * since `expectedJson` was read (caller re-reads and re-validates).
   */
  async function casRunUpdate(
    runId: string,
    expectedJson: string,
    updatedRun: Record<string, unknown>,
    oldStatus: string,
    newStatus: string,
    scoreMs: number,
  ): Promise<boolean> {
    const result = await redis.eval(
      LUA_CAS_UPDATE_RUN,
      3,
      runKey(runId),
      runsByStatusKey(oldStatus),
      runsByStatusKey(newStatus),
      expectedJson,
      stringifyWithUint8Array(updatedRun),
      runId,
      scoreMs.toString(),
    );
    return Array.isArray(result) && result[0] === 1;
  }

  /**
   * Apply a terminal run transition (completed/failed/cancelled) with CAS
   * semantics: concurrent terminal events cannot overwrite each other, and
   * the status indexes stay consistent. Returns the updated run, the current
   * run for the idempotent cancelled-on-cancelled case, or undefined when the
   * run entity does not exist (parity with upstream: the event is still
   * logged).
   */
  async function applyTerminalRunTransition(
    runId: string,
    eventType: 'run_completed' | 'run_failed' | 'run_cancelled',
    newStatus: 'completed' | 'failed' | 'cancelled',
    now: Date,
    mutate: () => Record<string, unknown>,
  ): Promise<WorkflowRun | undefined> {
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
      const existingData = await redis.get(runKey(runId));
      if (!existingData) return undefined;
      const existing = parseWithUint8Array<WorkflowRun>(existingData);

      if (isTerminalWorkflowRunStatus(existing.status)) {
        if (eventType === 'run_cancelled' && existing.status === 'cancelled') {
          // Idempotent: cancelling an already-cancelled run returns the
          // current state (the caller still records the event).
          return WorkflowRunSchema.parse(compact(existing));
        }
        throw new EntityConflictError(
          `Cannot transition run from terminal state "${existing.status}"`,
        );
      }

      const updatedRun = {
        ...existing,
        ...mutate(),
        status: newStatus,
        completedAt: now,
        updatedAt: now,
      };
      if (
        await casRunUpdate(
          runId,
          existingData,
          updatedRun,
          existing.status,
          newStatus,
          now.getTime(),
        )
      ) {
        await cleanupHooks(runId);
        await cleanupWaits(runId);
        return WorkflowRunSchema.parse(compact(updatedRun));
      }
    }
    throw new WorkflowWorldError(`Concurrent update contention on run "${runId}"`, {
      status: 500,
    });
  }

  /**
   * Apply a non-terminal step update with CAS semantics. `build` may throw
   * (e.g. TooEarlyError for retryAfter gating); a fresh terminal state on
   * any iteration rejects with EntityConflictError so replays and concurrent
   * transitions cannot resurrect or overwrite a finished step.
   */
  async function applyStepUpdate(
    runId: string,
    stepId: string,
    now: Date,
    build: (existing: Step) => Record<string, unknown>,
  ): Promise<Step> {
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
      const existingData = await redis.get(stepKey(runId, stepId));
      if (!existingData) {
        throw new WorkflowWorldError(`Step "${stepId}" not found`, { status: 404 });
      }
      const existing = StepSchema.parse(compact(parseWithUint8Array<Step>(existingData)));

      if (isTerminalStepStatus(existing.status)) {
        throw new EntityConflictError(`Cannot modify step in terminal state "${existing.status}"`);
      }

      const updatedStep = { ...existing, ...build(existing), updatedAt: now };
      const result = await redis.eval(
        LUA_CAS_UPDATE_STEP,
        1,
        stepKey(runId, stepId),
        existingData,
        stringifyWithUint8Array(updatedStep),
      );
      if (Array.isArray(result) && result[0] === 1) {
        return StepSchema.parse(compact(updatedStep));
      }
    }
    throw new WorkflowWorldError(`Concurrent update contention on step "${stepId}"`, {
      status: 500,
    });
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
    const resolveData = params?.resolveData ?? 'all';

    switch (data.eventType) {
      case 'run_cancelled': {
        // Legacy: Skip event storage, directly update run to cancelled via CAS
        const now = new Date();
        for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
          const existingData = await redis.get(runKey(runId));
          if (!existingData) return {};
          const existing = parseWithUint8Array<WorkflowRun>(existingData);
          if (existing.status === 'cancelled') {
            const parsed = WorkflowRunSchema.parse(compact(existing));
            return { run: filterRunData(parsed, resolveData) as WorkflowRun };
          }
          const updatedRun = {
            ...existing,
            status: 'cancelled' as const,
            completedAt: now,
            updatedAt: now,
          };
          if (
            await casRunUpdate(
              runId,
              existingData,
              updatedRun,
              existing.status,
              'cancelled',
              now.getTime(),
            )
          ) {
            await cleanupHooks(runId);
            const parsed = WorkflowRunSchema.parse(compact(updatedRun));
            return { run: filterRunData(parsed, resolveData) as WorkflowRun };
          }
        }
        throw new WorkflowWorldError(`Concurrent update contention on run "${runId}"`, {
          status: 500,
        });
      }

      case 'wait_completed':
      case 'hook_received': {
        // Legacy: Store event only (no entity mutation) atomically via Lua
        const createdAt = new Date();
        const event = {
          ...data,
          runId,
          eventId,
          createdAt,
          specVersion: SPEC_VERSION_CURRENT,
        };

        const score = createdAt.getTime();
        await redis.eval(
          LUA_STORE_EVENT,
          3,
          eventKey(eventId),
          eventsIndexKey(runId),
          data.correlationId ? eventsByCorrelationKey(data.correlationId) : '__unused__',
          stringifyWithUint8Array(event),
          eventId,
          score.toString(),
          data.correlationId ? '1' : '0',
        );

        const parsed = EventSchema.parse(event);
        return { event: filterEventData(parsed, resolveData) };
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
      const eventId = `wevt_${ulid()}`;
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

      // Track entity created/updated for EventResult
      let run: WorkflowRun | undefined;
      let step: Step | undefined;
      let hook: Hook | undefined;
      let wait: Wait | undefined;

      // ============================================================
      // VALIDATION: Terminal state and event ordering checks
      // ============================================================

      let currentRun: {
        status: string;
        specVersion?: number;
      } | null = null;
      const skipRunValidationEvents = ['step_completed', 'step_retrying'];
      if (data.eventType !== 'run_created' && !skipRunValidationEvents.includes(data.eventType)) {
        const runData = await redis.get(runKey(effectiveRunId));
        if (runData) {
          const parsed = parseWithUint8Array<WorkflowRun>(runData);
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
        const runInputData = data.eventData;
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
          // Synthetic run_created event, written atomically with the run
          // entity — exactly one run_created event lands regardless of how
          // the run_created/run_started race resolves.
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
          const score = now.getTime();
          const result = (await redis.eval(
            LUA_CREATE_RUN_WITH_EVENT,
            7,
            runKey(effectiveRunId),
            runsIndexKey(),
            runsByNameKey(runInputData.workflowName),
            runsByStatusKey('pending'),
            eventKey(runCreatedEventId),
            eventsIndexKey(effectiveRunId),
            '__unused__',
            stringifyWithUint8Array(newRun),
            effectiveRunId,
            score.toString(),
            stringifyWithUint8Array(runCreatedEvent),
            runCreatedEventId,
            '0',
          )) as [number, string];
          if (result[0] === 1) {
            await mirrorEventToStream(runCreatedEvent);
            currentRun = { status: 'pending', specVersion: effectiveSpecVersion };
          } else {
            // Run already exists — re-read state from Lua result
            const parsed = parseWithUint8Array<WorkflowRun>(result[1]);
            currentRun = { status: parsed.status, specVersion: parsed.specVersion };
          }
        }
      }

      // ============================================================
      // VERSION COMPATIBILITY: Check run spec version
      // ============================================================
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
      if (currentRun && isTerminalWorkflowRunStatus(currentRun.status)) {
        const runTerminalEvents = ['run_started', 'run_completed', 'run_failed'];

        // Idempotent operation: run_cancelled on already cancelled run is allowed
        if (data.eventType === 'run_cancelled' && currentRun.status === 'cancelled') {
          // Get full run for return value
          const fullRunData = await redis.get(runKey(effectiveRunId));

          // Create the event (still record it)
          const createdAt = new Date();
          const event = {
            ...data,
            runId: effectiveRunId,
            eventId,
            createdAt,
            specVersion: effectiveSpecVersion,
          };
          await storeEventGeneric(event);

          const parsed = EventSchema.parse(event);
          return {
            event: filterEventData(parsed, resolveData),
            run: fullRunData
              ? (filterRunData(
                  WorkflowRunSchema.parse(compact(parseWithUint8Array<WorkflowRun>(fullRunData))),
                  resolveData,
                ) as WorkflowRun)
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

      // Step-related event validation (ordering and terminal state)
      let validatedStep: Step | null = null;
      const stepEventsNeedingValidation = [
        'step_started',
        'step_completed',
        'step_failed',
        'step_retrying',
      ];
      if (stepEventsNeedingValidation.includes(data.eventType) && data.correlationId) {
        const stepData = await redis.get(stepKey(effectiveRunId, data.correlationId));
        if (stepData) {
          validatedStep = StepSchema.parse(compact(parseWithUint8Array<Step>(stepData)));
        }

        if (!validatedStep) {
          throw new WorkflowWorldError(`Step "${data.correlationId}" not found`, { status: 404 });
        }

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

      // Hook-related event validation (ordering)
      const hookEventsRequiringExistence = ['hook_disposed', 'hook_received'];
      if (hookEventsRequiringExistence.includes(data.eventType) && data.correlationId) {
        const existingHook = await redis.get(hookKey(data.correlationId));
        if (!existingHook) {
          throw new HookNotFoundError(data.correlationId);
        }
      }

      // ============================================================
      // Entity creation events: entity + creation event are written in one
      // atomic Lua script. Duplicates reject with EntityConflictError (which
      // the runtime treats as benign) instead of appending a second creation
      // event and corrupting the log.
      // ============================================================

      // Handle run_created event: create the run entity + event atomically
      if (data.eventType === 'run_created') {
        const eventData = data.eventData;

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
        const event = {
          ...data,
          runId: effectiveRunId,
          eventId,
          createdAt: now,
          specVersion: effectiveSpecVersion,
        };

        const score = now.getTime();
        const result = (await redis.eval(
          LUA_CREATE_RUN_WITH_EVENT,
          7,
          runKey(effectiveRunId),
          runsIndexKey(),
          runsByNameKey(eventData.workflowName),
          runsByStatusKey('pending'),
          eventKey(eventId),
          eventsIndexKey(effectiveRunId),
          data.correlationId ? eventsByCorrelationKey(data.correlationId) : '__unused__',
          stringifyWithUint8Array(newRun),
          effectiveRunId,
          score.toString(),
          stringifyWithUint8Array(event),
          eventId,
          data.correlationId ? '1' : '0',
        )) as [number, string];

        debug('run_created lua result', { wasCreated: result[0], runId: effectiveRunId });

        if (result[0] === 0) {
          throw new EntityConflictError(`Workflow run "${effectiveRunId}" already exists`);
        }

        run = WorkflowRunSchema.parse(compact(newRun));
        await mirrorEventToStream(event);
        const parsed = EventSchema.parse(event);
        return { event: filterEventData(parsed, resolveData), run };
      }

      // Handle step_created event: create step entity + event atomically
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
        const event = {
          ...data,
          runId: effectiveRunId,
          eventId,
          createdAt: now,
          specVersion: effectiveSpecVersion,
        };

        const score = now.getTime();
        const result = (await redis.eval(
          LUA_CREATE_STEP_WITH_EVENT,
          5,
          stepKey(effectiveRunId, data.correlationId),
          stepsIndexKey(effectiveRunId),
          eventKey(eventId),
          eventsIndexKey(effectiveRunId),
          eventsByCorrelationKey(data.correlationId),
          stringifyWithUint8Array(newStep),
          data.correlationId,
          score.toString(),
          stringifyWithUint8Array(event),
          eventId,
        )) as [number, string];

        debug('step_created lua result', { wasCreated: result[0], stepId: data.correlationId });

        if (result[0] === 0) {
          throw new EntityConflictError(`Step "${data.correlationId}" already exists`);
        }

        step = StepSchema.parse(compact(newStep));
        await mirrorEventToStream(event);
        const parsed = EventSchema.parse(event);
        return { event: filterEventData(parsed, resolveData), step };
      }

      // Handle hook_created event: claim token + create hook entity + event
      // atomically
      if (data.eventType === 'hook_created') {
        const eventData = data.eventData;

        const newHook: Hook = {
          runId: effectiveRunId,
          hookId: data.correlationId,
          token: eventData.token,
          ownerId: '',
          projectId: '',
          environment: '',
          metadata: eventData.metadata,
          specVersion: effectiveSpecVersion,
          createdAt: now,
        };
        const event = {
          ...data,
          runId: effectiveRunId,
          eventId,
          createdAt: now,
          specVersion: effectiveSpecVersion,
        };

        const score = now.getTime();
        const result = (await redis.eval(
          LUA_CREATE_HOOK_WITH_EVENT,
          6,
          hookKey(data.correlationId),
          hooksByTokenKey(eventData.token),
          hooksIndexKey(effectiveRunId),
          eventKey(eventId),
          eventsIndexKey(effectiveRunId),
          eventsByCorrelationKey(data.correlationId),
          stringifyWithUint8Array(newHook),
          data.correlationId,
          score.toString(),
          stringifyWithUint8Array(event),
          eventId,
        )) as [number, string];

        debug('hook_created lua result', { result: result[0], hookId: data.correlationId });

        if (result[0] === 2) {
          // Cross-hook conflict: a DIFFERENT hookId owns this token. Record
          // a hook_conflict event (with the owning run for diagnostics) so
          // the workflow can fail gracefully when the hook is awaited. The
          // rightful owner's token mapping is left untouched.
          const owningHookId = result[1];
          let conflictingRunId: string | undefined;
          const owningHookData = await redis.get(hookKey(owningHookId));
          if (owningHookData) {
            conflictingRunId = parseWithUint8Array<Hook>(owningHookData).runId;
          }

          const conflictEvent = {
            eventType: 'hook_conflict' as const,
            correlationId: data.correlationId,
            eventData: {
              token: eventData.token,
              ...(conflictingRunId ? { conflictingRunId } : {}),
            },
            runId: effectiveRunId,
            eventId,
            createdAt: now,
            specVersion: effectiveSpecVersion,
          };
          await storeEventGeneric(conflictEvent);

          const parsedConflict = EventSchema.parse(conflictEvent);
          return {
            event: filterEventData(parsedConflict, resolveData),
            hook: undefined,
          };
        }

        if (result[0] === 0) {
          // Same (runId, hookId, token) already fully created — entity and
          // event are written atomically, so the event is guaranteed to be
          // in the log. The runtime's concurrent-replay path swallows this.
          throw new EntityConflictError(`Hook "${data.correlationId}" already created`);
        }

        hook = HookSchema.parse(compact(newHook));
        await mirrorEventToStream(event);
        const parsed = EventSchema.parse(event);
        return { event: filterEventData(parsed, resolveData), hook };
      }

      // Handle wait_created event: create wait entity + event atomically
      if (data.eventType === 'wait_created') {
        const eventData = data.eventData;
        const waitCompositeKey = `${effectiveRunId}-${data.correlationId}`;

        const newWait = {
          waitId: waitCompositeKey,
          runId: effectiveRunId,
          status: 'waiting' as const,
          resumeAt: eventData.resumeAt,
          completedAt: undefined,
          createdAt: now,
          updatedAt: now,
          specVersion: effectiveSpecVersion,
        };
        const event = {
          ...data,
          runId: effectiveRunId,
          eventId,
          createdAt: now,
          specVersion: effectiveSpecVersion,
        };

        const score = now.getTime();
        const result = (await redis.eval(
          LUA_CREATE_WAIT_WITH_EVENT,
          5,
          waitKey(effectiveRunId, data.correlationId),
          waitsIndexKey(effectiveRunId),
          eventKey(eventId),
          eventsIndexKey(effectiveRunId),
          eventsByCorrelationKey(data.correlationId),
          stringifyWithUint8Array(newWait),
          data.correlationId,
          score.toString(),
          stringifyWithUint8Array(event),
          eventId,
        )) as [number, string];

        debug('wait_created lua result', { wasCreated: result[0], waitId: data.correlationId });

        if (result[0] === 0) {
          throw new EntityConflictError(`Wait "${data.correlationId}" already exists`);
        }

        wait = WaitSchema.parse(compact(newWait));
        await mirrorEventToStream(event);
        const parsed = EventSchema.parse(event);
        return { event: filterEventData(parsed, resolveData), wait };
      }

      // Handle wait_completed event: transition wait + event atomically,
      // rejecting duplicates so concurrent replays cannot append a second
      // wait_completed event for the same correlationId.
      if (data.eventType === 'wait_completed') {
        for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
          const existingData = await redis.get(waitKey(effectiveRunId, data.correlationId));
          if (!existingData) {
            throw new WorkflowWorldError(`Wait "${data.correlationId}" not found`, {
              status: 404,
            });
          }
          const existing = WaitSchema.parse(compact(parseWithUint8Array<Wait>(existingData)));
          if (existing.status === 'completed') {
            throw new EntityConflictError(`Wait "${data.correlationId}" already completed`);
          }

          const updatedWait = {
            ...existing,
            status: 'completed' as const,
            completedAt: now,
            updatedAt: now,
          };
          const event = {
            ...data,
            runId: effectiveRunId,
            eventId,
            createdAt: now,
            specVersion: effectiveSpecVersion,
          };

          const score = now.getTime();
          const result = (await redis.eval(
            LUA_CAS_COMPLETE_WAIT_WITH_EVENT,
            4,
            waitKey(effectiveRunId, data.correlationId),
            eventKey(eventId),
            eventsIndexKey(effectiveRunId),
            eventsByCorrelationKey(data.correlationId),
            existingData,
            stringifyWithUint8Array(updatedWait),
            score.toString(),
            stringifyWithUint8Array(event),
            eventId,
          )) as [number, string];

          if (result[0] === 1) {
            wait = WaitSchema.parse(compact(updatedWait));
            await mirrorEventToStream(event);
            const parsed = EventSchema.parse(event);
            return { event: filterEventData(parsed, resolveData), wait };
          }
          if (result[0] === -1) {
            throw new WorkflowWorldError(`Wait "${data.correlationId}" not found`, {
              status: 404,
            });
          }
          // CAS mismatch — re-read (a concurrent completion will surface as
          // EntityConflictError on the next iteration).
        }
        throw new WorkflowWorldError(
          `Concurrent update contention on wait "${data.correlationId}"`,
          { status: 500 },
        );
      }

      // ============================================================
      // Entity transition events (entity updated via CAS, then the event is
      // appended by the generic store below)
      // ============================================================

      // Handle run_started event: transition run to running via CAS
      if (data.eventType === 'run_started') {
        // Idempotency: if run is already running, this is a replay.
        // Return existing run state without creating a duplicate event.
        if (currentRun?.status === 'running') {
          const existingData = await redis.get(runKey(effectiveRunId));
          if (existingData) {
            const parsed = WorkflowRunSchema.parse(
              compact(parseWithUint8Array<WorkflowRun>(existingData)),
            );
            return { run: filterRunData(parsed, resolveData) as WorkflowRun };
          }
          return { run: undefined };
        }

        for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS && !run; attempt++) {
          const existingData = await redis.get(runKey(effectiveRunId));
          if (!existingData) {
            // The run does not exist (run_created hasn't landed and the
            // message carried no runInput to bootstrap from). Reject so the
            // queue redelivers, instead of appending an orphan run_started
            // event and returning `run: undefined` — which would consume the
            // message and permanently strand the run.
            throw new WorkflowRunNotFoundError(effectiveRunId);
          }
          const existing = parseWithUint8Array<WorkflowRun>(existingData);
          if (existing.status === 'running') {
            const parsed = WorkflowRunSchema.parse(compact(existing));
            return { run: filterRunData(parsed, resolveData) as WorkflowRun };
          }
          if (isTerminalWorkflowRunStatus(existing.status)) {
            throw new RunExpiredError(
              `Workflow run "${effectiveRunId}" is already in terminal state "${existing.status}"`,
            );
          }

          const updatedRun = {
            ...existing,
            status: 'running' as const,
            startedAt: existing.startedAt ?? now,
            output: undefined,
            error: undefined,
            completedAt: undefined,
            updatedAt: now,
          };
          if (
            await casRunUpdate(
              effectiveRunId,
              existingData,
              updatedRun,
              existing.status,
              'running',
              now.getTime(),
            )
          ) {
            run = WorkflowRunSchema.parse(compact(updatedRun));
          }
        }
        if (!run) {
          throw new WorkflowWorldError(`Concurrent update contention on run "${effectiveRunId}"`, {
            status: 500,
          });
        }
      }

      // Handle run_completed event: CAS transition + cleanup hooks/waits
      if (data.eventType === 'run_completed') {
        const eventData = data.eventData;
        run = await applyTerminalRunTransition(
          effectiveRunId,
          'run_completed',
          'completed',
          now,
          () => ({ output: eventData?.output, error: undefined }),
        );
      }

      // Handle run_failed event: CAS transition + cleanup hooks/waits
      if (data.eventType === 'run_failed') {
        const eventData = data.eventData;
        const errorMessage =
          typeof eventData.error === 'string'
            ? eventData.error
            : (eventData.error?.message ?? 'Unknown error');

        run = await applyTerminalRunTransition(effectiveRunId, 'run_failed', 'failed', now, () => ({
          output: undefined,
          error: {
            message: errorMessage,
            stack: typeof eventData.error === 'string' ? undefined : eventData.error?.stack,
            code: eventData.errorCode,
          },
        }));
      }

      // Handle run_cancelled event: CAS transition + cleanup hooks/waits
      if (data.eventType === 'run_cancelled') {
        run = await applyTerminalRunTransition(
          effectiveRunId,
          'run_cancelled',
          'cancelled',
          now,
          () => ({ output: undefined, error: undefined }),
        );
      }

      // Handle step_started event: increment attempt, set status to 'running'
      if (data.eventType === 'step_started' && data.correlationId) {
        const stepId = data.correlationId;
        step = await applyStepUpdate(effectiveRunId, stepId, now, (existing) => {
          // Retry backoff gate: reject early starts so the queue redelivers
          // after the remaining backoff instead of burning retry attempts.
          if (existing.retryAfter && existing.retryAfter.getTime() > Date.now()) {
            throw new TooEarlyError(
              `Cannot start step "${stepId}": retryAfter timestamp has not been reached yet`,
              {
                retryAfter: Math.ceil((existing.retryAfter.getTime() - Date.now()) / 1000),
              },
            );
          }
          return {
            status: 'running' as const,
            attempt: existing.attempt + 1,
            // Only set startedAt on the first start
            startedAt: existing.startedAt ?? now,
            // Clear retryAfter now that the step has started
            retryAfter: undefined,
          };
        });
      }

      // Handle step_completed event: terminal state with output
      if (data.eventType === 'step_completed' && data.correlationId) {
        const eventData = data.eventData;
        step = await applyStepUpdate(effectiveRunId, data.correlationId, now, () => ({
          status: 'completed' as const,
          output: eventData?.result,
          completedAt: now,
        }));
      }

      // Handle step_failed event: terminal state with error
      if (data.eventType === 'step_failed' && data.correlationId) {
        const eventData = data.eventData;
        const errorMessage =
          typeof eventData.error === 'string'
            ? eventData.error
            : (eventData.error?.message ?? 'Unknown error');

        step = await applyStepUpdate(effectiveRunId, data.correlationId, now, () => ({
          status: 'failed' as const,
          error: {
            message: errorMessage,
            stack: eventData.stack,
          },
          completedAt: now,
        }));
      }

      // Handle step_retrying event: sets status back to 'pending', records error
      if (data.eventType === 'step_retrying' && data.correlationId) {
        const eventData = data.eventData;
        const errorMessage =
          typeof eventData.error === 'string'
            ? eventData.error
            : (eventData.error?.message ?? 'Unknown error');

        step = await applyStepUpdate(effectiveRunId, data.correlationId, now, () => ({
          status: 'pending' as const,
          error: {
            message: errorMessage,
            stack: eventData.stack,
          },
          retryAfter: eventData.retryAfter,
        }));
      }

      // Handle hook_disposed event: delete hook entity atomically via Lua
      if (data.eventType === 'hook_disposed' && data.correlationId) {
        const hookData = await redis.get(hookKey(data.correlationId));
        if (hookData) {
          const existingHook = parseWithUint8Array<Hook>(hookData);
          await redis.eval(
            LUA_DISPOSE_HOOK,
            3,
            hookKey(data.correlationId),
            hooksByTokenKey(existingHook.token),
            hooksIndexKey(effectiveRunId),
            data.correlationId,
          );
        }
      }

      // Store the event atomically via Lua
      const createdAt = new Date();
      const event = {
        ...data,
        runId: effectiveRunId,
        eventId,
        createdAt,
        specVersion: effectiveSpecVersion,
      };

      // Strip eventData from run_started events before storage
      if (data.eventType === 'run_started' && 'eventData' in event) {
        delete (event as { eventData?: unknown }).eventData;
      }

      await storeEventGeneric(event);

      const parsed = EventSchema.parse(event);

      // Preload all events for run_started to reduce TTFB
      let allEvents: Event[] | undefined;
      if (data.eventType === 'run_started' && run) {
        const allEventIds = await redis.zrange(eventsIndexKey(effectiveRunId), 0, -1);
        if (allEventIds.length > 0) {
          const eventPipeline = redis.pipeline();
          for (const eid of allEventIds) {
            eventPipeline.get(eventKey(eid));
          }
          const pipelineResults = await eventPipeline.exec();
          allEvents = parseEventsFromPipeline(pipelineResults).map((e) => {
            const p = EventSchema.parse(compact(e));
            return filterEventData(p, resolveData);
          });
        } else {
          allEvents = [];
        }
      }

      return {
        event: filterEventData(parsed, resolveData),
        run,
        step,
        hook,
        wait,
        events: allEvents,
      };
    },

    async get(_runId: string, eventId: string, params?: GetEventParams): Promise<Event> {
      const data = await redis.get(eventKey(eventId));
      if (!data) {
        throw new WorkflowWorldError(`Event not found: ${eventId}`, {
          status: 404,
        });
      }
      const parsed = EventSchema.parse(compact(parseWithUint8Array<Event>(data)));
      return filterEventData(parsed, params?.resolveData ?? 'all');
    },

    async list(params: ListEventsParams): Promise<PaginatedResponse<Event>> {
      const limit = params?.pagination?.limit ?? 100;
      const sortOrder = params.pagination?.sortOrder || 'asc';
      const fromCursor = params?.pagination?.cursor;

      const indexKey = eventsIndexKey(params.runId);
      const start = fromCursor
        ? await resolveCursorRank(redis, indexKey, fromCursor, sortOrder)
        : 0;
      const eventIds = await fetchEventIds(indexKey, start, limit, sortOrder);

      // Fetch events via pipeline
      const eventPipeline = redis.pipeline();
      for (const eid of eventIds) {
        eventPipeline.get(eventKey(eid));
      }
      const results = await eventPipeline.exec();

      const events = parseEventsFromPipeline(results);
      const values = events.slice(0, limit);
      const hasMore = events.length > limit;

      const resolveData = params?.resolveData ?? 'all';
      return {
        data: values.map((v) => {
          const parsed = EventSchema.parse(compact(v));
          return filterEventData(parsed, resolveData);
        }),
        cursor: values.at(-1)?.eventId ?? null,
        hasMore,
      };
    },

    async listByCorrelationId(
      params: ListEventsByCorrelationIdParams,
    ): Promise<PaginatedResponse<Event>> {
      const limit = params?.pagination?.limit ?? 100;
      const sortOrder = params.pagination?.sortOrder || 'asc';
      const fromCursor = params?.pagination?.cursor;

      const indexKey = eventsByCorrelationKey(params.correlationId);
      const start = fromCursor
        ? await resolveCursorRank(redis, indexKey, fromCursor, sortOrder)
        : 0;
      const eventIds = await fetchEventIds(indexKey, start, limit, sortOrder);

      // Fetch events via pipeline
      const eventPipeline = redis.pipeline();
      for (const eid of eventIds) {
        eventPipeline.get(eventKey(eid));
      }
      const results = await eventPipeline.exec();

      const events = parseEventsFromPipeline(results);
      const values = events.slice(0, limit);
      const hasMore = events.length > limit;

      const resolveData = params?.resolveData ?? 'all';
      return {
        data: values.map((v) => {
          const parsed = EventSchema.parse(compact(v));
          return filterEventData(parsed, resolveData);
        }),
        cursor: values.at(-1)?.eventId ?? null,
        hasMore,
      };
    },
  };
}

/**
 * Create storage for workflow steps using Redis hashes and sorted sets
 */
export function createStepsStorage(config: RedisStorageConfig): Storage['steps'] {
  const { redis, keyPrefix } = config;

  const stepKey = (runId: string, stepId: string) => `${keyPrefix}step:${runId}:${stepId}`;
  const stepsIndexKey = (runId: string) => `${keyPrefix}steps:by_run:${runId}`;

  // Helper: Scan Redis for a key matching pattern
  async function scanForKey(pattern: string): Promise<string | null> {
    let cursor = '0';

    do {
      const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);

      if (keys.length > 0) {
        return keys[0];
      }

      cursor = nextCursor;
    } while (cursor !== '0');

    return null;
  }

  // Helper: Get step data from Redis key
  async function getStepData(
    key: string,
    stepId: string,
    params?: GetStepParams,
  ): Promise<Step | StepWithoutData> {
    const data = await redis.get(key);

    if (!data) {
      throw new WorkflowWorldError(`Step not found: ${stepId}`, {
        status: 404,
      });
    }

    const step = parseWithUint8Array<Step>(data);
    const parsed = StepSchema.parse(compact(step));
    const resolveData = params?.resolveData ?? 'all';
    return filterStepData(parsed, resolveData);
  }

  return {
    get: (async (runId: string | undefined, stepId: string, params?: GetStepParams) => {
      // If runId not provided, scan for the step (slower but necessary)
      if (!runId) {
        const pattern = `${keyPrefix}step:*:${stepId}`;
        const foundKey = await scanForKey(pattern);

        if (!foundKey) {
          throw new WorkflowWorldError(`Step not found: ${stepId}`, {
            status: 404,
          });
        }

        return getStepData(foundKey, stepId, params);
      }

      // Fast path: Direct key lookup when runId is provided
      return getStepData(stepKey(runId, stepId), stepId, params);
    }) as Storage['steps']['get'],

    list: (async (params: ListWorkflowRunStepsParams) => {
      const limit = params?.pagination?.limit ?? 20;
      const fromCursor = params?.pagination?.cursor;

      const indexKey = stepsIndexKey(params.runId);

      // ZREVRANGE for descending order
      const start = fromCursor ? await resolveCursorRank(redis, indexKey, fromCursor, 'desc') : 0;

      const stepIds = await redis.zrevrange(indexKey, start, start + limit);

      // Fetch all steps
      const pipeline = redis.pipeline();
      for (const sid of stepIds) {
        pipeline.get(stepKey(params.runId, sid));
      }
      const results = await pipeline.exec();

      const resolveData = params?.resolveData ?? 'all';
      const steps: (Step | StepWithoutData)[] = [];
      for (const result of results ?? []) {
        if (result?.[1]) {
          const step = parseWithUint8Array<Step>(result[1] as string);
          const parsed = StepSchema.parse(compact(step));
          steps.push(filterStepData(parsed, resolveData));
        }
      }

      const values = steps.slice(0, limit);
      const hasMore = steps.length > limit;

      return {
        data: values,
        hasMore,
        cursor: (values.at(-1) as Step | undefined)?.stepId ?? null,
      };
    }) as Storage['steps']['list'],
  };
}

/**
 * Create storage for hooks using Redis hashes and sorted sets
 */
export function createHooksStorage(config: RedisStorageConfig): Storage['hooks'] {
  const { redis, keyPrefix } = config;

  const hookKeyFn = (hookId: string) => `${keyPrefix}hook:${hookId}`;
  const hooksByTokenKey = (token: string) => `${keyPrefix}hooks:by_token:${token}`;
  const hooksIndexKey = (runId: string) => `${keyPrefix}hooks:by_run:${runId}`;

  return {
    async get(hookId: string, params?: GetHookParams): Promise<Hook> {
      const data = await redis.get(hookKeyFn(hookId));
      if (!data) {
        throw new HookNotFoundError(hookId);
      }
      const hook = parseWithUint8Array<Hook>(data);
      const parsed = HookSchema.parse(compact(hook));
      const resolveData = params?.resolveData ?? 'all';
      return filterHookData(parsed, resolveData);
    },

    async getByToken(token: string, params?: GetHookParams): Promise<Hook> {
      const hookId = await redis.get(hooksByTokenKey(token));
      if (!hookId) {
        throw new HookNotFoundError(token);
      }
      return this.get(hookId, params);
    },

    async list(params: ListHooksParams): Promise<PaginatedResponse<Hook>> {
      const limit = params?.pagination?.limit ?? 100;
      const fromCursor = params?.pagination?.cursor;

      if (!params.runId) {
        return { data: [], cursor: null, hasMore: false };
      }

      const indexKey = hooksIndexKey(params.runId);

      // ZREVRANGE for descending order
      const start = fromCursor ? await resolveCursorRank(redis, indexKey, fromCursor, 'desc') : 0;

      const hookIds = await redis.zrevrange(indexKey, start, start + limit);

      // Fetch all hooks
      const pipeline = redis.pipeline();
      for (const hId of hookIds) {
        pipeline.get(hookKeyFn(hId));
      }
      const results = await pipeline.exec();

      const hooks: Hook[] = [];
      for (const result of results ?? []) {
        if (result?.[1]) {
          const hook = parseWithUint8Array<Hook>(result[1] as string);
          const parsed = HookSchema.parse(compact(hook));
          const filtered = filterHookData(parsed, params?.resolveData ?? 'all');
          hooks.push(filtered);
        }
      }

      const values = hooks.slice(0, limit);
      const hasMore = hooks.length > limit;

      return {
        data: values,
        cursor: values.at(-1)?.hookId ?? null,
        hasMore,
      };
    },
  };
}

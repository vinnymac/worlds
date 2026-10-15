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
  Event,
  EventsResolveData,
  GetEventParams,
  EventResult,
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
  Step,
  StepWithoutData,
  Storage,
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
  isTerminalStepStatus,
  isTerminalWorkflowRunStatus,
  requiresNewerWorld,
  SPEC_VERSION_CURRENT,
  SPEC_VERSION_SUPPORTS_SLOT_IDENTITY,
  slotToEventId,
  StepSchema,
  stripEventDataRefs,
  validateAttributeChanges,
  WorkflowRunSchema,
} from '@workflow/world';
import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';
import { monotonicFactory } from 'ulid';
import { compact, parse, stringify } from './util.js';

interface RedisStorageConfig {
  redis: Redis;
  keyPrefix: string;
  /** The spec version this World declares, stamped on runs and events that
   * arrive without one. */
  specVersion?: number;
  /** See `RedisWorldConfig.maxEventsPerRun`. */
  maxEventsPerRun?: number;
}

/** Max retries for optimistic (compare-and-swap) entity updates. */
const MAX_CAS_ATTEMPTS = 5;

/** Per-run event ceiling reported to core, mirroring the Vercel World. */
const DEFAULT_MAX_EVENTS_PER_RUN = 25_000;

/** Resolve the per-run event ceiling surfaced as `EventResult.maxEvents`:
 * explicit config, then `WORKFLOW_MAX_EVENTS`, then the default. A
 * non-positive configured value throws rather than being ignored. */
function resolveMaxEventsPerRun(configured: number | undefined): number {
  if (configured !== undefined) {
    if (!Number.isInteger(configured) || configured <= 0) {
      throw new TypeError(
        `maxEventsPerRun must be a positive integer, received ${String(configured)}`,
      );
    }
    return configured;
  }
  const raw = process.env.WORKFLOW_MAX_EVENTS;
  const parsed = raw !== undefined ? Number(raw) : Number.NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_EVENTS_PER_RUN;
}

/** Events that mutate the run, so validation needs its full body. Everything
 * else only reads status/specVersion and is served from the run meta key. */
const RUN_LIFECYCLE_EVENT_TYPES = new Set([
  'run_started',
  'run_completed',
  'run_failed',
  'run_cancelled',
  'attr_set',
]);

/** Digest of a stored entity's JSON, used as the compare value for the
 * step CAS in `LUA_STORE_EVENT`; the script hashes the stored value with
 * `redis.sha1hex` and compares, so the check stays byte-exact. */
function casDigest(json: string): string {
  return createHash('sha1').update(json).digest('hex');
}

/** Stringify an object with Uint8Array support. Delegates to the shared
 * helper, which tags binary as base64; the previous number-array encoding
 * cost ~450x more CPU to re-parse and ~2.7x more storage at 2MB. */
function stringifyWithUint8Array(obj: any): string {
  return stringify(obj);
}

/** Parse JSON with Uint8Array and Date support. The shared reviver decodes
 * both the base64 tag and the legacy number-array tag, so rows already in
 * Redis keep reading back correctly. */
function parseWithUint8Array<T>(json: string): T {
  return parse<T>(json);
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

/** Rank to resume a page from. A cursor missing from the index is a caller
 * error, not a reason to restart: returning 0 silently repeated the first
 * page. Mirrors world-redis, which rejects the same way. */
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

// ============================================================
// Lua Scripts for Atomic Multi-Key Writes
// ============================================================
// Each script encapsulates a multi-key write operation to ensure
// atomicity. Lua scripts execute as a single atomic operation in
// Redis, preventing partial writes on connection failures AND
// check-then-write races between concurrent replays: every event is
// appended in the same script as the entity write it records, so no
// probe-then-append window exists (same design as world-redis).

/**
 * Every script that appends an event shares one calling convention, so the
 * append lives in one Lua prelude:
 *
 * KEYS[1] = the run's event sequence key (INCR'd to allocate the slot)
 * KEYS[2] = events by run index key (scored by slot)
 * KEYS[3] = events by correlation index key, run-scoped (or placeholder)
 * ARGV[1] = event JSON, whose leading `eventId` is EVENT_ID_PLACEHOLDER
 * ARGV[2] = event key prefix for the run (`<prefix>event:<runId>:`)
 * ARGV[3] = has correlation ("1" or "0")
 *
 * Entity keys and arguments follow from KEYS[4] / ARGV[4].
 *
 * The slot is allocated by INCR in the same script that stores the event, and
 * only after every check in the script has passed, so a slot is never handed
 * out without its event landing: the log stays dense from slot 1, and a
 * reader that has passed slot N never sees a new event appear below it.
 * Redis runs a script to completion before any other command, which is what
 * makes two concurrent appends take different slots.
 */
const FIRST_EVENT_ID = slotToEventId(1);
const EVENT_ID_PREFIX = FIRST_EVENT_ID.slice(0, FIRST_EVENT_ID.indexOf('_') + 1);
const EVENT_ID_WIDTH = FIRST_EVENT_ID.length - EVENT_ID_PREFIX.length;
/** Stands in for the event id in the JSON a script receives. The event object
 * puts `eventId` first, so the first occurrence is always this field. */
const EVENT_ID_PLACEHOLDER = '__wf_event_id__';

const LUA_APPEND_EVENT = `
local function wf_append(json)
  local slot = redis.call('INCR', KEYS[1])
  local eventId = '${EVENT_ID_PREFIX}' .. string.format('%0${EVENT_ID_WIDTH}d', slot)
  local body = string.gsub(json, '${EVENT_ID_PLACEHOLDER}', eventId, 1)
  redis.call('SET', ARGV[2] .. eventId, body)
  redis.call('ZADD', KEYS[2], slot, eventId)
  if ARGV[3] == '1' then
    redis.call('ZADD', KEYS[3], slot, eventId)
  end
  return eventId
end
`;

/** Sentinel from a script whose compare check rejected the write. */
const LUA_STALE = -7;
/** Sentinel from `LUA_STORE_EVENT` when its correlation-dedup check rejects. */
const LUA_DUPLICATE = -8;

/**
 * Atomically create a run entity with all its indexes AND its run_created
 * event. SETNX arbitrates duplicates: when the run already exists, NO index or
 * event write happens.
 *
 * KEYS[4] = run key
 * KEYS[5] = runs index key
 * KEYS[6] = runs by name key
 * KEYS[7] = runs by status key (pending)
 * KEYS[8] = run meta key
 * ARGV[4] = run JSON
 * ARGV[5] = run ID
 * ARGV[6] = score (timestamp)
 * ARGV[7] = run meta value (`<status>|<specVersion>`)
 * Returns: [1, '', eventId] when created, [0, runJson] on replay
 */
const LUA_CREATE_RUN_WITH_EVENT = `${LUA_APPEND_EVENT}
  local wasCreated = redis.call('SETNX', KEYS[4], ARGV[4])
  if wasCreated == 0 then
    return {0, redis.call('GET', KEYS[4])}
  end
  local score = tonumber(ARGV[6])
  redis.call('ZADD', KEYS[5], score, ARGV[5])
  redis.call('ZADD', KEYS[6], score, ARGV[5])
  redis.call('ZADD', KEYS[7], score, ARGV[5])
  redis.call('SET', KEYS[8], ARGV[7])
  return {1, '', wf_append(ARGV[1])}
`;

/**
 * Atomically update a run's status, move it between status indexes, and
 * append the event that caused the change. The run meta key must still hold
 * the status the caller read (ARGV[8]); otherwise nothing is written and the
 * caller re-reads and re-decides, so concurrent terminal transitions cannot
 * overwrite each other.
 *
 * KEYS[4] = run key
 * KEYS[5] = old status index key
 * KEYS[6] = new status index key
 * KEYS[7] = run meta key
 * ARGV[4] = updated run JSON
 * ARGV[5] = run ID
 * ARGV[6] = score (timestamp)
 * ARGV[7] = run meta value (`<status>|<specVersion>`)
 * ARGV[8] = the status the caller read
 * Returns: [1, '', eventId] on success, [0, ''] if the run is absent,
 *          [-7, ''] when the status changed since it was read
 */
const LUA_UPDATE_RUN_STATUS = `${LUA_APPEND_EVENT}
  if redis.call('EXISTS', KEYS[4]) == 0 then
    return {0, ''}
  end
  local meta = redis.call('GET', KEYS[7])
  if meta and string.match(meta, '^[^|]*') ~= ARGV[8] then
    return {${LUA_STALE}, ''}
  end
  redis.call('SET', KEYS[4], ARGV[4])
  redis.call('SET', KEYS[7], ARGV[7])
  redis.call('ZREM', KEYS[5], ARGV[5])
  redis.call('ZADD', KEYS[6], tonumber(ARGV[6]), ARGV[5])
  return {1, '', wf_append(ARGV[1])}
`;

/**
 * Atomically create a step entity with its index AND its creation event.
 * SETNX arbitrates duplicates: a replayed step_created writes nothing.
 *
 * A lazy step start (a step_started carrying the step's name and input, with
 * no prior step_created) passes the started step as ARGV[4] and its
 * step_started event as ARGV[7]: the step is created already running, and the
 * synthetic step_created and the step_started land on consecutive slots in
 * the same execution. SETNX is the ownership claim, so exactly one of several
 * concurrent lazy starts creates the step.
 *
 * KEYS[4] = step key
 * KEYS[5] = steps index key
 * ARGV[4] = step JSON
 * ARGV[5] = step ID (correlationId)
 * ARGV[6] = score (timestamp)
 * ARGV[7] = step_started event JSON for a lazy start ('' otherwise)
 * Returns: [1, '', eventId(, startedEventId)] when created, [0, stepJson] on
 *          replay
 */
const LUA_CREATE_STEP_WITH_EVENT = `${LUA_APPEND_EVENT}
  local wasCreated = redis.call('SETNX', KEYS[4], ARGV[4])
  if wasCreated == 0 then
    return {0, redis.call('GET', KEYS[4])}
  end
  redis.call('ZADD', KEYS[5], tonumber(ARGV[6]), ARGV[5])
  local createdId = wf_append(ARGV[1])
  if ARGV[7] ~= '' then
    return {1, '', createdId, wf_append(ARGV[7])}
  end
  return {1, '', createdId}
`;

/**
 * Atomically claim a hook token and create the hook entity, its indexes,
 * token-map entry, AND its creation event. The by-token key is the claim
 * arbiter (SETNX), and it is store-wide rather than per run, so two runs can
 * never hold one token:
 * - A DIFFERENT hookId already owning the token -> cross-run conflict; the
 *   rightful owner's token mapping is left untouched and nothing is appended
 *   (the caller records a hook_conflict event instead).
 * - The SAME hookId owning the token with the entity present -> duplicate.
 *
 * KEYS[4] = hook key
 * KEYS[5] = hooks by token key
 * KEYS[6] = hooks index key
 * KEYS[7] = hooks token-map key (hash of hookId -> token, per run)
 * ARGV[4] = hook JSON
 * ARGV[5] = hook ID (correlationId)
 * ARGV[6] = score (timestamp)
 * ARGV[7] = the token, recorded in the token map so terminal-run cleanup can
 *           drop token lookups without reading every hook body
 * Returns: [2, owningHookId] on token conflict,
 *          [0, hookJson] when the hook already exists,
 *          [1, '', eventId] on success
 */
const LUA_CREATE_HOOK_WITH_EVENT = `${LUA_APPEND_EVENT}
  local claimed = redis.call('SETNX', KEYS[5], ARGV[5])
  if claimed == 0 then
    local owner = redis.call('GET', KEYS[5])
    if owner ~= ARGV[5] then
      return {2, owner}
    end
  end
  local wasCreated = redis.call('SETNX', KEYS[4], ARGV[4])
  if wasCreated == 0 then
    return {0, redis.call('GET', KEYS[4])}
  end
  redis.call('ZADD', KEYS[6], tonumber(ARGV[6]), ARGV[5])
  redis.call('HSET', KEYS[7], ARGV[5], ARGV[7])
  return {1, '', wf_append(ARGV[1])}
`;

/**
 * Atomically dispose a hook (delete hook key, token lookup, index entry, and
 * the token-map entry) AND append its hook_disposed event. A hook that is
 * already gone appends nothing, so concurrent disposals record one event.
 *
 * KEYS[4] = hook key
 * KEYS[5] = hooks by token key
 * KEYS[6] = hooks index key
 * KEYS[7] = hooks token-map key
 * ARGV[4] = hook ID (correlationId)
 * Returns: [1, '', eventId] if deleted, [0, ''] if not found
 */
const LUA_DISPOSE_HOOK = `${LUA_APPEND_EVENT}
  local deleted = redis.call('DEL', KEYS[4])
  if deleted == 0 then
    return {0, ''}
  end
  if redis.call('GET', KEYS[5]) == ARGV[4] then
    redis.call('DEL', KEYS[5])
  end
  redis.call('ZREM', KEYS[6], ARGV[4])
  redis.call('HDEL', KEYS[7], ARGV[4])
  return {1, '', wf_append(ARGV[1])}
`;

/**
 * Delete a run's hooks in one round trip, replacing a `ZRANGE` plus a
 * sequential `GET` per hook. The token map supplies the token lookups, so no
 * hook body is read or parsed. Hooks predating the map are returned to the
 * caller to finish the slow way; normally that list is empty.
 *
 * KEYS[1] = hooks index key
 * KEYS[2] = hooks token-map key
 * ARGV[1] = hook key prefix
 * ARGV[2] = hooks-by-token key prefix
 * Returns: hook ids that were in the index but not the token map
 */
const LUA_CLEANUP_HOOKS = `
  local hooksIndex = KEYS[1]
  local tokenMapKey = KEYS[2]
  local hookPrefix = ARGV[1]
  local tokenPrefix = ARGV[2]

  local pairsFlat = redis.call('HGETALL', tokenMapKey)
  local mapped = {}
  for i = 1, #pairsFlat, 2 do
    mapped[pairsFlat[i]] = true
    redis.call('DEL', hookPrefix .. pairsFlat[i])
    redis.call('DEL', tokenPrefix .. pairsFlat[i + 1])
  end

  local leftover = {}
  local ids = redis.call('ZRANGE', hooksIndex, 0, -1)
  for i = 1, #ids do
    if not mapped[ids[i]] then
      leftover[#leftover + 1] = ids[i]
    end
  end

  redis.call('DEL', tokenMapKey)
  redis.call('DEL', hooksIndex)
  return leftover
`;

/**
 * Append an event, optionally folding an entity write (a step body) into the
 * same execution so the mutation and its event are atomic.
 *
 * KEYS[4] = entity key (or placeholder)
 * ARGV[4] = correlation dedup: "1" rejects when the correlation index is
 *           non-empty (wait_created), "2" when it already holds two events
 *           (a wait's created + completed, so a second wait_completed)
 * ARGV[5] = entity JSON to write to KEYS[4] ('' to write nothing)
 * ARGV[6] = SHA-1 the stored entity must still have ('' to skip the check)
 *
 * Returns: [1, '', eventId] on success, [-8, ''] when the dedup check rejects,
 *          [-7, ''] when the entity changed since it was read
 */
const LUA_STORE_EVENT = `${LUA_APPEND_EVENT}
  if ARGV[4] == '1' and redis.call('ZCARD', KEYS[3]) > 0 then
    return {${LUA_DUPLICATE}, ''}
  end
  if ARGV[4] == '2' and redis.call('ZCARD', KEYS[3]) >= 2 then
    return {${LUA_DUPLICATE}, ''}
  end
  if ARGV[6] ~= '' then
    local existing = redis.call('GET', KEYS[4])
    if not existing or redis.sha1hex(existing) ~= ARGV[6] then
      return {${LUA_STALE}, ''}
    end
  end
  if ARGV[5] ~= '' then
    redis.call('SET', KEYS[4], ARGV[5])
  end
  return {1, '', wf_append(ARGV[1])}
`;

// ============================================================
// Script registration (EVALSHA)
// ============================================================

/** Registered via `defineCommand` so ioredis dispatches with `EVALSHA` rather
 * than shipping the script body every call. `LUA_STORE_EVENT` is ~1 KB and
 * runs once per workflow event. */
const SCRIPTS = {
  wfCreateRunWithEvent: { numberOfKeys: 8, lua: LUA_CREATE_RUN_WITH_EVENT },
  wfUpdateRunStatus: { numberOfKeys: 7, lua: LUA_UPDATE_RUN_STATUS },
  wfCreateStepWithEvent: { numberOfKeys: 5, lua: LUA_CREATE_STEP_WITH_EVENT },
  wfCreateHookWithEvent: { numberOfKeys: 7, lua: LUA_CREATE_HOOK_WITH_EVENT },
  wfDisposeHook: { numberOfKeys: 7, lua: LUA_DISPOSE_HOOK },
  wfCleanupHooks: { numberOfKeys: 2, lua: LUA_CLEANUP_HOOKS },
  wfStoreEvent: { numberOfKeys: 4, lua: LUA_STORE_EVENT },
} as const;

type ScriptName = keyof typeof SCRIPTS;
type ScriptFn = (...args: string[]) => Promise<unknown>;
type RedisWithScripts = Redis & Record<ScriptName, ScriptFn>;

/** Clients that already have the scripts attached; every storage factory
 * calls this with the same shared connection, so it must be idempotent. */
const scriptedClients = new WeakSet<Redis>();

function withScripts(redis: Redis): RedisWithScripts {
  if (!scriptedClients.has(redis)) {
    for (const [name, def] of Object.entries(SCRIPTS)) {
      redis.defineCommand(name, { numberOfKeys: def.numberOfKeys, lua: def.lua });
    }
    scriptedClients.add(redis);
  }
  return redis as RedisWithScripts;
}

/** Compact `<status>|<specVersion>` marker beside the run blob, so validation
 * reads those two fields without transferring the run's input/output. */
function runMetaValue(status: string, specVersion: number | undefined): string {
  return `${status}|${specVersion ?? ''}`;
}

function parseRunMeta(value: string): { status: string; specVersion?: number } {
  const sep = value.indexOf('|');
  if (sep === -1) {
    return { status: value };
  }
  const version = value.slice(sep + 1);
  return {
    status: value.slice(0, sep),
    specVersion: version === '' ? undefined : Number(version),
  };
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

  /** The requested statuses as a list, or undefined when unfiltered. A run
   * matches a list if its status is any of them; an empty list matches no
   * run, like SQL `IN ()`. */
  function statusFilter(params?: ListWorkflowRunsParams): readonly string[] | undefined {
    const status = params?.status;
    if (status === undefined) return undefined;
    return Array.isArray(status) ? status : [status];
  }

  // Helper: Select appropriate index key based on filters
  function selectIndexKey(params?: ListWorkflowRunsParams): string {
    if (params?.workflowName) {
      // Use workflowName index and filter by status in memory
      return runsByNameKey(params.workflowName);
    }
    const statuses = statusFilter(params);
    if (statuses?.length === 1) {
      return runsByStatusKey(statuses[0]!);
    }
    // Several statuses: walk the full index and filter in memory.
    return runsIndexKey();
  }

  // Helper: Calculate start position from cursor
  async function calculateStartPosition(
    indexKey: string,
    cursor: string | undefined,
  ): Promise<number> {
    return cursor ? resolveCursorRank(redis, indexKey, cursor, 'desc') : 0;
  }

  // Helper: Fetch and parse runs from pipeline results
  function parseRunsFromPipeline(
    results: any[] | null,
    params?: ListWorkflowRunsParams,
  ): (WorkflowRun | WorkflowRunWithoutData)[] {
    const runs: (WorkflowRun | WorkflowRunWithoutData)[] = [];

    for (const result of results ?? []) {
      if (!result?.[1]) {
        continue;
      }

      const run: WorkflowRun = parseWithUint8Array<WorkflowRun>(result[1] as string);

      // Apply filters
      const statuses = statusFilter(params);
      const statusMatches = !statuses || statuses.includes(run.status);
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

      if (statusFilter(params)?.length === 0) {
        return { data: [], hasMore: false, cursor: null };
      }

      const indexKey = selectIndexKey(params);
      let start = await calculateStartPosition(indexKey, fromCursor);

      // Keep scanning the index until limit+1 matches are collected (needed
      // to compute hasMore) or the index is exhausted. A single fetch is not
      // enough when combined workflowName+status filtering happens in memory
      // after the index scan; it would produce premature empty pages and
      // hasMore=false while matches remain further down the index.
      const runs: (WorkflowRun | WorkflowRunWithoutData)[] = [];
      while (runs.length <= limit) {
        const runIds = await redis.zrevrange(indexKey, start, start + limit);
        if (runIds.length === 0) {
          break;
        }

        // Fetch this batch of runs via pipeline
        const pipeline = redis.pipeline();
        for (const runId of runIds) {
          pipeline.get(runKey(runId));
        }
        const results = await pipeline.exec();
        runs.push(...parseRunsFromPipeline(results, params));

        if (runIds.length < limit + 1) {
          break;
        }
        start += runIds.length;
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
  const scripts = withScripts(redis);
  const ulid = monotonicFactory();
  const maxEventsPerRun = resolveMaxEventsPerRun(config.maxEventsPerRun);
  const worldSpecVersion = config.specVersion ?? SPEC_VERSION_CURRENT;

  // Event ids are slot positions within their run, so every event key and
  // the correlation index are scoped by run: two runs both hold slot 1.
  const eventKeyPrefix = (runId: string) => `${keyPrefix}event:${runId}:`;
  const eventKey = (runId: string, eventId: string) => `${eventKeyPrefix(runId)}${eventId}`;
  const eventSeqKey = (runId: string) => `${keyPrefix}events:seq:${runId}`;
  const eventsIndexKey = (runId: string) => `${keyPrefix}events:by_run:${runId}`;
  const eventsByCorrelationKey = (runId: string, correlationId: string) =>
    `${keyPrefix}events:by_correlation:${runId}:${correlationId}`;

  // Run key helpers (needed for event-sourced entity mutations)
  const runKey = (id: string) => `${keyPrefix}run:${id}`;
  const runMetaKey = (id: string) => `${keyPrefix}run:meta:${id}`;
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
  const hooksTokenMapKey = (runId: string) => `${keyPrefix}hooks:tokens:${runId}`;

  // Clean up hooks on terminal status. One round trip via the token map;
  // hooks predating it come back as leftovers and take the old path.
  async function cleanupHooks(runId: string): Promise<void> {
    const leftover = (await scripts.wfCleanupHooks(
      hooksIndexKey(runId),
      hooksTokenMapKey(runId),
      `${keyPrefix}hook:`,
      `${keyPrefix}hooks:by_token:`,
    )) as string[];

    if (!leftover || leftover.length === 0) {
      return;
    }

    const readPipeline = redis.pipeline();
    for (const hookId of leftover) {
      readPipeline.get(hookKey(hookId));
    }
    const results = await readPipeline.exec();

    const deletePipeline = redis.pipeline();
    leftover.forEach((hookId, i) => {
      const raw = results?.[i]?.[1];
      if (!raw) {
        return;
      }
      const hook = parseWithUint8Array<Hook>(raw as string);
      deletePipeline.del(hookKey(hookId));
      deletePipeline.del(hooksByTokenKey(hook.token));
    });
    await deletePipeline.exec();
  }

  // Helper: Fetch event IDs with proper sort order
  async function fetchEventIds(
    indexKey: string,
    start: number,
    limit: number,
    sortOrder: 'asc' | 'desc',
  ): Promise<string[]> {
    const stop = start + limit;
    return sortOrder === 'desc'
      ? redis.zrevrange(indexKey, start, stop)
      : redis.zrange(indexKey, start, stop.toString());
  }

  /** Read the stored events for `eventIds` of one run, in the given order. */
  async function readEvents(runId: string, eventIds: string[]): Promise<Event[]> {
    if (eventIds.length === 0) return [];
    const eventPipeline = redis.pipeline();
    for (const eid of eventIds) {
      eventPipeline.get(eventKey(runId, eid));
    }
    const results = await eventPipeline.exec();
    const events: Event[] = [];
    for (const result of results ?? []) {
      if (result?.[1]) {
        events.push(parseWithUint8Array<Event>(result[1] as string));
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

  /** The leading KEYS and ARGV of every event-appending script (see
   * LUA_APPEND_EVENT). The event id is allocated in the script. */
  function appendArgs(event: StoredEventShape): { keys: string[]; argv: string[] } {
    const { eventId: _unallocated, ...rest } = event;
    return {
      keys: [
        eventSeqKey(event.runId),
        eventsIndexKey(event.runId),
        event.correlationId
          ? eventsByCorrelationKey(event.runId, event.correlationId)
          : '__unused__',
      ],
      argv: [
        stringifyWithUint8Array({ eventId: EVENT_ID_PLACEHOLDER, ...rest }),
        eventKeyPrefix(event.runId),
        event.correlationId ? '1' : '0',
      ],
    };
  }

  /** The event as committed under the id its script allocated. */
  async function committed<E extends StoredEventShape>(event: E, eventId: unknown): Promise<E> {
    if (typeof eventId !== 'string' || eventIdToSlot(eventId) === null) {
      throw new WorkflowWorldError(`Event append returned a non-slot event id "${eventId}"`, {
        status: 500,
      });
    }
    return { ...event, eventId };
  }

  /** Build an event for this run; its id is allocated when it is appended. */
  function newEvent(
    data: Record<string, unknown> & { eventType: string },
    runId: string,
    createdAt: Date,
    specVersion: number,
  ): StoredEventShape {
    return { ...data, runId, eventId: '', createdAt, specVersion };
  }

  /**
   * Append an event, optionally writing an entity in the same script. With
   * `expectedJson`, the entity must still be byte-identical to that snapshot;
   * `false` is returned when it changed, and nothing is written. With
   * `dedup`, a non-empty correlation index ("1") or one already holding two
   * events ("2") rejects the append with EntityConflictError.
   */
  async function storeEvent<E extends StoredEventShape>(
    event: E,
    opts: {
      entityKey?: string;
      entityJson?: string;
      expectedJson?: string;
      dedup?: '0' | '1' | '2';
      duplicateMessage?: string;
    } = {},
  ): Promise<E | false> {
    const { keys, argv } = appendArgs(event);
    const result = (await scripts.wfStoreEvent(
      ...keys,
      opts.entityKey ?? '__unused__',
      ...argv,
      opts.dedup ?? '0',
      opts.entityJson ?? '',
      opts.expectedJson === undefined ? '' : casDigest(opts.expectedJson),
    )) as [number, string, string?];
    if (result[0] === LUA_DUPLICATE) {
      throw new EntityConflictError(opts.duplicateMessage ?? 'Event already recorded');
    }
    if (result[0] === LUA_STALE) return false;
    return committed(event, result[2]);
  }

  /** Append an event that changes no entity. */
  async function appendEvent<E extends StoredEventShape>(
    event: E,
    opts?: { dedup?: '1' | '2'; duplicateMessage?: string },
  ): Promise<E> {
    return (await storeEvent(event, opts)) as E;
  }

  /**
   * The report half of bump-and-report: the events on the slots between the
   * one the writer expected (`eventCount + 1`) and the one its write landed
   * on. Undefined when the write took the slot it asked for, or the caller
   * sent no count. Slots are allocated and stored in one script, so every
   * slot below a committed one is already readable.
   */
  async function reportSkippedSlots(
    runId: string,
    committedEventId: string,
    eventCount: number | undefined,
    resolveData: EventsResolveData,
  ): Promise<{ events: Event[]; cursor: string | null; hasMore: boolean } | undefined> {
    const committedSlot = eventIdToSlot(committedEventId);
    if (eventCount === undefined || committedSlot === null || committedSlot <= eventCount + 1) {
      return undefined;
    }
    const eventIds = await redis.zrangebyscore(
      eventsIndexKey(runId),
      `(${Math.max(eventCount, 0)}`,
      `(${committedSlot}`,
    );
    const events = await readEvents(runId, eventIds);
    if (events.length === 0) return undefined;
    return {
      events: events.map((e) => stripEventDataRefs(EventSchema.parse(compact(e)), resolveData)),
      cursor: events.at(-1)!.eventId,
      hasMore: false,
    };
  }

  /** Attaches the {@link reportSkippedSlots} span, if any, to a create's result. */
  async function withSkippedSlots(
    result: EventResult,
    runId: string,
    committedEventId: string,
    eventCount: number | undefined,
    resolveData: EventsResolveData,
  ): Promise<EventResult> {
    const skipped = await reportSkippedSlots(runId, committedEventId, eventCount, resolveData);
    return skipped ? { ...result, ...skipped } : result;
  }

  /**
   * Apply a run transition and append its event in the same script. `build`
   * sees the current run and returns the fields to change, or throws to
   * refuse the transition. The script requires the run meta key to still hold
   * the status `build` saw, so concurrent writers re-read and re-decide and a
   * terminal run is never overwritten. Terminal transitions also release the
   * run's hooks.
   */
  async function applyRunTransition(
    runId: string,
    now: Date,
    event: StoredEventShape,
    build: (existing: WorkflowRun) => Record<string, unknown> & { status: WorkflowRun['status'] },
    initial?: WorkflowRun | null,
  ): Promise<{ run: WorkflowRun; event: StoredEventShape }> {
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
      let existing = attempt === 0 ? initial : undefined;
      if (!existing) {
        const raw = await redis.get(runKey(runId));
        existing = raw ? parseWithUint8Array<WorkflowRun>(raw) : null;
      }
      if (!existing) throw new WorkflowRunNotFoundError(runId);
      const changes = build(existing);
      const updatedRun = { ...existing, ...changes, updatedAt: now };
      const { keys, argv } = appendArgs(event);
      const result = (await scripts.wfUpdateRunStatus(
        ...keys,
        runKey(runId),
        runsByStatusKey(existing.status),
        runsByStatusKey(changes.status),
        runMetaKey(runId),
        ...argv,
        stringifyWithUint8Array(updatedRun),
        runId,
        now.getTime().toString(),
        runMetaValue(changes.status, updatedRun.specVersion),
        existing.status,
      )) as [number, string, string?];
      if (result[0] === 0) throw new WorkflowRunNotFoundError(runId);
      if (result[0] === 1) {
        if (isTerminalWorkflowRunStatus(changes.status)) {
          await cleanupHooks(runId);
        }
        return {
          run: WorkflowRunSchema.parse(compact(updatedRun)),
          event: await committed(event, result[2]),
        };
      }
    }
    throw new WorkflowWorldError(`Concurrent update contention on run "${runId}"`, {
      status: 500,
    });
  }

  /** A terminal transition refuses a run that is already terminal. */
  function terminalTransition(
    status: 'completed' | 'failed' | 'cancelled',
    now: Date,
    fields: Record<string, unknown>,
  ) {
    return (existing: WorkflowRun) => {
      if (isTerminalWorkflowRunStatus(existing.status)) {
        throw new EntityConflictError(
          `Cannot transition run from terminal state "${existing.status}"`,
        );
      }
      return { ...fields, status, completedAt: now };
    };
  }

  /**
   * Apply a step update with CAS semantics and append its event in the same
   * script. `build` may throw (e.g. TooEarlyError for retryAfter gating); a
   * fresh terminal state on any iteration rejects with EntityConflictError so
   * replays and concurrent transitions cannot resurrect or overwrite a
   * finished step.
   */
  async function applyStepUpdate(
    runId: string,
    stepId: string,
    now: Date,
    event: StoredEventShape,
    build: (existing: Step) => Record<string, unknown>,
  ): Promise<{ step: Step; event: StoredEventShape }> {
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
      const stored = await storeEvent(event, {
        entityKey: stepKey(runId, stepId),
        entityJson: stringifyWithUint8Array(updatedStep),
        expectedJson: existingData,
      });
      if (stored) {
        return { step: StepSchema.parse(compact(updatedStep)), event: stored };
      }
    }
    throw new WorkflowWorldError(`Concurrent update contention on step "${stepId}"`, {
      status: 500,
    });
  }

  /** Events of one run in slot order, for the run_started preload. */
  async function readRunLog(runId: string, resolveData: EventsResolveData): Promise<Event[]> {
    const eventIds = await redis.zrange(eventsIndexKey(runId), 0, '-1');
    const events = await readEvents(runId, eventIds);
    return events.map((e) => stripEventDataRefs(EventSchema.parse(compact(e)), resolveData));
  }

  /** Build a new run entity from run_created (or resilient run_started) data. */
  function newRunEntity(
    runId: string,
    eventData: {
      deploymentId: string;
      workflowName: string;
      input: unknown;
      executionContext?: Record<string, unknown>;
      attributes?: Record<string, string>;
      encryptionPublicKey?: string;
    },
    specVersion: number,
    now: Date,
  ) {
    return {
      runId,
      deploymentId: eventData.deploymentId,
      workflowName: eventData.workflowName,
      specVersion,
      input: eventData.input,
      executionContext: eventData.executionContext,
      // Seeded from run_created (the runtime sets $parentRunId and
      // $rootRunId for a child run); attr_set changes them later.
      attributes: eventData.attributes ?? {},
      ...(eventData.encryptionPublicKey
        ? { encryptionPublicKey: eventData.encryptionPublicKey }
        : {}),
      status: 'pending' as const,
      output: undefined,
      error: undefined,
      completedAt: undefined,
      startedAt: undefined,
      createdAt: now,
      updatedAt: now,
    };
  }

  return {
    async create(
      runId: string | null,
      data: AnyEventRequest,
      params?: CreateEventParams,
    ): Promise<EventResult> {
      const now = new Date();
      // Event pages honor 'skip-step-inputs'; entities take the plain form.
      const eventsResolveData: EventsResolveData = params?.resolveData ?? 'all';
      const resolveData = entityResolveData(eventsResolveData);
      const eventCount = params?.eventCount;

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
      const event = newEvent(data, effectiveRunId, now, effectiveSpecVersion);
      const finish = (result: EventResult, committedEvent: StoredEventShape) =>
        withSkippedSlots(
          result,
          effectiveRunId,
          committedEvent.eventId,
          eventCount,
          eventsResolveData,
        );
      const parseEvent = (e: StoredEventShape) =>
        stripEventDataRefs(EventSchema.parse(e), resolveData);

      // Lazy step start: a step_started carrying step-creation data (stepName
      // + input) may arrive with no prior step_created. It creates the step
      // and a synthetic step_created event in the same script as the start,
      // and the step SETNX is the ownership claim: a caller that finds the
      // step already created lost, and must not run the body.
      const createsChildEntity = isChildEntityCreationEvent(data);
      const lazyStepStart = createsChildEntity && data.eventType === 'step_started';

      // ============================================================
      // VALIDATION: Terminal state and event ordering checks
      // ============================================================

      let currentRun: {
        status: string;
        specVersion?: number;
      } | null = null;
      // Read at most once per call; every mutation branch below reuses it
      // rather than re-fetching and re-parsing the whole payload. Transition
      // retries still re-read, since the point of a retry is a fresh snapshot.
      let existingRun: WorkflowRun | null = null;

      async function loadRunBody(): Promise<void> {
        const runData = await redis.get(runKey(effectiveRunId));
        if (runData) {
          existingRun = parseWithUint8Array<WorkflowRun>(runData);
          currentRun = { status: existingRun.status, specVersion: existingRun.specVersion };
        }
      }

      const skipRunValidationEvents = ['step_completed', 'step_retrying'];
      if (data.eventType !== 'run_created' && !skipRunValidationEvents.includes(data.eventType)) {
        if (RUN_LIFECYCLE_EVENT_TYPES.has(data.eventType)) {
          // These mutate the run, so its body is needed either way.
          await loadRunBody();
        } else {
          // Only status/specVersion are consulted, and the meta key holds
          // both in ~20 bytes.
          const meta = await redis.get(runMetaKey(effectiveRunId));
          if (meta) {
            currentRun = parseRunMeta(meta);
          } else {
            // Written before the meta key existed, or the run is absent.
            await loadRunBody();
          }
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
          const newRun = newRunEntity(
            effectiveRunId,
            {
              deploymentId: runInputData.deploymentId,
              workflowName: runInputData.workflowName,
              input: runInputData.input,
              executionContext: runInputData.executionContext,
              attributes: runInputData.attributes,
              encryptionPublicKey: runInputData.encryptionPublicKey,
            },
            effectiveSpecVersion,
            now,
          );
          // Synthetic run_created event, written atomically with the run
          // entity: exactly one run_created event lands regardless of how
          // the run_created/run_started race resolves, and it takes slot 1
          // because nothing can append to a run before the run exists.
          const runCreatedEvent = newEvent(
            {
              eventType: 'run_created',
              eventData: {
                deploymentId: runInputData.deploymentId,
                workflowName: runInputData.workflowName,
                input: runInputData.input,
                executionContext: runInputData.executionContext,
                ...(runInputData.attributes ? { attributes: runInputData.attributes } : {}),
              },
            },
            effectiveRunId,
            now,
            effectiveSpecVersion,
          );
          const { keys, argv } = appendArgs(runCreatedEvent);
          const result = (await scripts.wfCreateRunWithEvent(
            ...keys,
            runKey(effectiveRunId),
            runsIndexKey(),
            runsByNameKey(runInputData.workflowName),
            runsByStatusKey('pending'),
            runMetaKey(effectiveRunId),
            ...argv,
            stringifyWithUint8Array(newRun),
            effectiveRunId,
            now.getTime().toString(),
            runMetaValue('pending', effectiveSpecVersion),
          )) as [number, string, string?];
          if (result[0] === 1) {
            await committed(runCreatedEvent, result[2]);
            existingRun = newRun as WorkflowRun;
            currentRun = { status: 'pending', specVersion: effectiveSpecVersion };
          } else {
            // Run already exists (this is the resilient re-start path, which
            // must tolerate losing the race): re-read state from Lua result
            existingRun = parseWithUint8Array<WorkflowRun>(result[1]);
            currentRun = { status: existingRun.status, specVersion: existingRun.specVersion };
          }
        }
      }

      // ============================================================
      // VERSION COMPATIBILITY: Check run spec version
      // ============================================================
      if (currentRun) {
        if (requiresNewerWorld(currentRun.specVersion)) {
          throw new RunNotSupportedError(currentRun.specVersion!, worldSpecVersion);
        }
        // A run created before slot-numbered event ids keeps its ULID log,
        // which this World cannot append to. It stays readable, and
        // cancellable without an event; anything else is refused.
        if ((currentRun.specVersion ?? 0) < SPEC_VERSION_SUPPORTS_SLOT_IDENTITY) {
          if (data.eventType === 'run_cancelled' && existingRun) {
            const existing: WorkflowRun = existingRun;
            if (existing.status === 'cancelled') {
              const parsed = WorkflowRunSchema.parse(compact(existing));
              return { run: filterRunData(parsed, resolveData) as WorkflowRun };
            }
            // Pre-slot runs keep their ULID log, so the cancellation is
            // recorded on the run only.
            const updatedRun = {
              ...existing,
              status: 'cancelled' as const,
              completedAt: now,
              updatedAt: now,
            };
            const pipeline = redis.pipeline();
            pipeline.set(runKey(effectiveRunId), stringifyWithUint8Array(updatedRun));
            pipeline.set(
              runMetaKey(effectiveRunId),
              runMetaValue('cancelled', existing.specVersion),
            );
            pipeline.zrem(runsByStatusKey(existing.status), effectiveRunId);
            pipeline.zadd(runsByStatusKey('cancelled'), now.getTime(), effectiveRunId);
            await pipeline.exec();
            await cleanupHooks(effectiveRunId);
            const parsed = WorkflowRunSchema.parse(compact(updatedRun));
            return { run: filterRunData(parsed, resolveData) as WorkflowRun };
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
      if (currentRun && isTerminalWorkflowRunStatus(currentRun.status)) {
        const runTerminalEvents = ['run_started', 'run_completed', 'run_failed'];

        // Idempotent operation: run_cancelled on already cancelled run is allowed
        if (data.eventType === 'run_cancelled' && currentRun.status === 'cancelled') {
          const stored = await appendEvent(event);
          const cancelledRun: WorkflowRun | null = existingRun;
          return finish(
            {
              event: parseEvent(stored),
              // Lifecycle event: validation already loaded the body.
              run: cancelledRun
                ? (filterRunData(
                    WorkflowRunSchema.parse(compact(cancelledRun)),
                    resolveData,
                  ) as WorkflowRun)
                : undefined,
            },
            stored,
          );
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

        // Creating new entities on terminal runs is not allowed, and a lazy
        // step_started creates one.
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

        if (!validatedStep && !lazyStepStart) {
          throw new WorkflowWorldError(`Step "${data.correlationId}" not found`, { status: 404 });
        }
        if (lazyStepStart && validatedStep) {
          throw new EntityConflictError(`Step "${data.correlationId}" already created`);
        }

        if (validatedStep) {
          if (isTerminalStepStatus(validatedStep.status)) {
            throw new EntityConflictError(
              `Cannot modify step in terminal state "${validatedStep.status}"`,
            );
          }

          // On terminal runs: only allow completing/failing in-progress
          // steps. A step_started is refused even when the step still reads
          // `running`: that is a redelivery of a start an earlier delivery
          // already claimed, and nothing would ever read the outcome of
          // running the body again.
          if (currentRun && isTerminalWorkflowRunStatus(currentRun.status)) {
            if (data.eventType === 'step_started' || validatedStep.status !== 'running') {
              throw new RunExpiredError(
                `Cannot modify non-running step on run in terminal state "${currentRun.status}"`,
              );
            }
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
        const newRun = newRunEntity(effectiveRunId, eventData, effectiveSpecVersion, now);
        const { keys, argv } = appendArgs(event);
        const result = (await scripts.wfCreateRunWithEvent(
          ...keys,
          runKey(effectiveRunId),
          runsIndexKey(),
          runsByNameKey(eventData.workflowName),
          runsByStatusKey('pending'),
          runMetaKey(effectiveRunId),
          ...argv,
          stringifyWithUint8Array(newRun),
          effectiveRunId,
          now.getTime().toString(),
          runMetaValue('pending', effectiveSpecVersion),
        )) as [number, string, string?];

        if (result[0] === 0) {
          throw new EntityConflictError(`Workflow run "${effectiveRunId}" already exists`);
        }

        const stored = await committed(event, result[2]);
        const run = WorkflowRunSchema.parse(compact(newRun));
        return {
          event: parseEvent(stored),
          run: filterRunData(run, resolveData) as WorkflowRun,
          maxEvents: maxEventsPerRun,
        };
      }

      // Handle step_created event (and a lazy step_started): create the step
      // entity + its event(s) atomically.
      if (data.eventType === 'step_created' || lazyStepStart) {
        const eventData = data.eventData as { stepName: string; input: unknown };
        const pendingStep = {
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
        const newStep = lazyStepStart
          ? { ...pendingStep, status: 'running' as const, attempt: 1, startedAt: now }
          : pendingStep;
        const createdEvent = lazyStepStart
          ? newEvent(
              {
                eventType: 'step_created',
                correlationId: data.correlationId,
                eventData: { stepName: eventData.stepName, input: eventData.input },
              },
              effectiveRunId,
              now,
              effectiveSpecVersion,
            )
          : event;
        // A lazy step_started keeps its stepName (replay checks it) but drops
        // the input, which lives on the synthetic step_created.
        const { input: _input, ...startedData } = (lazyStepStart ? data.eventData : {}) as Record<
          string,
          unknown
        >;
        const startedEvent = lazyStepStart ? { ...event, eventData: startedData } : undefined;
        const { keys, argv } = appendArgs(createdEvent);
        const result = (await scripts.wfCreateStepWithEvent(
          ...keys,
          stepKey(effectiveRunId, data.correlationId!),
          stepsIndexKey(effectiveRunId),
          ...argv,
          stringifyWithUint8Array(newStep),
          data.correlationId!,
          now.getTime().toString(),
          startedEvent ? appendArgs(startedEvent).argv[0]! : '',
        )) as [number, string, string?, string?];

        if (result[0] === 0) {
          throw new EntityConflictError(`Step "${data.correlationId}" already created`);
        }

        const step = filterStepData(StepSchema.parse(compact(newStep)), resolveData) as Step;
        const storedCreated = await committed(createdEvent, result[2]);
        if (!startedEvent) {
          return finish({ event: parseEvent(storedCreated), step }, storedCreated);
        }
        const storedStarted = await committed(startedEvent, result[3]);
        return finish(
          {
            event: parseEvent(storedStarted),
            step,
            // The lazy start that created the step owns it; losers got
            // EntityConflictError above.
            stepCreated: true,
          },
          storedStarted,
        );
      }

      // Handle hook_created event: claim token + create hook entity + event
      // atomically
      if (data.eventType === 'hook_created') {
        const eventData = data.eventData;

        // Dangling token index (crash during hook cleanup): the owning hook
        // entity is gone, so the token is free; drop the stale index entry
        // so the fused script below can reclaim the token.
        const existingHookId = await redis.get(hooksByTokenKey(eventData.token));
        if (existingHookId) {
          const existingHookData = await redis.get(hookKey(existingHookId));
          if (!existingHookData) {
            await redis.del(hooksByTokenKey(eventData.token));
          }
        }

        const newHook: Hook = {
          runId: effectiveRunId,
          hookId: data.correlationId,
          token: eventData.token,
          ownerId: '',
          projectId: '',
          environment: '',
          metadata: eventData.metadata,
          ...(eventData.isWebhook !== undefined ? { isWebhook: eventData.isWebhook } : {}),
          ...(eventData.isSystem !== undefined ? { isSystem: eventData.isSystem } : {}),
          specVersion: effectiveSpecVersion,
          createdAt: now,
        };

        const { keys, argv } = appendArgs(event);
        const result = (await scripts.wfCreateHookWithEvent(
          ...keys,
          hookKey(data.correlationId),
          hooksByTokenKey(eventData.token),
          hooksIndexKey(effectiveRunId),
          hooksTokenMapKey(effectiveRunId),
          ...argv,
          stringifyWithUint8Array(newHook),
          data.correlationId,
          now.getTime().toString(),
          eventData.token,
        )) as [number, string, string?];

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

          const conflictEvent = newEvent(
            {
              eventType: 'hook_conflict',
              correlationId: data.correlationId,
              eventData: {
                token: eventData.token,
                ...(conflictingRunId ? { conflictingRunId } : {}),
              },
            },
            effectiveRunId,
            now,
            effectiveSpecVersion,
          );
          const stored = await appendEvent(conflictEvent);
          return finish({ event: parseEvent(stored), hook: undefined }, stored);
        }

        if (result[0] === 0) {
          // Same (runId, hookId, token) already fully created: entity and
          // event are written atomically, so the event is guaranteed to be
          // in the log. The runtime's concurrent-replay path swallows this.
          throw new EntityConflictError(`Hook "${data.correlationId}" already created`);
        }

        const stored = await committed(event, result[2]);
        const hook = filterHookData(HookSchema.parse(compact(newHook)), resolveData);
        return finish({ event: parseEvent(stored), hook }, stored);
      }

      // Waits have no entity in this world; the event log is the only dedup
      // surface. A wait's correlation index only holds its wait_created and
      // the wait_completed that follows it, so the append checks the index
      // size in the same script: O(1) and atomic with the write.
      if (data.eventType === 'wait_created' || data.eventType === 'wait_completed') {
        const created = data.eventType === 'wait_created';
        const stored = await appendEvent(event, {
          dedup: created ? '1' : '2',
          duplicateMessage: created
            ? `Wait "${data.correlationId}" already exists`
            : `Wait "${data.correlationId}" already completed`,
        });
        return finish({ event: parseEvent(stored) }, stored);
      }

      // ============================================================
      // Entity transition events: the entity CAS and the event append run in
      // one script, so a crash can never leave one without the other.
      // ============================================================

      // Handle run_started event: transition run to running via CAS
      if (data.eventType === 'run_started') {
        // run_started's eventData belongs on run_created only.
        const startedEvent = { ...event };
        delete startedEvent.eventData;
        // Core reads the per-run event ceiling only from the run_started response, so
        // omitting it here would drop the limit on every replay after the first.
        const loadedRun: WorkflowRun | null = existingRun;
        if (currentRun?.status === 'running' && loadedRun) {
          // Resume path, hit on every re-invocation: a repeated run_started
          // writes no event.
          const parsed = WorkflowRunSchema.parse(compact(loadedRun));
          return {
            run: filterRunData(parsed, resolveData) as WorkflowRun,
            maxEvents: maxEventsPerRun,
          };
        }
        if (!loadedRun) {
          // The run does not exist (run_created hasn't landed and the
          // message carried no runInput to bootstrap from). Reject so the
          // queue redelivers, instead of appending an orphan run_started
          // event, which would consume the message and permanently strand
          // the run.
          throw new WorkflowRunNotFoundError(effectiveRunId);
        }

        let raceLostToRunning: WorkflowRun | undefined;
        const transitioned = await applyRunTransition(
          effectiveRunId,
          now,
          startedEvent,
          (existing) => {
            if (isTerminalWorkflowRunStatus(existing.status)) {
              throw new RunExpiredError(
                `Workflow run "${effectiveRunId}" is already in terminal state "${existing.status}"`,
              );
            }
            if (existing.status === 'running') {
              raceLostToRunning = existing;
              throw new RunAlreadyRunning();
            }
            return {
              status: 'running' as const,
              startedAt: existing.startedAt ?? now,
              output: undefined,
              error: undefined,
              completedAt: undefined,
            };
          },
          loadedRun,
        ).catch((error: unknown) => {
          if (error instanceof RunAlreadyRunning) return undefined;
          throw error;
        });
        if (!transitioned) {
          const parsed = WorkflowRunSchema.parse(compact(raceLostToRunning!));
          return {
            run: filterRunData(parsed, resolveData) as WorkflowRun,
            maxEvents: maxEventsPerRun,
          };
        }

        // Preload all events for run_started to reduce TTFB. The preload
        // carries the whole log, which covers any span this write skipped.
        const allEvents = await readRunLog(effectiveRunId, eventsResolveData);
        return {
          event: parseEvent(transitioned.event),
          run: filterRunData(transitioned.run, resolveData) as WorkflowRun,
          events: allEvents,
          cursor: allEvents.at(-1)?.eventId ?? null,
          hasMore: false,
          maxEvents: maxEventsPerRun,
        };
      }

      if (
        data.eventType === 'run_completed' ||
        data.eventType === 'run_failed' ||
        data.eventType === 'run_cancelled' ||
        data.eventType === 'attr_set'
      ) {
        let build: Parameters<typeof applyRunTransition>[3];
        if (data.eventType === 'run_completed') {
          build = terminalTransition('completed', now, {
            output: data.eventData?.output,
            error: undefined,
          });
        } else if (data.eventType === 'run_failed') {
          // The error is the thrown value as the runtime serialized it;
          // consumers hydrate it, so it is stored verbatim.
          build = terminalTransition('failed', now, {
            output: undefined,
            error: data.eventData.error,
            errorCode: data.eventData.errorCode,
          });
        } else if (data.eventType === 'run_cancelled') {
          build = terminalTransition('cancelled', now, { output: undefined, error: undefined });
        } else {
          const { changes, allowReservedAttributes } = data.eventData;
          build = (existing) => {
            if (isTerminalWorkflowRunStatus(existing.status)) {
              throw new EntityConflictError(
                `Cannot set attributes on run in terminal state "${existing.status}"`,
              );
            }
            validateAttributeChanges(changes, {
              existingKeys: Object.keys(existing.attributes ?? {}),
              allowReservedAttributes: allowReservedAttributes === true,
            });
            return {
              status: existing.status,
              attributes: applyAttributeChanges(existing.attributes ?? undefined, changes),
            };
          };
        }
        const transitioned = await applyRunTransition(
          effectiveRunId,
          now,
          event,
          build,
          existingRun,
        );
        return finish(
          {
            event: parseEvent(transitioned.event),
            run: filterRunData(transitioned.run, resolveData) as WorkflowRun,
            maxEvents: maxEventsPerRun,
          },
          transitioned.event,
        );
      }

      // Step transitions: step_started increments the attempt, the others
      // record the outcome.
      if (
        (data.eventType === 'step_started' ||
          data.eventType === 'step_completed' ||
          data.eventType === 'step_failed' ||
          data.eventType === 'step_retrying') &&
        data.correlationId
      ) {
        const stepId = data.correlationId;
        let build: (existing: Step) => Record<string, unknown>;
        if (data.eventType === 'step_started') {
          build = (existing) => {
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
          };
        } else if (data.eventType === 'step_completed') {
          const result = data.eventData?.result;
          build = () => ({ status: 'completed' as const, output: result, completedAt: now });
        } else if (data.eventType === 'step_failed') {
          // Stored verbatim, as for run_failed.
          const error = data.eventData.error;
          build = () => ({ status: 'failed' as const, error, completedAt: now });
        } else {
          const { error, retryAfter } = data.eventData;
          build = () => ({ status: 'pending' as const, error, retryAfter });
        }
        const updated = await applyStepUpdate(effectiveRunId, stepId, now, event, build);
        return finish(
          {
            event: parseEvent(updated.event),
            step: filterStepData(updated.step, resolveData) as Step,
          },
          updated.event,
        );
      }

      // Handle hook_disposed event: delete hook entity + event atomically
      if (data.eventType === 'hook_disposed' && data.correlationId) {
        const hookData = await redis.get(hookKey(data.correlationId));
        if (!hookData) {
          throw new HookNotFoundError(data.correlationId);
        }
        const existingHook = parseWithUint8Array<Hook>(hookData);
        const { keys, argv } = appendArgs(event);
        const result = (await scripts.wfDisposeHook(
          ...keys,
          hookKey(data.correlationId),
          hooksByTokenKey(existingHook.token),
          hooksIndexKey(effectiveRunId),
          hooksTokenMapKey(effectiveRunId),
          ...argv,
          data.correlationId,
        )) as [number, string, string?];
        if (result[0] === 0) {
          throw new EntityConflictError(`Hook "${data.correlationId}" already disposed`);
        }
        const stored = await committed(event, result[2]);
        return finish({ event: parseEvent(stored) }, stored);
      }

      // Events that change no entity (hook_received).
      const stored = await appendEvent(event);
      return finish({ event: parseEvent(stored) }, stored);
    },

    async get(runId: string, eventId: string, params?: GetEventParams): Promise<Event> {
      const data = await redis.get(eventKey(runId, eventId));
      if (!data) {
        throw new WorkflowWorldError(`Event not found: ${eventId}`, {
          status: 404,
        });
      }
      const parsed = EventSchema.parse(compact(parseWithUint8Array<Event>(data)));
      return stripEventDataRefs(parsed, params?.resolveData ?? 'all');
    },

    async list(params: ListEventsParams): Promise<PaginatedResponse<Event>> {
      return listIndex(
        eventsIndexKey(params.runId),
        params.runId,
        params.pagination,
        params.resolveData,
      );
    },

    async listByCorrelationId(
      params: ListEventsByCorrelationIdParams,
    ): Promise<PaginatedResponse<Event>> {
      return listIndex(
        eventsByCorrelationKey(params.runId, params.correlationId),
        params.runId,
        params.pagination,
        params.resolveData,
      );
    },
  };

  /** One page of a run's slot-scored event index (the run's whole log, or
   * one correlation id within it). */
  async function listIndex(
    indexKey: string,
    runId: string,
    pagination: ListEventsParams['pagination'],
    resolveData: EventsResolveData | undefined,
  ): Promise<PaginatedResponse<Event>> {
    const limit = pagination?.limit ?? 100;
    const sortOrder = pagination?.sortOrder || 'asc';
    const fromCursor = pagination?.cursor;

    const start = fromCursor ? await resolveCursorRank(redis, indexKey, fromCursor, sortOrder) : 0;
    const eventIds = await fetchEventIds(indexKey, start, limit, sortOrder);
    const events = await readEvents(runId, eventIds);
    const values = events.slice(0, limit);
    const hasMore = events.length > limit;

    return {
      data: values.map((v) => {
        const parsed = EventSchema.parse(compact(v));
        return stripEventDataRefs(parsed, resolveData ?? 'all');
      }),
      cursor: values.at(-1)?.eventId ?? null,
      hasMore,
    };
  }
}

/** Thrown inside a run_started transition that found the run already running
 * (a concurrent run_started won); the caller answers with the run instead. */
class RunAlreadyRunning extends Error {}

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

      // ZREVRANGE for descending order.
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

      // ZREVRANGE for descending order.
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

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
  SPEC_VERSION_CURRENT,
  StepSchema,
  stripEventDataRefs,
  validateAttributeChanges,
  WaitSchema,
  WorkflowRunSchema,
} from '@workflow/world';
import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';
import { decodeTime, monotonicFactory } from 'ulid';
import { compact, debug, parseWithUint8Array, stringifyWithUint8Array } from './util.js';

interface RedisStorageConfig {
  redis: Redis;
  keyPrefix: string;
  /** See `RedisWorldConfig.maxEventsPerRun`. */
  maxEventsPerRun?: number;
}

/** Max retries for optimistic (compare-and-swap) entity updates. Statuses
 * only move forward (pending -> running -> terminal), so contention resolves
 * in at most a couple of iterations; hitting this limit indicates a bug. */
const MAX_CAS_ATTEMPTS = 5;

/** Cap for the per-run event stream mirror (`events:stream:{runId}`), so the
 * observability mirror cannot grow unbounded. Trimming is approximate (`~`)
 * for efficiency. */
const EVENT_STREAM_MAXLEN = 1000;

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

/** Epoch ms encoded in the trailing ULID of a legacy `wevt_<ulid>` event id.
 * Legacy (pre-slot) runs keep time-ordered scores; slot runs never use this. */
function eventIdTime(eventId: string): number {
  return decodeTime(eventId.slice(eventId.lastIndexOf('_') + 1));
}

/** Digest of a stored entity's JSON, used as the compare value for the CAS
 * scripts. Sending the digest instead of the whole prior payload halves the
 * bytes on every entity update; the scripts hash the stored value with
 * `redis.sha1hex` and compare, so the check stays byte-exact. */
function casDigest(json: string): string {
  return createHash('sha1').update(json).digest('hex');
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

// ============================================================
// Lua Scripts for Atomic Multi-Key Writes
// ============================================================
// Each script encapsulates a multi-key write operation to ensure
// atomicity. Lua scripts execute as a single atomic operation in
// Redis, preventing partial writes on connection failures AND
// check-then-write races between concurrent replays.
//
// Every script that appends an event allocates the event's slot INSIDE the
// script: the read-max and the append happen in one EVAL, so two concurrent
// writers can never take the same position and the log stays dense from 1.

/**
 * Shared Lua helper: append an event at the next free slot of the run's log.
 * The by_run zset scores events by slot, so the max score + 1 IS the next
 * position. The event id is minted here (`evnt_` + zero-padded slot) and
 * substituted into the JSON payload via a caller-provided placeholder.
 */
const LUA_APPEND_EVENT_FN = `
  local function appendEvent(byRunKey, byCorrKey, eventKeyPrefix, eventJson, placeholder)
    local top = redis.call('ZREVRANGE', byRunKey, 0, 0, 'WITHSCORES')
    local slot = 1
    if top[2] then
      slot = tonumber(top[2]) + 1
    end
    local body = tostring(slot)
    local eventId = 'evnt_' .. string.rep('0', 26 - #body) .. body
    local json = string.gsub(eventJson, placeholder, eventId)
    redis.call('SET', eventKeyPrefix .. eventId, json)
    redis.call('ZADD', byRunKey, slot, eventId)
    if byCorrKey ~= '' then
      redis.call('ZADD', byCorrKey, slot, eventId)
    end
    return eventId
  end
`;

/**
 * Append one event. Slot mode allocates the position at the commit; explicit
 * mode (legacy runs only) stores a caller-minted `wevt_` ULID with a
 * time-based score, keeping legacy logs internally consistent.
 *
 * KEYS[1] = events by run index key
 * KEYS[2] = events by correlation index key (or placeholder)
 * ARGV[1] = event key prefix (event:{runId}:)
 * ARGV[2] = event JSON (with placeholder id in slot mode, final in explicit)
 * ARGV[3] = placeholder
 * ARGV[4] = has correlation ("1" or "0")
 * ARGV[5] = explicit event ID ('' = allocate a slot)
 * ARGV[6] = explicit score ('' unless explicit)
 * Returns: the committed event ID
 */
const LUA_APPEND_EVENT = `${LUA_APPEND_EVENT_FN}
  if ARGV[5] ~= '' then
    redis.call('SET', ARGV[1] .. ARGV[5], ARGV[2])
    redis.call('ZADD', KEYS[1], tonumber(ARGV[6]), ARGV[5])
    if ARGV[4] == '1' then
      redis.call('ZADD', KEYS[2], tonumber(ARGV[6]), ARGV[5])
    end
    return ARGV[5]
  end
  return appendEvent(KEYS[1], ARGV[4] == '1' and KEYS[2] or '', ARGV[1], ARGV[2], ARGV[3])
`;

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
 * KEYS[5] = events by run index key
 * KEYS[6] = events by correlation index key (or placeholder)
 * ARGV[1] = run JSON
 * ARGV[2] = run ID
 * ARGV[3] = score (timestamp)
 * ARGV[4] = event JSON (placeholder id)
 * ARGV[5] = placeholder
 * ARGV[6] = has correlation ("1" or "0")
 * ARGV[7] = event key prefix
 * Returns: [1, '', eventId] when created, [0, runJson, ''] on replay
 */
const LUA_CREATE_RUN_WITH_EVENT = `${LUA_APPEND_EVENT_FN}
  local wasCreated = redis.call('SETNX', KEYS[1], ARGV[1])
  if wasCreated == 0 then
    return {0, redis.call('GET', KEYS[1]), ''}
  end
  local score = tonumber(ARGV[3])
  redis.call('ZADD', KEYS[2], score, ARGV[2])
  redis.call('ZADD', KEYS[3], score, ARGV[2])
  redis.call('ZADD', KEYS[4], score, ARGV[2])
  local eventId = appendEvent(KEYS[5], ARGV[6] == '1' and KEYS[6] or '', ARGV[7], ARGV[4], ARGV[5])
  return {1, '', eventId}
`;

/**
 * Atomically update a run via compare-and-swap and move it between status
 * indexes. The stored JSON must be byte-identical to the caller's snapshot;
 * otherwise nothing is written and the caller re-reads and re-validates, so
 * concurrent terminal transitions can never overwrite each other or leave
 * the run in two status indexes.
 *
 * KEYS[1] = run key
 * KEYS[2] = old status index key
 * KEYS[3] = new status index key
 * ARGV[1] = SHA-1 of the expected current run JSON
 * ARGV[2] = updated run JSON
 * ARGV[3] = run ID
 * ARGV[4] = score (timestamp)
 * Returns: nil if run doesn't exist, 0 on CAS mismatch, 1 on success
 */
const LUA_CAS_UPDATE_RUN = `
  local existing = redis.call('GET', KEYS[1])
  if not existing then
    return nil
  end
  if redis.sha1hex(existing) ~= ARGV[1] then
    return 0
  end
  redis.call('SET', KEYS[1], ARGV[2])
  redis.call('ZREM', KEYS[2], ARGV[3])
  redis.call('ZADD', KEYS[3], tonumber(ARGV[4]), ARGV[3])
  return 1
`;

/**
 * Atomically create a step entity with its index AND its creation event.
 * SETNX arbitrates duplicates: a replayed step_created appends nothing, and
 * the same claim is the exactly-once gate for lazy step_started creation.
 *
 * KEYS[1] = step key
 * KEYS[2] = steps index key
 * KEYS[3] = events by run index key
 * KEYS[4] = events by correlation index key
 * ARGV[1] = step JSON
 * ARGV[2] = step ID (correlationId)
 * ARGV[3] = score (timestamp)
 * ARGV[4] = event JSON (placeholder id)
 * ARGV[5] = placeholder
 * ARGV[6] = event key prefix
 * Returns: [1, '', eventId] when created, [0, stepJson, ''] on replay
 */
const LUA_CREATE_STEP_WITH_EVENT = `${LUA_APPEND_EVENT_FN}
  local wasCreated = redis.call('SETNX', KEYS[1], ARGV[1])
  if wasCreated == 0 then
    return {0, redis.call('GET', KEYS[1]), ''}
  end
  redis.call('ZADD', KEYS[2], tonumber(ARGV[3]), ARGV[2])
  local eventId = appendEvent(KEYS[3], KEYS[4], ARGV[6], ARGV[4], ARGV[5])
  return {1, '', eventId}
`;

/**
 * Atomically update an entity (step or run) via compare-and-swap, with no
 * index moves.
 *
 * KEYS[1] = entity key
 * ARGV[1] = SHA-1 of the expected current JSON
 * ARGV[2] = updated JSON
 * Returns: nil if the entity doesn't exist, 0 on CAS mismatch, 1 on success
 */
const LUA_CAS_UPDATE_ENTITY = `
  local existing = redis.call('GET', KEYS[1])
  if not existing then
    return nil
  end
  if redis.sha1hex(existing) ~= ARGV[1] then
    return 0
  end
  redis.call('SET', KEYS[1], ARGV[2])
  return 1
`;

/**
 * Atomically claim a hook token and create the hook entity, indexes, and
 * creation event. The by-token key is the claim arbiter (SETNX):
 * - A DIFFERENT hookId already owning the token -> cross-run conflict; the
 *   rightful owner's token mapping is left untouched.
 * - The SAME hookId owning the token with the entity present -> duplicate.
 * Entity + event are written in the same atomic script, so a crash can
 * never leave a hook entity without its hook_created event (or vice versa).
 *
 * KEYS[1] = hook key
 * KEYS[2] = hooks by token key
 * KEYS[3] = hooks index key
 * KEYS[4] = events by run index key
 * KEYS[5] = events by correlation index key
 * ARGV[1] = hook JSON
 * ARGV[2] = hook ID (correlationId)
 * ARGV[3] = score (timestamp)
 * ARGV[4] = event JSON (placeholder id)
 * ARGV[5] = placeholder
 * ARGV[6] = event key prefix
 * Returns: [2, owningHookId, ''] on token conflict,
 *          [0, hookJson, ''] when the hook already exists,
 *          [1, '', eventId] on success
 */
const LUA_CREATE_HOOK_WITH_EVENT = `${LUA_APPEND_EVENT_FN}
  local claimed = redis.call('SETNX', KEYS[2], ARGV[2])
  if claimed == 0 then
    local owner = redis.call('GET', KEYS[2])
    if owner ~= ARGV[2] then
      return {2, owner, ''}
    end
  end
  local wasCreated = redis.call('SETNX', KEYS[1], ARGV[1])
  if wasCreated == 0 then
    return {0, redis.call('GET', KEYS[1]), ''}
  end
  redis.call('ZADD', KEYS[3], tonumber(ARGV[3]), ARGV[2])
  local eventId = appendEvent(KEYS[4], KEYS[5], ARGV[6], ARGV[4], ARGV[5])
  return {1, '', eventId}
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
  local deleted = redis.call('DEL', KEYS[1])
  redis.call('DEL', KEYS[2])
  redis.call('ZREM', KEYS[3], ARGV[1])
  return deleted
`;

/**
 * Atomically create a wait entity with its index AND its creation event.
 * SETNX arbitrates duplicates so concurrent replays cannot append a second
 * wait_created event.
 *
 * KEYS[1] = wait key
 * KEYS[2] = waits by run index key
 * KEYS[3] = events by run index key
 * KEYS[4] = events by correlation index key
 * ARGV[1] = wait JSON
 * ARGV[2] = wait correlation ID
 * ARGV[3] = score (timestamp)
 * ARGV[4] = event JSON (placeholder id)
 * ARGV[5] = placeholder
 * ARGV[6] = event key prefix
 * Returns: [1, '', eventId] when created, [0, waitJson, ''] on replay
 */
const LUA_CREATE_WAIT_WITH_EVENT = `${LUA_APPEND_EVENT_FN}
  local wasCreated = redis.call('SETNX', KEYS[1], ARGV[1])
  if wasCreated == 0 then
    return {0, redis.call('GET', KEYS[1]), ''}
  end
  redis.call('ZADD', KEYS[2], tonumber(ARGV[3]), ARGV[2])
  local eventId = appendEvent(KEYS[3], KEYS[4], ARGV[6], ARGV[4], ARGV[5])
  return {1, '', eventId}
`;

/**
 * Atomically complete a wait via compare-and-swap AND store its
 * wait_completed event. The CAS makes concurrent completions lose cleanly:
 * the loser re-reads, sees status 'completed', and rejects with
 * EntityConflictError instead of appending a duplicate event.
 *
 * KEYS[1] = wait key
 * KEYS[2] = events by run index key
 * KEYS[3] = events by correlation index key
 * ARGV[1] = SHA-1 of the expected current wait JSON
 * ARGV[2] = updated wait JSON
 * ARGV[3] = event JSON (placeholder id)
 * ARGV[4] = placeholder
 * ARGV[5] = event key prefix
 * Returns: [-1, ''] if the wait doesn't exist, [0, ''] on CAS mismatch,
 *          [1, eventId] on success
 */
const LUA_CAS_COMPLETE_WAIT_WITH_EVENT = `${LUA_APPEND_EVENT_FN}
  local existing = redis.call('GET', KEYS[1])
  if not existing then
    return {-1, ''}
  end
  if redis.sha1hex(existing) ~= ARGV[1] then
    return {0, ''}
  end
  redis.call('SET', KEYS[1], ARGV[2])
  local eventId = appendEvent(KEYS[2], KEYS[3], ARGV[5], ARGV[3], ARGV[4])
  return {1, eventId}
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

// ============================================================
// Script registration (EVALSHA)
// ============================================================

/** Registered via `defineCommand` so ioredis dispatches with `EVALSHA` rather
 * than shipping the script body on every call. */
const SCRIPTS = {
  wfAppendEvent: { numberOfKeys: 2, lua: LUA_APPEND_EVENT },
  wfCreateRunWithEvent: { numberOfKeys: 6, lua: LUA_CREATE_RUN_WITH_EVENT },
  wfCasUpdateRun: { numberOfKeys: 3, lua: LUA_CAS_UPDATE_RUN },
  wfCreateStepWithEvent: { numberOfKeys: 4, lua: LUA_CREATE_STEP_WITH_EVENT },
  wfCasUpdateEntity: { numberOfKeys: 1, lua: LUA_CAS_UPDATE_ENTITY },
  wfCreateHookWithEvent: { numberOfKeys: 5, lua: LUA_CREATE_HOOK_WITH_EVENT },
  wfDisposeHook: { numberOfKeys: 3, lua: LUA_DISPOSE_HOOK },
  wfCreateWaitWithEvent: { numberOfKeys: 4, lua: LUA_CREATE_WAIT_WITH_EVENT },
  wfCasCompleteWaitWithEvent: { numberOfKeys: 3, lua: LUA_CAS_COMPLETE_WAIT_WITH_EVENT },
} as const;

type ScriptName = keyof typeof SCRIPTS;
type ScriptFn = (...args: string[]) => Promise<unknown>;
type RedisWithScripts = Redis & Record<ScriptName, ScriptFn>;

/** Clients that already have the scripts attached; every storage factory calls
 * this with the same shared connection, so it must be idempotent. */
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

/** Placeholder factory for the event id substituted inside the Lua scripts.
 * The ULID makes the token unique per call, so it cannot collide with
 * payload bytes; the characters are alphanumeric, so it is inert as a Lua
 * gsub pattern. */
const placeholderUlid = monotonicFactory();
function eventIdPlaceholder(): string {
  return `EVNTIDPLACEHOLDER${placeholderUlid()}`;
}

/**
 * Create storage for workflow runs using Redis strings and sorted sets
 */
export function createRunsStorage(config: RedisStorageConfig): Storage['runs'] {
  const { redis, keyPrefix } = config;
  const scripts = withScripts(redis);

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

  const experimentalSetAttributes: NonNullable<
    Storage['runs']['experimentalSetAttributes']
  > = async (runId, changes, options) => {
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
      const existingData = await redis.get(runKey(runId));
      if (!existingData) {
        throw new WorkflowRunNotFoundError(runId);
      }
      const existing = parseWithUint8Array<WorkflowRun>(existingData);
      const currentAttributes = existing.attributes ?? {};
      validateAttributeChanges(changes, {
        existingKeys: Object.keys(currentAttributes),
        allowReservedAttributes: options?.allowReservedAttributes === true,
      });
      const attributes = applyAttributeChanges(currentAttributes, changes);
      const updated = { ...existing, attributes, updatedAt: new Date() };
      const result = await scripts.wfCasUpdateEntity(
        runKey(runId),
        casDigest(existingData),
        stringifyWithUint8Array(updated),
      );
      if (result === null) {
        throw new WorkflowRunNotFoundError(runId);
      }
      if (result === 1) {
        return { attributes };
      }
    }
    throw new WorkflowWorldError(`Concurrent update contention on run "${runId}"`, {
      status: 500,
    });
  };

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

    experimentalSetAttributes,
  };
}

/**
 * Create storage for workflow events using Redis strings and sorted sets
 */
export function createEventsStorage(config: RedisStorageConfig): Storage['events'] {
  const { redis, keyPrefix } = config;
  const scripts = withScripts(redis);
  const ulid = monotonicFactory();
  const maxEventsPerRun = resolveMaxEventsPerRun(config.maxEventsPerRun);

  // Slot ids are only unique within a run, so every event key and correlation
  // index is scoped by runId.
  const eventKey = (runId: string, eventId: string) => `${keyPrefix}event:${runId}:${eventId}`;
  const eventKeyPrefix = (runId: string) => `${keyPrefix}event:${runId}:`;
  const eventsIndexKey = (runId: string) => `${keyPrefix}events:by_run:${runId}`;
  const eventsByCorrelationKey = (runId: string, correlationId: string) =>
    `${keyPrefix}events:by_correlation:${runId}:${correlationId}`;

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

  // Dedup claim for workflow-writer attr_set events, keyed by correlationId.
  const attrClaimKey = (runId: string, correlationId: string) =>
    `${keyPrefix}attr_claim:${runId}:${correlationId}`;

  // Helper: Clean up hooks when run reaches terminal status. The hook bodies
  // are fetched in one pipeline rather than a sequential GET per hook, and a
  // run with no hooks (the common case) costs nothing beyond the index read.
  async function cleanupHooks(runId: string): Promise<void> {
    const indexKey = hooksIndexKey(runId);
    const hookIds = await redis.zrange(indexKey, 0, '-1');
    if (hookIds.length === 0) {
      return;
    }

    const readPipeline = redis.pipeline();
    for (const hookId of hookIds) {
      readPipeline.get(hookKey(hookId));
    }
    const results = await readPipeline.exec();

    const pipeline = redis.pipeline();
    hookIds.forEach((hookId, i) => {
      const raw = results?.[i]?.[1];
      if (!raw) {
        return;
      }
      const hook = parseWithUint8Array<Hook>(raw as string);
      pipeline.del(hookKey(hookId));
      pipeline.del(hooksByTokenKey(hook.token));
    });
    pipeline.del(indexKey);
    await pipeline.exec();
  }

  // Helper: Clean up waits when run reaches terminal status
  async function cleanupWaits(runId: string): Promise<void> {
    const indexKey = waitsIndexKey(runId);
    const correlationIds = await redis.zrange(indexKey, 0, '-1');
    if (correlationIds.length === 0) {
      return;
    }

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
    const stop = start + limit;
    return sortOrder === 'desc'
      ? redis.zrevrange(indexKey, start, stop)
      : redis.zrange(indexKey, start, stop.toString());
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

  /** Append an event at the next free slot (allocated inside the Lua script,
   * at the commit) and mirror it. Returns the event under its committed id. */
  async function appendEventAtNextSlot(
    event: Omit<StoredEventShape, 'eventId'>,
  ): Promise<StoredEventShape> {
    const placeholder = eventIdPlaceholder();
    const payload = { ...event, eventId: placeholder };
    const eventId = (await scripts.wfAppendEvent(
      eventsIndexKey(event.runId),
      event.correlationId ? eventsByCorrelationKey(event.runId, event.correlationId) : '__unused__',
      eventKeyPrefix(event.runId),
      stringifyWithUint8Array(payload),
      placeholder,
      event.correlationId ? '1' : '0',
      '',
      '',
    )) as string;
    const stored = { ...event, eventId };
    await mirrorEventToStream(stored);
    return stored;
  }

  /** Append a legacy (`wevt_` ULID) event with a time-based score. Only legacy
   * runs (specVersion <= 1) take this path. */
  async function appendLegacyEvent(event: StoredEventShape): Promise<void> {
    await scripts.wfAppendEvent(
      eventsIndexKey(event.runId),
      event.correlationId ? eventsByCorrelationKey(event.runId, event.correlationId) : '__unused__',
      eventKeyPrefix(event.runId),
      stringifyWithUint8Array(event),
      event.eventId,
      event.correlationId ? '1' : '0',
      event.eventId,
      eventIdTime(event.eventId).toString(),
    );
    await mirrorEventToStream(event);
  }

  /** Compare-and-swap a run update, moving it between status indexes. Returns
   * false when the stored run changed since `expectedJson` was read. */
  async function casRunUpdate(
    runId: string,
    expectedJson: string,
    updatedRun: Record<string, unknown>,
    oldStatus: string,
    newStatus: string,
    scoreMs: number,
  ): Promise<boolean> {
    const result = await scripts.wfCasUpdateRun(
      runKey(runId),
      runsByStatusKey(oldStatus),
      runsByStatusKey(newStatus),
      casDigest(expectedJson),
      stringifyWithUint8Array(updatedRun),
      runId,
      scoreMs.toString(),
    );
    return result === 1;
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
      const result = await scripts.wfCasUpdateEntity(
        stepKey(runId, stepId),
        casDigest(existingData),
        stringifyWithUint8Array(updatedStep),
      );
      if (result === 1) {
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
        // Legacy: Store event only (no entity mutation). Legacy runs keep
        // ULID event ids, so the log's identity scheme stays uniform.
        const event = {
          ...data,
          runId,
          eventId: `wevt_${ulid()}`,
          createdAt: new Date(),
          specVersion: SPEC_VERSION_CURRENT,
        };
        await appendLegacyEvent(event);

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

  /** Read one page of a run's event log, `events.list` semantics. */
  async function listEvents(params: ListEventsParams): Promise<PaginatedResponse<Event>> {
    const limit = params?.pagination?.limit ?? 100;
    const sortOrder = params.pagination?.sortOrder || 'asc';
    const fromCursor = params?.pagination?.cursor;

    const indexKey = eventsIndexKey(params.runId);
    const start = fromCursor ? await resolveCursorRank(redis, indexKey, fromCursor, sortOrder) : 0;
    const eventIds = await fetchEventIds(indexKey, start, limit, sortOrder);

    // Fetch events via pipeline
    const eventPipeline = redis.pipeline();
    for (const eid of eventIds) {
      eventPipeline.get(eventKey(params.runId, eid));
    }
    const results = await eventPipeline.exec();

    const events = parseEventsFromPipeline(results);
    const values = events.slice(0, limit);
    const hasMore = events.length > limit;

    const resolveData = params?.resolveData ?? 'all';
    return {
      data: values.map((v) => {
        const parsed = EventSchema.parse(compact(v));
        return stripEventDataRefs(parsed, resolveData);
      }),
      cursor: values.at(-1)?.eventId ?? null,
      hasMore,
    };
  }

  /** Load a run's full event log for the run_started preload. */
  async function preloadAllEvents(
    runId: string,
    resolveData: ResolveData,
  ): Promise<{ events: Event[]; cursor: string | null; hasMore: false }> {
    const allEventIds = await redis.zrange(eventsIndexKey(runId), 0, '-1');
    if (allEventIds.length === 0) {
      return { events: [], cursor: null, hasMore: false };
    }
    const eventPipeline = redis.pipeline();
    for (const eid of allEventIds) {
      eventPipeline.get(eventKey(runId, eid));
    }
    const pipelineResults = await eventPipeline.exec();
    const events = parseEventsFromPipeline(pipelineResults).map((e) => {
      const p = EventSchema.parse(compact(e));
      return stripEventDataRefs(p, resolveData);
    });
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
    const skippedIds = await redis.zrangebyscore(
      eventsIndexKey(runId),
      askedFor + 1,
      committedSlot - 1,
    );
    const pipeline = redis.pipeline();
    for (const eid of skippedIds) {
      pipeline.get(eventKey(runId, eid));
    }
    const results = await pipeline.exec();
    const events = parseEventsFromPipeline(results).map((e) =>
      stripEventDataRefs(EventSchema.parse(compact(e)), resolveData),
    );
    return {
      ...result,
      events,
      cursor: null,
      hasMore: events.length < span,
    };
  }

  async function createImpl(
    runId: string | null,
    data: CreateEventRequest | RunCreatedEventRequest,
    params?: CreateEventParams,
  ): Promise<EventResult> {
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
    // Set when a lazy step_started atomically created its step: the runtime's
    // exactly-once inline-execution ownership signal.
    let stepCreatedLazily = false;

    // ============================================================
    // VALIDATION: Terminal state and event ordering checks
    // ============================================================

    let currentRun: {
      status: string;
      specVersion?: number;
    } | null = null;
    // The raw run JSON from the validation read, kept so the branches below
    // can reuse it instead of issuing a second GET for the same key. CAS
    // retries still re-read, since the point of a retry is a fresh snapshot.
    let validationRunJson: string | null = null;
    const skipRunValidationEvents = ['step_completed', 'step_retrying'];
    if (data.eventType !== 'run_created' && !skipRunValidationEvents.includes(data.eventType)) {
      const runData = await redis.get(runKey(effectiveRunId));
      if (runData) {
        validationRunJson = runData;
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
        // Synthetic run_created event, written atomically with the run
        // entity: exactly one run_created event lands regardless of how the
        // run_created/run_started race resolves. It takes the earlier slot,
        // so it replays first.
        const placeholder = eventIdPlaceholder();
        const runCreatedEvent = {
          eventType: 'run_created' as const,
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
          eventId: placeholder,
          createdAt: now,
          specVersion: effectiveSpecVersion,
        };
        const result = (await scripts.wfCreateRunWithEvent(
          runKey(effectiveRunId),
          runsIndexKey(),
          runsByNameKey(runInputData.workflowName),
          runsByStatusKey('pending'),
          eventsIndexKey(effectiveRunId),
          '__unused__',
          stringifyWithUint8Array(newRun),
          effectiveRunId,
          now.getTime().toString(),
          stringifyWithUint8Array(runCreatedEvent),
          placeholder,
          '0',
          eventKeyPrefix(effectiveRunId),
        )) as [number, string, string];
        if (result[0] === 1) {
          await mirrorEventToStream({ ...runCreatedEvent, eventId: result[2] });
          currentRun = { status: 'pending', specVersion: effectiveSpecVersion };
          validationRunJson = null;
        } else {
          // Run already exists: re-read state from Lua result
          const parsed = parseWithUint8Array<WorkflowRun>(result[1]);
          currentRun = { status: parsed.status, specVersion: parsed.specVersion };
          validationRunJson = result[1];
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

    // ============================================================
    // VERSION COMPATIBILITY: Check run spec version
    // ============================================================
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
      // Idempotent operation: run_cancelled on already cancelled run is allowed
      if (data.eventType === 'run_cancelled' && currentRun.status === 'cancelled') {
        const fullRunData = validationRunJson ?? (await redis.get(runKey(effectiveRunId)));

        // Create the event (still record it)
        const stored = await appendEventAtNextSlot({
          ...data,
          runId: effectiveRunId,
          createdAt: new Date(),
          specVersion: effectiveSpecVersion,
        });

        const parsed = EventSchema.parse(stored);
        return {
          event: stripEventDataRefs(parsed, resolveData),
          run: fullRunData
            ? (filterRunData(
                WorkflowRunSchema.parse(compact(parseWithUint8Array<WorkflowRun>(fullRunData))),
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

    // Step-related event validation (ordering and terminal state)
    let validatedStep: Step | null = null;
    const stepEventRequiresExistingStep =
      isStepEventType(data.eventType) && data.eventType !== 'step_created';
    if (stepEventRequiresExistingStep && data.correlationId) {
      const stepData = await redis.get(stepKey(effectiveRunId, data.correlationId));
      if (stepData) {
        validatedStep = StepSchema.parse(compact(parseWithUint8Array<Step>(stepData)));
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

    // Hook-related event validation (ordering)
    if (isHookEventRequiringExistence(data.eventType) && data.correlationId) {
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
      const placeholder = eventIdPlaceholder();
      const event = {
        ...data,
        runId: effectiveRunId,
        eventId: placeholder,
        createdAt: now,
        specVersion: effectiveSpecVersion,
      };

      const result = (await scripts.wfCreateRunWithEvent(
        runKey(effectiveRunId),
        runsIndexKey(),
        runsByNameKey(eventData.workflowName),
        runsByStatusKey('pending'),
        eventsIndexKey(effectiveRunId),
        data.correlationId
          ? eventsByCorrelationKey(effectiveRunId, data.correlationId)
          : '__unused__',
        stringifyWithUint8Array(newRun),
        effectiveRunId,
        now.getTime().toString(),
        stringifyWithUint8Array(event),
        placeholder,
        data.correlationId ? '1' : '0',
        eventKeyPrefix(effectiveRunId),
      )) as [number, string, string];

      debug('run_created lua result', { wasCreated: result[0], runId: effectiveRunId });

      if (result[0] === 0) {
        throw new EntityConflictError(`Workflow run "${effectiveRunId}" already exists`);
      }

      const storedEvent = { ...event, eventId: result[2] };
      run = WorkflowRunSchema.parse(compact(newRun));
      await mirrorEventToStream(storedEvent);
      const parsed = EventSchema.parse(storedEvent);
      return { event: stripEventDataRefs(parsed, resolveData), run, maxEvents: maxEventsPerRun };
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
      const placeholder = eventIdPlaceholder();
      const event = {
        ...data,
        runId: effectiveRunId,
        eventId: placeholder,
        createdAt: now,
        specVersion: effectiveSpecVersion,
      };

      const result = (await scripts.wfCreateStepWithEvent(
        stepKey(effectiveRunId, data.correlationId),
        stepsIndexKey(effectiveRunId),
        eventsIndexKey(effectiveRunId),
        eventsByCorrelationKey(effectiveRunId, data.correlationId),
        stringifyWithUint8Array(newStep),
        data.correlationId,
        now.getTime().toString(),
        stringifyWithUint8Array(event),
        placeholder,
        eventKeyPrefix(effectiveRunId),
      )) as [number, string, string];

      debug('step_created lua result', { wasCreated: result[0], stepId: data.correlationId });

      if (result[0] === 0) {
        throw new EntityConflictError(`Step "${data.correlationId}" already exists`);
      }

      const storedEvent = { ...event, eventId: result[2] };
      step = StepSchema.parse(compact(newStep));
      await mirrorEventToStream(storedEvent);
      const parsed = EventSchema.parse(storedEvent);
      return { event: stripEventDataRefs(parsed, resolveData), step };
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
        ...(eventData.isSystem !== undefined ? { isSystem: eventData.isSystem } : {}),
      };
      const placeholder = eventIdPlaceholder();
      const event = {
        ...data,
        runId: effectiveRunId,
        eventId: placeholder,
        createdAt: now,
        specVersion: effectiveSpecVersion,
      };

      const result = (await scripts.wfCreateHookWithEvent(
        hookKey(data.correlationId),
        hooksByTokenKey(eventData.token),
        hooksIndexKey(effectiveRunId),
        eventsIndexKey(effectiveRunId),
        eventsByCorrelationKey(effectiveRunId, data.correlationId),
        stringifyWithUint8Array(newHook),
        data.correlationId,
        now.getTime().toString(),
        stringifyWithUint8Array(event),
        placeholder,
        eventKeyPrefix(effectiveRunId),
      )) as [number, string, string];

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

        const conflictEvent = await appendEventAtNextSlot({
          eventType: 'hook_conflict' as const,
          correlationId: data.correlationId,
          eventData: {
            token: eventData.token,
            ...(conflictingRunId ? { conflictingRunId } : {}),
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

      if (result[0] === 0) {
        // Same (runId, hookId, token) already fully created: entity and
        // event are written atomically, so the event is guaranteed to be
        // in the log. The runtime's concurrent-replay path swallows this.
        throw new EntityConflictError(`Hook "${data.correlationId}" already created`);
      }

      const storedEvent = { ...event, eventId: result[2] };
      hook = HookSchema.parse(compact(newHook));
      await mirrorEventToStream(storedEvent);
      const parsed = EventSchema.parse(storedEvent);
      return { event: stripEventDataRefs(parsed, resolveData), hook };
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
      const placeholder = eventIdPlaceholder();
      const event = {
        ...data,
        runId: effectiveRunId,
        eventId: placeholder,
        createdAt: now,
        specVersion: effectiveSpecVersion,
      };

      const result = (await scripts.wfCreateWaitWithEvent(
        waitKey(effectiveRunId, data.correlationId),
        waitsIndexKey(effectiveRunId),
        eventsIndexKey(effectiveRunId),
        eventsByCorrelationKey(effectiveRunId, data.correlationId),
        stringifyWithUint8Array(newWait),
        data.correlationId,
        now.getTime().toString(),
        stringifyWithUint8Array(event),
        placeholder,
        eventKeyPrefix(effectiveRunId),
      )) as [number, string, string];

      debug('wait_created lua result', { wasCreated: result[0], waitId: data.correlationId });

      if (result[0] === 0) {
        throw new EntityConflictError(`Wait "${data.correlationId}" already exists`);
      }

      const storedEvent = { ...event, eventId: result[2] };
      wait = WaitSchema.parse(compact(newWait));
      await mirrorEventToStream(storedEvent);
      const parsed = EventSchema.parse(storedEvent);
      return { event: stripEventDataRefs(parsed, resolveData), wait };
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
        const placeholder = eventIdPlaceholder();
        const event = {
          ...data,
          runId: effectiveRunId,
          eventId: placeholder,
          createdAt: now,
          specVersion: effectiveSpecVersion,
        };

        const result = (await scripts.wfCasCompleteWaitWithEvent(
          waitKey(effectiveRunId, data.correlationId),
          eventsIndexKey(effectiveRunId),
          eventsByCorrelationKey(effectiveRunId, data.correlationId),
          casDigest(existingData),
          stringifyWithUint8Array(updatedWait),
          stringifyWithUint8Array(event),
          placeholder,
          eventKeyPrefix(effectiveRunId),
        )) as [number, string];

        if (result[0] === 1) {
          const storedEvent = { ...event, eventId: result[1] };
          wait = WaitSchema.parse(compact(updatedWait));
          await mirrorEventToStream(storedEvent);
          const parsed = EventSchema.parse(storedEvent);
          return { event: stripEventDataRefs(parsed, resolveData), wait };
        }
        if (result[0] === -1) {
          throw new WorkflowWorldError(`Wait "${data.correlationId}" not found`, {
            status: 404,
          });
        }
        // CAS mismatch: re-read (a concurrent completion will surface as
        // EntityConflictError on the next iteration).
      }
      throw new WorkflowWorldError(`Concurrent update contention on wait "${data.correlationId}"`, {
        status: 500,
      });
    }

    // ============================================================
    // Entity transition events (entity updated via CAS, then the event is
    // appended by the generic store below)
    // ============================================================

    // Handle run_started event: transition run to running via CAS
    if (data.eventType === 'run_started') {
      // Core reads the per-run event ceiling only from the run_started response, so
      // omitting it here would drop the limit on every replay after the first.
      if (currentRun?.status === 'running') {
        // Resume path, hit on every re-invocation: the validation read above
        // already holds the body. Idempotent: no duplicate event is appended.
        const existingData = validationRunJson ?? (await redis.get(runKey(effectiveRunId)));
        if (!existingData) {
          throw new WorkflowRunNotFoundError(effectiveRunId);
        }
        const parsed = WorkflowRunSchema.parse(
          compact(parseWithUint8Array<WorkflowRun>(existingData)),
        );
        if (params?.skipPreload) {
          return {
            run: filterRunData(parsed, resolveData) as WorkflowRun,
            maxEvents: maxEventsPerRun,
          };
        }
        const preloaded = await preloadAllEvents(effectiveRunId, resolveData);
        return {
          run: filterRunData(parsed, resolveData) as WorkflowRun,
          events: preloaded.events,
          cursor: preloaded.cursor,
          hasMore: preloaded.hasMore,
          maxEvents: maxEventsPerRun,
        };
      }

      for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS && !run; attempt++) {
        const existingData =
          attempt === 0 && validationRunJson
            ? validationRunJson
            : await redis.get(runKey(effectiveRunId));
        if (!existingData) {
          throw new WorkflowRunNotFoundError(effectiveRunId);
        }
        const existing = parseWithUint8Array<WorkflowRun>(existingData);
        if (existing.status === 'running') {
          const parsed = WorkflowRunSchema.parse(compact(existing));
          if (params?.skipPreload) {
            return {
              run: filterRunData(parsed, resolveData) as WorkflowRun,
              maxEvents: maxEventsPerRun,
            };
          }
          const preloaded = await preloadAllEvents(effectiveRunId, resolveData);
          return {
            run: filterRunData(parsed, resolveData) as WorkflowRun,
            events: preloaded.events,
            cursor: preloaded.cursor,
            hasMore: preloaded.hasMore,
            maxEvents: maxEventsPerRun,
          };
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
        () => ({
          output: eventData?.output,
          error: undefined,
        }),
      );
    }

    // Handle run_failed event: CAS transition + cleanup hooks/waits. The
    // error payload is serialized data and is stored verbatim.
    if (data.eventType === 'run_failed') {
      const eventData = data.eventData;
      run = await applyTerminalRunTransition(effectiveRunId, 'run_failed', 'failed', now, () => ({
        output: undefined,
        error: eventData.error,
        errorCode: eventData.errorCode,
      }));
    }

    // Handle run_cancelled event: CAS transition + cleanup hooks/waits
    if (data.eventType === 'run_cancelled') {
      run = await applyTerminalRunTransition(
        effectiveRunId,
        'run_cancelled',
        'cancelled',
        now,
        () => ({
          output: undefined,
          error: undefined,
        }),
      );
    }

    // Handle attr_set event: merge the changes onto the run entity via CAS.
    // A workflow-writer attr_set with a correlationId is deduplicated by an
    // atomic claim, so a replayed event cannot apply (or log) twice.
    if (data.eventType === 'attr_set') {
      const eventData = data.eventData;
      for (let attempt = 0; ; attempt++) {
        if (attempt >= MAX_CAS_ATTEMPTS) {
          throw new WorkflowWorldError(`Concurrent update contention on run "${effectiveRunId}"`, {
            status: 500,
          });
        }
        const existingData = await redis.get(runKey(effectiveRunId));
        if (!existingData) {
          throw new WorkflowRunNotFoundError(effectiveRunId);
        }
        const existing = parseWithUint8Array<WorkflowRun>(existingData);
        validateAttributeChanges(eventData.changes, {
          existingKeys: Object.keys(existing.attributes ?? {}),
          allowReservedAttributes: eventData.allowReservedAttributes === true,
        });
        // Claim only after validation: a validation failure must leave the
        // correlationId unclaimed so a retry is not misreported as a dup.
        if (attempt === 0 && data.correlationId && eventData.writer.type === 'workflow') {
          const claimed = await redis.set(
            attrClaimKey(effectiveRunId, data.correlationId),
            '1',
            'NX',
          );
          if (claimed === null) {
            throw new EntityConflictError(`Attribute event "${data.correlationId}" already exists`);
          }
        }
        const updated = {
          ...existing,
          attributes: applyAttributeChanges(existing.attributes ?? {}, eventData.changes),
          updatedAt: now,
        };
        const result = await scripts.wfCasUpdateEntity(
          runKey(effectiveRunId),
          casDigest(existingData),
          stringifyWithUint8Array(updated),
        );
        if (result === null) {
          throw new WorkflowRunNotFoundError(effectiveRunId);
        }
        if (result === 1) {
          run = WorkflowRunSchema.parse(compact(updated));
          break;
        }
      }
    }

    // Handle step_started event: increment attempt, set status to 'running'.
    // The lazy path first creates the step (SETNX is the exactly-once
    // ownership claim) plus a synthetic step_created event at the prior slot.
    if (data.eventType === 'step_started' && data.correlationId) {
      const stepId = data.correlationId;
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
        const placeholder = eventIdPlaceholder();
        const stepCreatedEvent = {
          eventType: 'step_created' as const,
          runId: effectiveRunId,
          eventId: placeholder,
          createdAt: now,
          specVersion: effectiveSpecVersion,
          correlationId: stepId,
          eventData: { stepName: lazyData.stepName, input: lazyData.input },
        };
        const result = (await scripts.wfCreateStepWithEvent(
          stepKey(effectiveRunId, stepId),
          stepsIndexKey(effectiveRunId),
          eventsIndexKey(effectiveRunId),
          eventsByCorrelationKey(effectiveRunId, stepId),
          stringifyWithUint8Array(newStep),
          stepId,
          now.getTime().toString(),
          stringifyWithUint8Array(stepCreatedEvent),
          placeholder,
          eventKeyPrefix(effectiveRunId),
        )) as [number, string, string];
        if (result[0] === 0) {
          // A concurrent handler won the create claim: the runtime maps this
          // to `skipped`, so the loser never runs the step body.
          throw new EntityConflictError(`Step "${stepId}" already created`);
        }
        await mirrorEventToStream({ ...stepCreatedEvent, eventId: result[2] });
        stepCreatedLazily = true;
      }
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

    // Handle step_failed event: terminal state with the serialized error
    // stored verbatim.
    if (data.eventType === 'step_failed' && data.correlationId) {
      const eventData = data.eventData;
      step = await applyStepUpdate(effectiveRunId, data.correlationId, now, () => ({
        status: 'failed' as const,
        error: eventData.error,
        completedAt: now,
      }));
    }

    // Handle step_retrying event: sets status back to 'pending', records error
    if (data.eventType === 'step_retrying' && data.correlationId) {
      const eventData = data.eventData;
      step = await applyStepUpdate(effectiveRunId, data.correlationId, now, () => ({
        status: 'pending' as const,
        error: eventData.error,
        retryAfter: eventData.retryAfter,
      }));
    }

    // Handle hook_disposed event: delete hook entity atomically via Lua
    if (data.eventType === 'hook_disposed' && data.correlationId) {
      const hookData = await redis.get(hookKey(data.correlationId));
      if (hookData) {
        const existingHook = parseWithUint8Array<Hook>(hookData);
        await scripts.wfDisposeHook(
          hookKey(data.correlationId),
          hooksByTokenKey(existingHook.token),
          hooksIndexKey(effectiveRunId),
          data.correlationId,
        );
      }
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

  const create = (async (
    runId: string | null,
    data: CreateEventRequest | RunCreatedEventRequest,
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

  return {
    create,

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

    list: listEvents,

    async listByCorrelationId(
      params: ListEventsByCorrelationIdParams,
    ): Promise<PaginatedResponse<Event>> {
      const limit = params?.pagination?.limit ?? 100;
      const sortOrder = params.pagination?.sortOrder || 'asc';
      const fromCursor = params?.pagination?.cursor;

      // A correlation id identifies a step/hook/wait within its run, so the
      // index is scoped by run.
      const indexKey = eventsByCorrelationKey(params.runId, params.correlationId);
      const start = fromCursor
        ? await resolveCursorRank(redis, indexKey, fromCursor, sortOrder)
        : 0;
      const eventIds = await fetchEventIds(indexKey, start, limit, sortOrder);

      const eventPipeline = redis.pipeline();
      for (const eid of eventIds) {
        eventPipeline.get(eventKey(params.runId, eid));
      }
      const results = await eventPipeline.exec();

      const events = parseEventsFromPipeline(results);
      const values = events.slice(0, limit);
      const hasMore = events.length > limit;

      const resolveData = params?.resolveData ?? 'all';
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

/**
 * Create storage for workflow steps using Redis strings and sorted sets
 */
export function createStepsStorage(config: RedisStorageConfig): Storage['steps'] {
  const { redis, keyPrefix } = config;

  const stepKey = (runId: string, stepId: string) => `${keyPrefix}step:${runId}:${stepId}`;
  const stepsIndexKey = (runId: string) => `${keyPrefix}steps:by_run:${runId}`;

  return {
    get: (async (runId: string, stepId: string, params?: GetStepParams) => {
      const data = await redis.get(stepKey(runId, stepId));

      if (!data) {
        throw new WorkflowWorldError(`Step not found: ${stepId}`, {
          status: 404,
        });
      }

      const step = parseWithUint8Array<Step>(data);
      const parsed = StepSchema.parse(compact(step));
      const resolveData = params?.resolveData ?? 'all';
      return filterStepData(parsed, resolveData);
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
 * Create storage for hooks using Redis strings and sorted sets
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

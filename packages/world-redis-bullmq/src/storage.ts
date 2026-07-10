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
  WorkflowRunSchema,
} from '@workflow/world';
import type { Redis } from 'ioredis';
import { monotonicFactory } from 'ulid';
import { compact } from './util.js';

interface RedisStorageConfig {
  redis: Redis;
  keyPrefix: string;
}

/**
 * Date fields that need to be converted from ISO strings back to Date objects
 * when deserializing from Redis JSON storage.
 *
 * CRITICAL: Redis stores objects as JSON strings via JSON.stringify().
 * When JSON.parse() is called, Date objects remain as ISO string dates.
 * This breaks the TypeScript contract which expects Date objects.
 * PostgreSQL's Drizzle ORM handles this automatically, but Redis requires manual conversion.
 */
const DATE_FIELDS = new Set(['createdAt', 'updatedAt', 'startedAt', 'completedAt', 'retryAfter']);

/**
 * Reviver function for JSON.parse() that converts ISO date strings to Date objects.
 * This ensures that Date fields in WorkflowRun, Step, Event, and Hook objects
 * are properly deserialized as Date instances rather than strings.
 */
function dateReviver(key: string, value: any): any {
  if (DATE_FIELDS.has(key) && typeof value === 'string') {
    const date = new Date(value);
    // Validate that it's a valid date
    return Number.isNaN(date.getTime()) ? value : date;
  }
  return value;
}

/**
 * JSON replacer function that converts Uint8Array to a special marker object.
 * This ensures Uint8Array fields are preserved through JSON.stringify/parse.
 *
 * Handles any field that contains a Uint8Array, including nested fields like
 * eventData.result (step_completed), eventData.output (run_completed),
 * and top-level fields like input, output, executionContext.
 */
function uint8ArrayReplacer(_key: string, value: any): any {
  if (value instanceof Uint8Array) {
    return {
      __uint8array: true,
      data: Array.from(value),
    };
  }
  return value;
}

/**
 * JSON reviver function that converts marker objects back to Uint8Array.
 */
function uint8ArrayReviver(key: string, value: any): any {
  // First apply date revival
  const dateValue = dateReviver(key, value);

  // Then check for Uint8Array marker
  if (dateValue && typeof dateValue === 'object' && dateValue.__uint8array === true) {
    return new Uint8Array(dateValue.data);
  }

  return dateValue;
}

/**
 * Stringify an object with Uint8Array support.
 */
function stringifyWithUint8Array(obj: any): string {
  return JSON.stringify(obj, uint8ArrayReplacer);
}

/**
 * Parse JSON with Uint8Array and Date support.
 */
function parseWithUint8Array<T>(json: string): T {
  return JSON.parse(json, uint8ArrayReviver);
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
// Redis, preventing partial writes on connection failures.

/**
 * Atomically create a run entity with all its indexes.
 * Uses SET NX for idempotency - returns existing data on replay.
 *
 * KEYS[1] = run key
 * KEYS[2] = runs index key
 * KEYS[3] = runs by name key
 * KEYS[4] = runs by status key
 * ARGV[1] = run JSON
 * ARGV[2] = run ID
 * ARGV[3] = score (timestamp)
 * Returns: [wasCreated (0|1), runJson]
 */
const LUA_CREATE_RUN = `
  local runKey = KEYS[1]
  local runsIndex = KEYS[2]
  local byNameIndex = KEYS[3]
  local byStatusIndex = KEYS[4]
  local runJson = ARGV[1]
  local runId = ARGV[2]
  local score = tonumber(ARGV[3])

  local wasCreated = redis.call('SETNX', runKey, runJson)
  redis.call('ZADD', runsIndex, score, runId)
  redis.call('ZADD', byNameIndex, score, runId)
  redis.call('ZADD', byStatusIndex, score, runId)

  if wasCreated == 0 then
    return {0, redis.call('GET', runKey)}
  end
  return {1, runJson}
`;

/**
 * Atomically update a run's status and move it between status indexes.
 *
 * KEYS[1] = run key
 * KEYS[2] = old status index key
 * KEYS[3] = new status index key
 * ARGV[1] = updated run JSON
 * ARGV[2] = run ID
 * ARGV[3] = score (timestamp)
 * Returns: updated run JSON or nil if run doesn't exist
 */
const LUA_UPDATE_RUN_STATUS = `
  local runKey = KEYS[1]
  local oldStatusIndex = KEYS[2]
  local newStatusIndex = KEYS[3]
  local updatedJson = ARGV[1]
  local runId = ARGV[2]
  local score = tonumber(ARGV[3])

  local existing = redis.call('GET', runKey)
  if not existing then
    return nil
  end

  redis.call('SET', runKey, updatedJson)
  redis.call('ZREM', oldStatusIndex, runId)
  redis.call('ZADD', newStatusIndex, score, runId)
  return updatedJson
`;

/**
 * Atomically create a step entity with its index.
 * Uses SET NX for idempotency.
 *
 * KEYS[1] = step key
 * KEYS[2] = steps index key
 * ARGV[1] = step JSON
 * ARGV[2] = step ID (correlationId)
 * ARGV[3] = score (timestamp)
 * Returns: [wasCreated (0|1), stepJson]
 */
const LUA_CREATE_STEP = `
  local stepKey = KEYS[1]
  local stepsIndex = KEYS[2]
  local stepJson = ARGV[1]
  local stepId = ARGV[2]
  local score = tonumber(ARGV[3])

  local wasCreated = redis.call('SETNX', stepKey, stepJson)
  redis.call('ZADD', stepsIndex, score, stepId)

  if wasCreated == 0 then
    return {0, redis.call('GET', stepKey)}
  end
  return {1, stepJson}
`;

/**
 * Atomically create a hook entity with its indexes (hook key + token lookup + run index).
 * Uses SET NX for idempotency.
 *
 * KEYS[1] = hook key
 * KEYS[2] = hooks by token key
 * KEYS[3] = hooks index key
 * ARGV[1] = hook JSON
 * ARGV[2] = hook ID (correlationId)
 * ARGV[3] = token value to store as hooksByToken value
 * ARGV[4] = score (timestamp)
 * Returns: [wasCreated (0|1), hookJson]
 */
const LUA_CREATE_HOOK = `
  local hookKey = KEYS[1]
  local byTokenKey = KEYS[2]
  local hooksIndex = KEYS[3]
  local hookJson = ARGV[1]
  local hookId = ARGV[2]
  local tokenValue = ARGV[3]
  local score = tonumber(ARGV[4])

  local wasCreated = redis.call('SETNX', hookKey, hookJson)
  redis.call('SET', byTokenKey, tokenValue)
  redis.call('ZADD', hooksIndex, score, hookId)

  if wasCreated == 0 then
    return {0, redis.call('GET', hookKey)}
  end
  return {1, hookJson}
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
 * Atomically store an event and add it to run + correlation indexes.
 *
 * KEYS[1] = event key
 * KEYS[2] = events by run index key
 * KEYS[3] = events by correlation index key (or unused placeholder)
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

  // Helper: Calculate start position from cursor
  async function calculateStartPosition(
    indexKey: string,
    cursor: string | undefined,
  ): Promise<number> {
    if (!cursor) {
      return 0;
    }
    const rank = await redis.zrevrank(indexKey, cursor);
    // If the cursor vanished from the index, restart from the beginning
    // (duplicates are preferable to silently skipping the first item).
    return rank === null ? 0 : rank + 1;
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
      let start = await calculateStartPosition(indexKey, fromCursor);

      // Keep scanning the index until limit+1 matches are collected (needed
      // to compute hasMore) or the index is exhausted. A single fetch is not
      // enough when combined workflowName+status filtering happens in memory
      // after the index scan — it would produce premature empty pages and
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

  // Helper: Check whether a hook_created event for (runId, hookId) is in the
  // event log. Used to distinguish a duplicate hook_created delivery (event
  // present) from a crash orphan (hook entity written, event write lost).
  async function hookCreatedEventExists(runId: string, hookId: string): Promise<boolean> {
    const eventIds = await redis.zrange(eventsByCorrelationKey(hookId), 0, -1);
    if (eventIds.length === 0) {
      return false;
    }
    const pipeline = redis.pipeline();
    for (const eid of eventIds) {
      pipeline.get(eventKey(eid));
    }
    const results = await pipeline.exec();
    for (const result of results ?? []) {
      if (!result?.[1]) {
        continue;
      }
      const event = parseWithUint8Array<Event>(result[1] as string);
      if (event.eventType === 'hook_created' && event.runId === runId) {
        return true;
      }
    }
    return false;
  }

  // Helper: Calculate start position from cursor with sort order
  async function calculateEventStartPosition(
    indexKey: string,
    cursor: string | undefined,
    sortOrder: 'asc' | 'desc',
  ): Promise<number> {
    if (!cursor) {
      return 0;
    }
    const rankFn = sortOrder === 'desc' ? 'zrevrank' : 'zrank';
    const rank = await redis[rankFn](indexKey, cursor);
    // If the cursor vanished from the index, restart from the beginning
    // (duplicates are preferable to silently skipping the first item).
    return rank === null ? 0 : rank + 1;
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
  function parseEventsFromPipeline(results: any[] | null): Event[] {
    const events: Event[] = [];

    for (const result of results ?? []) {
      if (result?.[1]) {
        const event = parseWithUint8Array<Event>(result[1] as string);
        events.push(event);
      }
    }

    return events;
  }

  /**
   * Handle events for legacy runs (pre-event-sourcing, specVersion < 2).
   */
  async function handleLegacyEvent(
    runId: string,
    eventId: string,
    data: any,
    currentRun: { status: string; specVersion?: number },
    params?: { resolveData?: ResolveData },
  ): Promise<EventResult> {
    const resolveData = params?.resolveData ?? 'all';

    switch (data.eventType) {
      case 'run_cancelled': {
        // Legacy: Skip event storage, directly update run to cancelled atomically via Lua
        const now = new Date();
        const existingData = await redis.get(runKey(runId));
        if (existingData) {
          const existing = parseWithUint8Array<WorkflowRun>(existingData);
          const updatedRun = {
            ...existing,
            status: 'cancelled' as const,
            completedAt: now,
            updatedAt: now,
          };

          await redis.eval(
            LUA_UPDATE_RUN_STATUS,
            3,
            runKey(runId),
            runsByStatusKey(existing.status),
            runsByStatusKey('cancelled'),
            stringifyWithUint8Array(updatedRun),
            runId,
            now.getTime().toString(),
          );

          // Cleanup hooks
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
        // Legacy: Store event only (no entity mutation) atomically via Lua
        const createdAt = new Date();
        const event: Event = {
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

      // Helper to check if run is in terminal state
      const isRunTerminal = (status: string) =>
        ['completed', 'failed', 'cancelled'].includes(status);

      // Helper to check if step is in terminal state
      const isStepTerminal = (status: string) =>
        ['completed', 'failed', 'cancelled'].includes(status);

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
        const runInputData = (data as any).eventData as {
          deploymentId?: string;
          workflowName?: string;
          input?: any;
          executionContext?: any;
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
          // Use Lua script for atomic idempotent creation
          const score = now.getTime();
          const result = (await redis.eval(
            LUA_CREATE_RUN,
            4,
            runKey(effectiveRunId),
            runsIndexKey(),
            runsByNameKey(runInputData.workflowName),
            runsByStatusKey('pending'),
            stringifyWithUint8Array(newRun),
            effectiveRunId,
            score.toString(),
          )) as [number, string];
          if (result[0] === 1) {
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
            await redis.eval(
              LUA_STORE_EVENT,
              3,
              eventKey(runCreatedEventId),
              eventsIndexKey(effectiveRunId),
              '__unused__',
              stringifyWithUint8Array(runCreatedEvent),
              runCreatedEventId,
              score.toString(),
              '0',
            );
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
          throw new RunNotSupportedError(currentRun.specVersion!, SPEC_VERSION_CURRENT);
        }

        if (isLegacySpecVersion(currentRun.specVersion)) {
          return handleLegacyEvent(effectiveRunId, eventId, data, currentRun, params);
        }
      }

      // Run terminal state validation
      if (currentRun && isRunTerminal(currentRun.status)) {
        const runTerminalEvents = ['run_started', 'run_completed', 'run_failed'];

        // Idempotent operation: run_cancelled on already cancelled run is allowed
        if (data.eventType === 'run_cancelled' && currentRun.status === 'cancelled') {
          // Get full run for return value
          const fullRunData = await redis.get(runKey(effectiveRunId));

          // Create the event atomically via Lua (still record it)
          const createdAt = new Date();
          const event = {
            ...data,
            runId: effectiveRunId,
            eventId,
            createdAt,
            specVersion: effectiveSpecVersion,
          };
          const score = createdAt.getTime();
          await redis.eval(
            LUA_STORE_EVENT,
            3,
            eventKey(eventId),
            eventsIndexKey(effectiveRunId),
            '__unused__',
            stringifyWithUint8Array(event),
            eventId,
            score.toString(),
            '0',
          );

          const parsed = EventSchema.parse(event);
          const resolveData = params?.resolveData ?? 'all';
          return {
            event: filterEventData(parsed, resolveData),
            run: fullRunData
              ? (parseWithUint8Array<WorkflowRun>(fullRunData) as WorkflowRun)
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

      // Step-related event validation
      let validatedStep: { status: string; startedAt?: Date; retryAfter?: Date } | null = null;
      const stepEventsNeedingValidation = ['step_started', 'step_retrying'];
      if (stepEventsNeedingValidation.includes(data.eventType) && data.correlationId) {
        const stepData = await redis.get(stepKey(effectiveRunId, data.correlationId));
        if (stepData) {
          const parsed = parseWithUint8Array<Step>(stepData);
          validatedStep = {
            status: parsed.status,
            startedAt: parsed.startedAt,
            retryAfter: parsed.retryAfter,
          };
        }

        if (!validatedStep) {
          throw new WorkflowWorldError(`Step "${data.correlationId}" not found`, { status: 404 });
        }

        // EntityConflictError so core's step handler skips the duplicate
        // delivery and re-enqueues the workflow (crash-recovery nudge).
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

      // Hook-related event validation
      const hookEventsRequiringExistence = ['hook_disposed', 'hook_received'];
      if (hookEventsRequiringExistence.includes(data.eventType) && data.correlationId) {
        const existingHook = await redis.get(hookKey(data.correlationId));
        if (!existingHook) {
          throw new HookNotFoundError(data.correlationId);
        }
      }

      // ============================================================
      // Entity creation/updates based on event type
      // ============================================================

      // Handle run_created event: create the run entity atomically
      if (data.eventType === 'run_created') {
        const eventData = (data as any).eventData as {
          deploymentId: string;
          workflowName: string;
          input: any[];
          executionContext?: Record<string, any>;
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

        // Use Lua script for atomic idempotent creation (SET NX + indexes)
        const score = now.getTime();
        const result = (await redis.eval(
          LUA_CREATE_RUN,
          4,
          runKey(effectiveRunId),
          runsIndexKey(),
          runsByNameKey(eventData.workflowName),
          runsByStatusKey('pending'),
          stringifyWithUint8Array(newRun),
          effectiveRunId,
          score.toString(),
        )) as [number, string];

        if (result[0] === 1) {
          run = WorkflowRunSchema.parse(compact(newRun));
        } else {
          // Event replay: parse existing run from Lua result
          run = WorkflowRunSchema.parse(compact(parseWithUint8Array<WorkflowRun>(result[1])));
        }
      }

      // Handle run_started event: update run status atomically via Lua
      if (data.eventType === 'run_started') {
        // Idempotency: if run is already past pending, this is a replay.
        // Return existing run state without creating a duplicate event.
        if (currentRun?.status === 'running') {
          const existingData = await redis.get(runKey(effectiveRunId));
          if (existingData) {
            run = WorkflowRunSchema.parse(compact(parseWithUint8Array<WorkflowRun>(existingData)));
          }
          const resolveData = params?.resolveData ?? 'all';
          return { run: run ? (filterRunData(run, resolveData) as WorkflowRun) : undefined };
        }

        const existingData = await redis.get(runKey(effectiveRunId));
        if (!existingData) {
          // No run and no resilient-start bootstrap data — logging a
          // run_started event against a nonexistent run would corrupt the
          // event log, so fail loudly instead.
          throw new WorkflowRunNotFoundError(effectiveRunId);
        }
        const existing = parseWithUint8Array<WorkflowRun>(existingData);
        const updatedRun = {
          ...existing,
          status: 'running' as const,
          startedAt: now,
          updatedAt: now,
        };

        await redis.eval(
          LUA_UPDATE_RUN_STATUS,
          3,
          runKey(effectiveRunId),
          runsByStatusKey(existing.status),
          runsByStatusKey('running'),
          stringifyWithUint8Array(updatedRun),
          effectiveRunId,
          now.getTime().toString(),
        );

        run = WorkflowRunSchema.parse(compact(updatedRun));
      }

      // Handle run_completed event: update run status atomically via Lua and cleanup hooks
      if (data.eventType === 'run_completed') {
        const eventData = (data as any).eventData as { output?: any };
        const existingData = await redis.get(runKey(effectiveRunId));
        if (!existingData) {
          throw new WorkflowRunNotFoundError(effectiveRunId);
        }
        const existing = parseWithUint8Array<WorkflowRun>(existingData);
        const updatedRun = {
          ...existing,
          status: 'completed' as const,
          output: eventData.output,
          completedAt: now,
          updatedAt: now,
        };

        await redis.eval(
          LUA_UPDATE_RUN_STATUS,
          3,
          runKey(effectiveRunId),
          runsByStatusKey(existing.status),
          runsByStatusKey('completed'),
          stringifyWithUint8Array(updatedRun),
          effectiveRunId,
          now.getTime().toString(),
        );

        await cleanupHooks(effectiveRunId);

        run = WorkflowRunSchema.parse(compact(updatedRun));
      }

      // Handle run_failed event: update run status atomically via Lua and cleanup hooks
      if (data.eventType === 'run_failed') {
        const eventData = (data as any).eventData as {
          error: any;
          errorCode?: string;
        };
        const errorMessage =
          typeof eventData.error === 'string'
            ? eventData.error
            : (eventData.error?.message ?? 'Unknown error');

        const existingData = await redis.get(runKey(effectiveRunId));
        if (!existingData) {
          throw new WorkflowRunNotFoundError(effectiveRunId);
        }
        const existing = parseWithUint8Array<WorkflowRun>(existingData);
        const updatedRun = {
          ...existing,
          status: 'failed' as const,
          error: {
            message: errorMessage,
            stack: eventData.error?.stack,
            code: eventData.errorCode,
          },
          completedAt: now,
          updatedAt: now,
        };

        await redis.eval(
          LUA_UPDATE_RUN_STATUS,
          3,
          runKey(effectiveRunId),
          runsByStatusKey(existing.status),
          runsByStatusKey('failed'),
          stringifyWithUint8Array(updatedRun),
          effectiveRunId,
          now.getTime().toString(),
        );

        await cleanupHooks(effectiveRunId);

        run = WorkflowRunSchema.parse(compact(updatedRun));
      }

      // Handle run_cancelled event: update run status atomically via Lua and cleanup hooks
      if (data.eventType === 'run_cancelled') {
        const existingData = await redis.get(runKey(effectiveRunId));
        if (!existingData) {
          throw new WorkflowRunNotFoundError(effectiveRunId);
        }
        const existing = parseWithUint8Array<WorkflowRun>(existingData);
        const updatedRun = {
          ...existing,
          status: 'cancelled' as const,
          completedAt: now,
          updatedAt: now,
        };

        await redis.eval(
          LUA_UPDATE_RUN_STATUS,
          3,
          runKey(effectiveRunId),
          runsByStatusKey(existing.status),
          runsByStatusKey('cancelled'),
          stringifyWithUint8Array(updatedRun),
          effectiveRunId,
          now.getTime().toString(),
        );

        await cleanupHooks(effectiveRunId);

        run = WorkflowRunSchema.parse(compact(updatedRun));
      }

      // Handle step_created event: create step entity
      if (data.eventType === 'step_created') {
        const eventData = (data as any).eventData as {
          stepName: string;
          input: any;
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

        // Use Lua script for atomic idempotent creation (SET NX + index)
        const score = now.getTime();
        const result = (await redis.eval(
          LUA_CREATE_STEP,
          2,
          stepKey(effectiveRunId, data.correlationId!),
          stepsIndexKey(effectiveRunId),
          stringifyWithUint8Array(newStep),
          data.correlationId!,
          score.toString(),
        )) as [number, string];

        if (result[0] === 1) {
          step = StepSchema.parse(compact(newStep));
        } else {
          // Event replay: parse existing step from Lua result
          step = StepSchema.parse(compact(parseWithUint8Array<Step>(result[1])));
        }
      }

      // Handle step_started event: increment attempt, set status to 'running'
      if (data.eventType === 'step_started') {
        // Retried steps may be scheduled for later. TooEarlyError tells core
        // to re-deliver after the remaining backoff instead of starting the
        // step before its retryAfter timestamp.
        if (validatedStep?.retryAfter && validatedStep.retryAfter.getTime() > Date.now()) {
          throw new TooEarlyError(
            `Cannot start step "${data.correlationId}": retryAfter timestamp has not been reached yet`,
            {
              retryAfter: Math.ceil((validatedStep.retryAfter.getTime() - Date.now()) / 1000),
            },
          );
        }

        const isFirstStart = !validatedStep?.startedAt;
        const existingData = await redis.get(stepKey(effectiveRunId, data.correlationId!));
        if (existingData) {
          const existing = parseWithUint8Array<Step>(existingData);
          const updatedStep = {
            ...existing,
            status: 'running' as const,
            attempt: existing.attempt + 1,
            ...(isFirstStart ? { startedAt: now } : {}),
            // The step has left the backoff window — always clear retryAfter.
            retryAfter: undefined,
            updatedAt: now,
          };
          await redis.set(
            stepKey(effectiveRunId, data.correlationId!),
            stringifyWithUint8Array(updatedStep),
          );
          step = StepSchema.parse(compact(updatedStep));
        }
      }

      // Handle step_completed event: update step status
      if (data.eventType === 'step_completed') {
        const eventData = (data as any).eventData as { result?: any };
        const existingData = await redis.get(stepKey(effectiveRunId, data.correlationId!));
        if (existingData) {
          const existing = parseWithUint8Array<Step>(existingData);
          if (['completed', 'failed', 'cancelled'].includes(existing.status)) {
            throw new EntityConflictError(
              `Cannot modify step in terminal state "${existing.status}"`,
            );
          }
          const updatedStep = {
            ...existing,
            status: 'completed' as const,
            output: eventData.result,
            completedAt: now,
            updatedAt: now,
          };
          await redis.set(
            stepKey(effectiveRunId, data.correlationId!),
            stringifyWithUint8Array(updatedStep),
          );
          step = StepSchema.parse(compact(updatedStep));
        } else {
          throw new WorkflowWorldError(`Step "${data.correlationId}" not found`, { status: 404 });
        }
      }

      // Handle step_failed event: terminal state with error
      if (data.eventType === 'step_failed') {
        const eventData = (data as any).eventData as {
          error?: any;
          stack?: string;
        };
        const errorMessage =
          typeof eventData.error === 'string'
            ? eventData.error
            : (eventData.error?.message ?? 'Unknown error');

        const existingData = await redis.get(stepKey(effectiveRunId, data.correlationId!));
        if (existingData) {
          const existing = parseWithUint8Array<Step>(existingData);
          if (['completed', 'failed', 'cancelled'].includes(existing.status)) {
            throw new EntityConflictError(
              `Cannot modify step in terminal state "${existing.status}"`,
            );
          }
          const updatedStep = {
            ...existing,
            status: 'failed' as const,
            error: {
              message: errorMessage,
              stack: eventData.stack,
            },
            completedAt: now,
            updatedAt: now,
          };
          await redis.set(
            stepKey(effectiveRunId, data.correlationId!),
            stringifyWithUint8Array(updatedStep),
          );
          step = StepSchema.parse(compact(updatedStep));
        } else {
          throw new WorkflowWorldError(`Step "${data.correlationId}" not found`, { status: 404 });
        }
      }

      // Handle step_retrying event: sets status back to 'pending', records error
      if (data.eventType === 'step_retrying') {
        const eventData = (data as any).eventData as {
          error?: any;
          stack?: string;
          retryAfter?: Date;
        };
        const errorMessage =
          typeof eventData.error === 'string'
            ? eventData.error
            : (eventData.error?.message ?? 'Unknown error');

        const existingData = await redis.get(stepKey(effectiveRunId, data.correlationId!));
        if (existingData) {
          const existing = parseWithUint8Array<Step>(existingData);
          const updatedStep = {
            ...existing,
            status: 'pending' as const,
            error: {
              message: errorMessage,
              stack: eventData.stack,
            },
            retryAfter: eventData.retryAfter,
            updatedAt: now,
          };
          await redis.set(
            stepKey(effectiveRunId, data.correlationId!),
            stringifyWithUint8Array(updatedStep),
          );
          step = StepSchema.parse(compact(updatedStep));
        }
      }

      // Handle hook_created event: create hook entity atomically via Lua
      if (data.eventType === 'hook_created') {
        const eventData = (data as any).eventData as {
          token: string;
          metadata?: any;
        };

        // Check for duplicate token
        const existingHookId = await redis.get(hooksByTokenKey(eventData.token));
        let existingHook: Hook | null = null;
        if (existingHookId) {
          const existingHookData = await redis.get(hookKey(existingHookId));
          if (existingHookData) {
            existingHook = parseWithUint8Array<Hook>(existingHookData);
          } else {
            // Dangling token index (crash during hook cleanup): the owning
            // hook entity is gone, so the token is free — drop the stale
            // index entry and reclaim the token below.
            await redis.del(hooksByTokenKey(eventData.token));
          }
        }

        if (
          existingHook &&
          (existingHook.runId !== effectiveRunId || existingHook.hookId !== data.correlationId)
        ) {
          // A different (runId, hookId) holds this token. Create a
          // hook_conflict event instead of throwing 409 — this lets the
          // workflow continue and fail gracefully when the hook is awaited.
          const conflictEventData = {
            token: eventData.token,
            conflictingRunId: existingHook.runId,
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

          const score = createdAt.getTime();
          await redis.eval(
            LUA_STORE_EVENT,
            3,
            eventKey(eventId),
            eventsIndexKey(effectiveRunId),
            data.correlationId ? eventsByCorrelationKey(data.correlationId) : '__unused__',
            stringifyWithUint8Array(conflictEvent),
            eventId,
            score.toString(),
            data.correlationId ? '1' : '0',
          );

          const parsedConflict = EventSchema.parse(conflictEvent);
          const resolveData = params?.resolveData ?? 'all';
          return {
            event: filterEventData(parsedConflict, resolveData),
            run,
            step,
            hook: undefined,
          };
        }

        if (existingHook) {
          // The existing hook is the SAME (runId, hookId) being re-created.
          // Distinguish a duplicate delivery from a crash orphan by checking
          // whether the hook_created event made it into the event log.
          if (await hookCreatedEventExists(effectiveRunId, data.correlationId!)) {
            // Real duplicate: EntityConflictError so core's concurrent-replay
            // catch path swallows it, instead of a self hook_conflict that
            // would later replay as HookConflictError.
            throw new EntityConflictError(`Hook "${data.correlationId}" already created`);
          }
          // Crash orphan (hook entity written, event write lost): reuse the
          // existing entity and fall through to the event store below, which
          // completes the partial write.
          hook = HookSchema.parse(compact(existingHook));
        } else {
          const newHook: Hook = {
            runId: effectiveRunId,
            hookId: data.correlationId!,
            token: eventData.token,
            ownerId: '',
            projectId: '',
            environment: '',
            metadata: eventData.metadata,
            specVersion: effectiveSpecVersion,
            createdAt: now,
          };

          const score = now.getTime();
          const result = (await redis.eval(
            LUA_CREATE_HOOK,
            3,
            hookKey(data.correlationId!),
            hooksByTokenKey(eventData.token),
            hooksIndexKey(effectiveRunId),
            stringifyWithUint8Array(newHook),
            data.correlationId!,
            data.correlationId!,
            score.toString(),
          )) as [number, string];

          if (result[0] === 1) {
            hook = HookSchema.parse(compact(newHook));
          } else {
            // Event replay: parse existing hook from Lua result
            hook = HookSchema.parse(compact(parseWithUint8Array<Hook>(result[1])));
          }
        }
      }

      // Handle hook_disposed event: delete hook entity atomically via Lua
      if (data.eventType === 'hook_disposed' && data.correlationId) {
        const hookData = await redis.get(hookKey(data.correlationId));
        if (!hookData) {
          // The existence guard above passed, so the hook vanished in
          // between — a concurrent disposal won the race.
          throw new EntityConflictError(`Hook "${data.correlationId}" already disposed`);
        }
        const existingHook = parseWithUint8Array<Hook>(hookData);
        const deleted = (await redis.eval(
          LUA_DISPOSE_HOOK,
          3,
          hookKey(data.correlationId),
          hooksByTokenKey(existingHook.token),
          hooksIndexKey(effectiveRunId),
          data.correlationId,
        )) as number;
        if (deleted === 0) {
          throw new EntityConflictError(`Hook "${data.correlationId}" already disposed`);
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
      if (data.eventType === 'run_started') {
        delete (event as any).eventData;
      }

      const score = createdAt.getTime();
      await redis.eval(
        LUA_STORE_EVENT,
        3,
        eventKey(eventId),
        eventsIndexKey(effectiveRunId),
        data.correlationId ? eventsByCorrelationKey(data.correlationId) : '__unused__',
        stringifyWithUint8Array(event),
        eventId,
        score.toString(),
        data.correlationId ? '1' : '0',
      );

      const parsed = EventSchema.parse(event);
      const resolveData = params?.resolveData ?? 'all';

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
        events: allEvents,
      };
    },

    async get(_runId: string, eventId: string): Promise<Event> {
      const data = await redis.get(eventKey(eventId));
      if (!data) {
        throw new WorkflowWorldError(`Event not found: ${eventId}`, {
          status: 404,
        });
      }
      return parseWithUint8Array<Event>(data);
    },

    async list(params: ListEventsParams): Promise<PaginatedResponse<Event>> {
      const limit = params?.pagination?.limit ?? 100;
      const sortOrder = params.pagination?.sortOrder || 'asc';
      const fromCursor = params?.pagination?.cursor;

      const indexKey = eventsIndexKey(params.runId);
      const start = await calculateEventStartPosition(indexKey, fromCursor, sortOrder);
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
      const start = await calculateEventStartPosition(indexKey, fromCursor, sortOrder);
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

      // ZREVRANGE for descending order. A vanished cursor restarts from the
      // beginning rather than silently skipping the first item.
      const start = fromCursor
        ? await redis.zrevrank(indexKey, fromCursor).then((rank) => (rank === null ? 0 : rank + 1))
        : 0;

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

      // ZREVRANGE for descending order. A vanished cursor restarts from the
      // beginning rather than silently skipping the first item.
      const start = fromCursor
        ? await redis.zrevrank(indexKey, fromCursor).then((rank) => (rank === null ? 0 : rank + 1))
        : 0;

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

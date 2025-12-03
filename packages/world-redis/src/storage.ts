import { WorkflowAPIError } from '@workflow/errors';
import type {
  CancelWorkflowRunParams,
  CreateEventParams,
  CreateEventRequest,
  CreateHookRequest,
  CreateStepRequest,
  CreateWorkflowRunRequest,
  Event,
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
  PauseWorkflowRunParams,
  ResolveData,
  ResumeWorkflowRunParams,
  Step,
  Storage,
  UpdateStepRequest,
  UpdateWorkflowRunRequest,
  WorkflowRun,
  WorkflowRunStatus,
} from '@workflow/world';
import { HookSchema } from '@workflow/world';
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
const DATE_FIELDS = new Set([
  'createdAt',
  'updatedAt',
  'startedAt',
  'completedAt',
  'retryAfter',
]);

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
 * Parse JSON with automatic date deserialization.
 * Use this instead of JSON.parse() for all Redis-stored objects.
 */
function parseWithDates<T>(json: string): T {
  return JSON.parse(json, dateReviver);
}

/**
 * Serialize a StructuredError object into a JSON string.
 * Stores error.message, error.stack, and error.code as a JSON string.
 * Handles both string errors (old interface) and StructuredError objects (new interface).
 */
function serializeError<T extends { error?: any }>(data: T): any {
  if (!data.error) {
    return data;
  }

  // If error is already a string, pass it through unchanged
  if (typeof data.error === 'string') {
    return data;
  }

  const { error, ...rest } = data;
  return {
    ...rest,
    error: JSON.stringify({
      message: (error as any).message,
      stack: (error as any).stack,
      code: (error as any).code,
    }),
  };
}

/**
 * Deserialize error JSON string into a StructuredError object.
 * Handles backwards compatibility with plain string errors.
 */
function deserializeError<T extends { error?: any }>(entity: T): T {
  const { error, ...rest } = entity;

  if (!error) {
    return entity;
  }

  // Try to parse as structured error JSON
  if (error) {
    try {
      const parsed = JSON.parse(error);
      if (typeof parsed === 'object' && parsed.message !== undefined) {
        return {
          ...rest,
          error: {
            message: parsed.message,
            stack: parsed.stack,
            code: parsed.code,
          },
        } as T;
      }
    } catch {
      // Not JSON, treat as plain string
    }
  }

  // Backwards compatibility: treat plain string as error message
  return {
    ...rest,
    error: {
      message: error || '',
    },
  } as T;
}

/**
 * Filter data based on ResolveData parameter.
 * When resolveData is 'none', strips specified keys to reduce data transfer.
 */
function filterData<T extends object>(
  data: T,
  resolveData: ResolveData | undefined,
  keysToStrip: (keyof T)[]
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
 * Create storage for workflow runs using Redis hashes and sorted sets
 */
export function createRunsStorage(config: RedisStorageConfig): Storage['runs'] {
  const { redis, keyPrefix } = config;
  const ulid = monotonicFactory();

  const runKey = (id: string) => `${keyPrefix}run:${id}`;
  const runsIndexKey = () => `${keyPrefix}runs:index`;
  const runsByNameKey = (name: string) => `${keyPrefix}runs:by_name:${name}`;
  const runsByStatusKey = (status: string) =>
    `${keyPrefix}runs:by_status:${status}`;

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
    cursor: string | undefined
  ): Promise<number> {
    if (!cursor) {
      return 0;
    }
    const rank = await redis.zrevrank(indexKey, cursor);
    return (rank ?? 0) + 1;
  }

  // Helper: Fetch and parse runs from pipeline results
  function parseRunsFromPipeline(
    results: any[] | null,
    params?: ListWorkflowRunsParams
  ): WorkflowRun[] {
    const runs: WorkflowRun[] = [];

    for (const result of results ?? []) {
      if (!result?.[1]) {
        continue;
      }

      const run: WorkflowRun = deserializeError(
        parseWithDates<WorkflowRun>(result[1] as string)
      );

      // Apply filters
      const statusMatches = !params?.status || run.status === params.status;
      const nameMatches =
        !params?.workflowName || run.workflowName === params.workflowName;

      if (statusMatches && nameMatches) {
        runs.push(
          compact(filterData(run, params?.resolveData, ['input', 'output']))
        );
      }
    }

    return runs;
  }

  // Helper: Calculate timestamp updates for status transitions
  function calculateTimestampUpdates(
    currentRun: WorkflowRun,
    newStatus?: WorkflowRunStatus
  ): Partial<WorkflowRun> {
    const updates: Partial<WorkflowRun> = {};

    // Set startedAt only on first transition to 'running'
    if (newStatus === 'running' && !currentRun.startedAt) {
      updates.startedAt = new Date();
    }

    // Set completedAt on terminal states
    const isBecomingTerminal =
      newStatus === 'completed' ||
      newStatus === 'failed' ||
      newStatus === 'cancelled';

    if (isBecomingTerminal) {
      updates.completedAt = new Date();
    }

    return updates;
  }

  // Helper: Clean up hooks when run reaches terminal status
  async function cleanupHooks(pipeline: any, runId: string): Promise<void> {
    const hooksIndexKey = `${keyPrefix}hooks:by_run:${runId}`;
    const hookIds = await redis.zrange(hooksIndexKey, 0, -1);

    for (const hookId of hookIds) {
      const hookData = await redis.get(`${keyPrefix}hook:${hookId}`);
      if (hookData) {
        const hook = parseWithDates<Hook>(hookData);
        pipeline.del(`${keyPrefix}hook:${hookId}`);
        pipeline.del(`${keyPrefix}hooks:by_token:${hook.token}`);
      }
    }
    pipeline.del(hooksIndexKey);
  }

  // Helper: Update status indexes when status changes
  function updateStatusIndexes(
    pipeline: any,
    runId: string,
    oldStatus: WorkflowRunStatus,
    newStatus: WorkflowRunStatus,
    timestamp: Date
  ): void {
    pipeline.zrem(runsByStatusKey(oldStatus), runId);
    pipeline.zadd(runsByStatusKey(newStatus), timestamp.getTime(), runId);
  }

  return {
    async create(data: CreateWorkflowRunRequest): Promise<WorkflowRun> {
      const runId = `wrun_${ulid()}`;
      const now = new Date();

      const run: WorkflowRun = {
        runId,
        deploymentId: data.deploymentId,
        workflowName: data.workflowName,
        status: 'pending',
        input: data.input,
        output: undefined,
        error: undefined,
        completedAt: undefined,
        executionContext: data.executionContext as Record<string, any>,
        createdAt: now,
        updatedAt: now,
      };

      // Use SET NX to ensure run doesn't already exist
      const existed = await redis.setnx(runKey(runId), JSON.stringify(run));
      if (!existed) {
        throw new WorkflowAPIError(`Run ${runId} already exists`, {
          status: 409,
        });
      }

      // Add to indexes - use timestamp as score for ordering, runId as member
      const score = now.getTime();
      await redis
        .pipeline()
        .zadd(runsIndexKey(), score, runId)
        .zadd(runsByNameKey(data.workflowName), score, runId)
        .zadd(runsByStatusKey('pending'), score, runId)
        .exec();

      return run;
    },

    async get(id: string, params?: GetWorkflowRunParams): Promise<WorkflowRun> {
      const data = await redis.get(runKey(id));
      if (!data) {
        throw new WorkflowAPIError(`Run not found: ${id}`, { status: 404 });
      }
      const run = deserializeError(parseWithDates<WorkflowRun>(data));
      return filterData(run, params?.resolveData, ['input', 'output']);
    },

    async update(
      id: string,
      data: UpdateWorkflowRunRequest
    ): Promise<WorkflowRun> {
      const existingData = await redis.get(runKey(id));
      if (!existingData) {
        throw new WorkflowAPIError(`Run not found: ${id}`, { status: 404 });
      }

      const currentRun: WorkflowRun = parseWithDates<WorkflowRun>(existingData);
      const serialized = serializeError(data);
      const timestampUpdates = calculateTimestampUpdates(
        currentRun,
        data.status
      );

      const updates: Partial<WorkflowRun> = {
        ...serialized,
        ...timestampUpdates,
        updatedAt: new Date(),
      };

      const updatedRun = { ...currentRun, ...updates } as WorkflowRun;

      // Build pipeline with updates
      const pipeline = redis
        .pipeline()
        .set(runKey(id), JSON.stringify(updatedRun));

      // Clean up hooks when run reaches terminal status
      const isBecomingTerminal =
        data.status === 'completed' ||
        data.status === 'failed' ||
        data.status === 'cancelled';

      if (isBecomingTerminal) {
        await cleanupHooks(pipeline, id);
      }

      // Update status indexes if status changed
      if (data.status && data.status !== currentRun.status) {
        updateStatusIndexes(
          pipeline,
          id,
          currentRun.status,
          data.status,
          updatedRun.updatedAt
        );
      }

      await pipeline.exec();

      return deserializeError(compact(updatedRun));
    },

    async list(
      params?: ListWorkflowRunsParams
    ): Promise<PaginatedResponse<WorkflowRun>> {
      const limit = params?.pagination?.limit ?? 20;
      const fromCursor = params?.pagination?.cursor;

      const indexKey = selectIndexKey(params);
      const start = await calculateStartPosition(indexKey, fromCursor);
      const runIds = await redis.zrevrange(indexKey, start, start + limit);

      // Fetch all runs via pipeline
      const pipeline = redis.pipeline();
      for (const runId of runIds) {
        pipeline.get(runKey(runId));
      }
      const results = await pipeline.exec();

      const runs = parseRunsFromPipeline(results, params);
      const values = runs.slice(0, limit);
      const hasMore = runs.length > limit;

      return {
        data: values,
        hasMore,
        cursor: values.at(-1)?.runId ?? null,
      };
    },

    async cancel(
      id: string,
      _params?: CancelWorkflowRunParams
    ): Promise<WorkflowRun> {
      return this.update(id, { status: 'cancelled' });
    },

    async pause(
      id: string,
      _params?: PauseWorkflowRunParams
    ): Promise<WorkflowRun> {
      return this.update(id, { status: 'paused' });
    },

    async resume(
      id: string,
      _params?: ResumeWorkflowRunParams
    ): Promise<WorkflowRun> {
      const existingData = await redis.get(runKey(id));
      if (!existingData) {
        throw new WorkflowAPIError(`Run not found: ${id}`, { status: 404 });
      }

      const currentRun: WorkflowRun = parseWithDates<WorkflowRun>(existingData);
      if (currentRun.status !== 'paused') {
        throw new WorkflowAPIError(`Paused run not found: ${id}`, {
          status: 404,
        });
      }

      const updates: Partial<WorkflowRun> = {
        status: 'running',
        updatedAt: new Date(),
      };

      // Set startedAt only if not already set
      if (!currentRun.startedAt) {
        updates.startedAt = new Date();
      }

      return this.update(id, updates);
    },
  };
}

/**
 * Create storage for workflow events using Redis hashes and sorted sets
 */
export function createEventsStorage(
  config: RedisStorageConfig
): Storage['events'] {
  const { redis, keyPrefix } = config;
  const ulid = monotonicFactory();

  const eventKey = (id: string) => `${keyPrefix}event:${id}`;
  const eventsIndexKey = (runId: string) =>
    `${keyPrefix}events:by_run:${runId}`;
  const eventsByCorrelationKey = (correlationId: string) =>
    `${keyPrefix}events:by_correlation:${correlationId}`;

  // Helper: Calculate start position from cursor with sort order
  async function calculateEventStartPosition(
    indexKey: string,
    cursor: string | undefined,
    sortOrder: 'asc' | 'desc'
  ): Promise<number> {
    if (!cursor) {
      return 0;
    }
    const rankFn = sortOrder === 'desc' ? 'zrevrank' : 'zrank';
    const rank = await redis[rankFn](indexKey, cursor);
    return (rank ?? 0) + 1;
  }

  // Helper: Fetch event IDs with proper sort order
  async function fetchEventIds(
    indexKey: string,
    start: number,
    limit: number,
    sortOrder: 'asc' | 'desc'
  ): Promise<string[]> {
    const rangeFn = sortOrder === 'desc' ? 'zrevrange' : 'zrange';
    return redis[rangeFn](indexKey, start, start + limit);
  }

  // Helper: Parse events from pipeline results
  function parseEventsFromPipeline(results: any[] | null): Event[] {
    const events: Event[] = [];

    for (const result of results ?? []) {
      if (result?.[1]) {
        const event = parseWithDates<Event>(result[1] as string);
        events.push(event);
      }
    }

    return events;
  }

  return {
    async create(
      runId: string,
      data: CreateEventRequest,
      _params?: CreateEventParams
    ): Promise<Event> {
      const eventId = `wevt_${ulid()}`;
      const createdAt = new Date();

      const event: Event = {
        ...data,
        runId,
        eventId,
        createdAt,
      };

      // Store event
      await redis.set(eventKey(eventId), JSON.stringify(event));

      // Add to indexes with timestamp as score
      const score = createdAt.getTime();
      const pipeline = redis
        .pipeline()
        .zadd(eventsIndexKey(runId), score, eventId);

      if (data.correlationId) {
        pipeline.zadd(
          eventsByCorrelationKey(data.correlationId),
          score,
          eventId
        );
      }

      await pipeline.exec();

      return event;
    },

    async list(params: ListEventsParams): Promise<PaginatedResponse<Event>> {
      const limit = params?.pagination?.limit ?? 100;
      const sortOrder = params.pagination?.sortOrder || 'asc';
      const fromCursor = params?.pagination?.cursor;

      const indexKey = eventsIndexKey(params.runId);
      const start = await calculateEventStartPosition(
        indexKey,
        fromCursor,
        sortOrder
      );
      const eventIds = await fetchEventIds(indexKey, start, limit, sortOrder);

      // Fetch events via pipeline
      const pipeline = redis.pipeline();
      for (const eventId of eventIds) {
        pipeline.get(eventKey(eventId));
      }
      const results = await pipeline.exec();

      const events = parseEventsFromPipeline(results);
      const values = events.slice(0, limit);
      const hasMore = events.length > limit;

      return {
        data: values.map(compact),
        cursor: values.at(-1)?.eventId ?? null,
        hasMore,
      };
    },

    async listByCorrelationId(
      params: ListEventsByCorrelationIdParams
    ): Promise<PaginatedResponse<Event>> {
      const limit = params?.pagination?.limit ?? 100;
      const sortOrder = params.pagination?.sortOrder || 'asc';
      const fromCursor = params?.pagination?.cursor;

      const indexKey = eventsByCorrelationKey(params.correlationId);
      const start = await calculateEventStartPosition(
        indexKey,
        fromCursor,
        sortOrder
      );
      const eventIds = await fetchEventIds(indexKey, start, limit, sortOrder);

      // Fetch events via pipeline
      const pipeline = redis.pipeline();
      for (const eventId of eventIds) {
        pipeline.get(eventKey(eventId));
      }
      const results = await pipeline.exec();

      const events = parseEventsFromPipeline(results);
      const values = events.slice(0, limit);
      const hasMore = events.length > limit;

      return {
        data: values.map(compact),
        cursor: values.at(-1)?.eventId ?? null,
        hasMore,
      };
    },
  };
}

/**
 * Create storage for workflow steps using Redis hashes and sorted sets
 */
export function createStepsStorage(
  config: RedisStorageConfig
): Storage['steps'] {
  const { redis, keyPrefix } = config;

  const stepKey = (runId: string, stepId: string) =>
    `${keyPrefix}step:${runId}:${stepId}`;
  const stepsIndexKey = (runId: string) => `${keyPrefix}steps:by_run:${runId}`;

  // Helper: Scan Redis for a key matching pattern
  async function scanForKey(pattern: string): Promise<string | null> {
    let cursor = '0';

    do {
      const [nextCursor, keys] = await redis.scan(
        cursor,
        'MATCH',
        pattern,
        'COUNT',
        100
      );

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
    params?: GetStepParams
  ): Promise<Step> {
    const data = await redis.get(key);

    if (!data) {
      throw new WorkflowAPIError(`Step not found: ${stepId}`, {
        status: 404,
      });
    }

    const step = deserializeError(parseWithDates<Step>(data));
    return filterData(step, params?.resolveData, ['input', 'output']);
  }

  return {
    async create(runId: string, data: CreateStepRequest): Promise<Step> {
      const now = new Date();

      const step: Step = {
        runId,
        stepId: data.stepId,
        stepName: data.stepName,
        status: 'pending',
        input: data.input,
        attempt: 1,
        createdAt: now,
        updatedAt: now,
      };

      // Use SET NX to ensure step doesn't already exist
      const existed = await redis.setnx(
        stepKey(runId, data.stepId),
        JSON.stringify(step)
      );
      if (!existed) {
        throw new WorkflowAPIError(`Step ${data.stepId} already exists`, {
          status: 409,
        });
      }

      // Add to index with timestamp as score
      await redis.zadd(stepsIndexKey(runId), now.getTime(), data.stepId);

      return step;
    },

    async get(
      runId: string | undefined,
      stepId: string,
      params?: GetStepParams
    ): Promise<Step> {
      // If runId not provided, scan for the step (slower but necessary)
      if (!runId) {
        const pattern = `${keyPrefix}step:*:${stepId}`;
        const foundKey = await scanForKey(pattern);

        if (!foundKey) {
          throw new WorkflowAPIError(`Step not found: ${stepId}`, {
            status: 404,
          });
        }

        return getStepData(foundKey, stepId, params);
      }

      // Fast path: Direct key lookup when runId is provided
      return getStepData(stepKey(runId, stepId), stepId, params);
    },

    async update(
      runId: string,
      stepId: string,
      data: UpdateStepRequest
    ): Promise<Step> {
      const existingData = await redis.get(stepKey(runId, stepId));
      if (!existingData) {
        throw new WorkflowAPIError(`Step not found: ${stepId}`, {
          status: 404,
        });
      }

      const currentStep: Step = parseWithDates<Step>(existingData);
      const now = new Date();

      // Serialize error if present
      const serialized = serializeError(data);

      const updates: Partial<Step> = {
        ...serialized,
        updatedAt: now,
      };

      // Set startedAt only on first transition to 'running'
      if (data.status === 'running' && !currentStep.startedAt) {
        updates.startedAt = now;
      }

      // Set completedAt on terminal states
      if (data.status === 'completed' || data.status === 'failed') {
        updates.completedAt = now;
      }

      const updatedStep: Step = { ...currentStep, ...updates };

      await redis.set(stepKey(runId, stepId), JSON.stringify(updatedStep));

      return deserializeError(compact(updatedStep));
    },

    async list(
      params: ListWorkflowRunStepsParams
    ): Promise<PaginatedResponse<Step>> {
      const limit = params?.pagination?.limit ?? 20;
      const fromCursor = params?.pagination?.cursor;

      const indexKey = stepsIndexKey(params.runId);

      // ZREVRANGE for descending order
      const start = fromCursor
        ? await redis
            .zrevrank(indexKey, fromCursor)
            .then((rank) => (rank ?? 0) + 1)
        : 0;

      const stepIds = await redis.zrevrange(indexKey, start, start + limit);

      // Fetch all steps
      const pipeline = redis.pipeline();
      for (const stepId of stepIds) {
        pipeline.get(stepKey(params.runId, stepId));
      }
      const results = await pipeline.exec();

      const steps: Step[] = [];
      for (const result of results ?? []) {
        if (result?.[1]) {
          const step = deserializeError(
            parseWithDates<Step>(result[1] as string)
          );
          steps.push(
            filterData(step, params?.resolveData, ['input', 'output'])
          );
        }
      }

      const values = steps.slice(0, limit);
      const hasMore = steps.length > limit;

      return {
        data: values.map(compact),
        hasMore,
        cursor: values.at(-1)?.stepId ?? null,
      };
    },
  };
}

/**
 * Create storage for hooks using Redis hashes and sorted sets
 */
export function createHooksStorage(
  config: RedisStorageConfig
): Storage['hooks'] {
  const { redis, keyPrefix } = config;

  const hookKey = (hookId: string) => `${keyPrefix}hook:${hookId}`;
  const hooksByTokenKey = (token: string) =>
    `${keyPrefix}hooks:by_token:${token}`;
  const hooksIndexKey = (runId: string) => `${keyPrefix}hooks:by_run:${runId}`;

  return {
    async create(
      runId: string,
      data: CreateHookRequest,
      params?: GetHookParams
    ): Promise<Hook> {
      const createdAt = new Date();

      const hook: Hook = {
        runId,
        hookId: data.hookId,
        token: data.token,
        ownerId: '', // TODO: get from context
        projectId: '', // TODO: get from context
        environment: '', // TODO: get from context
        metadata: data.metadata,
        createdAt,
      };

      // Use SET NX to ensure hook doesn't already exist
      const existed = await redis.setnx(
        hookKey(data.hookId),
        JSON.stringify(hook)
      );
      if (!existed) {
        throw new WorkflowAPIError(`Hook ${data.hookId} already exists`, {
          status: 409,
        });
      }

      // Add to indexes with timestamp as score
      await redis
        .pipeline()
        .set(hooksByTokenKey(data.token), data.hookId)
        .zadd(hooksIndexKey(runId), createdAt.getTime(), data.hookId)
        .exec();

      const parsed = HookSchema.parse(compact(hook));
      const resolveData = params?.resolveData ?? 'all';
      return filterHookData(parsed, resolveData);
    },

    async get(hookId: string, params?: GetHookParams): Promise<Hook> {
      const data = await redis.get(hookKey(hookId));
      if (!data) {
        throw new WorkflowAPIError(`Hook not found: ${hookId}`, {
          status: 404,
        });
      }
      const hook = parseWithDates<Hook>(data);
      const parsed = HookSchema.parse(compact(hook));
      const resolveData = params?.resolveData ?? 'all';
      return filterHookData(parsed, resolveData);
    },

    async getByToken(token: string, params?: GetHookParams): Promise<Hook> {
      const hookId = await redis.get(hooksByTokenKey(token));
      if (!hookId) {
        throw new WorkflowAPIError(`Hook not found for token: ${token}`, {
          status: 404,
        });
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
      const start = fromCursor
        ? await redis
            .zrevrank(indexKey, fromCursor)
            .then((rank) => (rank ?? 0) + 1)
        : 0;

      const hookIds = await redis.zrevrange(indexKey, start, start + limit);

      // Fetch all hooks
      const pipeline = redis.pipeline();
      for (const hookId of hookIds) {
        pipeline.get(hookKey(hookId));
      }
      const results = await pipeline.exec();

      const hooks: Hook[] = [];
      for (const result of results ?? []) {
        if (result?.[1]) {
          const hook = parseWithDates<Hook>(result[1] as string);
          hooks.push(hook);
        }
      }

      const values = hooks.slice(0, limit);
      const hasMore = hooks.length > limit;

      return {
        data: values.map(compact),
        cursor: values.at(-1)?.hookId ?? null,
        hasMore,
      };
    },

    async dispose(hookId: string, params?: GetHookParams): Promise<Hook> {
      const data = await redis.get(hookKey(hookId));
      if (!data) {
        throw new WorkflowAPIError(`Hook not found: ${hookId}`, {
          status: 404,
        });
      }

      const hook: Hook = parseWithDates<Hook>(data);

      // Delete hook and remove from indexes
      await redis
        .pipeline()
        .del(hookKey(hookId))
        .del(hooksByTokenKey(hook.token))
        .zrem(hooksIndexKey(hook.runId), hookId)
        .exec();

      const parsed = HookSchema.parse(compact(hook));
      const resolveData = params?.resolveData ?? 'all';
      return filterHookData(parsed, resolveData);
    },
  };
}

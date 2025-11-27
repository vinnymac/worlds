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
  ResumeWorkflowRunParams,
  Step,
  Storage,
  UpdateStepRequest,
  UpdateWorkflowRunRequest,
  WorkflowRun,
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

      const run: WorkflowRun = parseWithDates<WorkflowRun>(result[1] as string);

      // Apply filters
      const statusMatches = !params?.status || run.status === params.status;
      const nameMatches =
        !params?.workflowName || run.workflowName === params.workflowName;

      if (statusMatches && nameMatches) {
        runs.push(compact(run));
      }
    }

    return runs;
  }

  return {
    async create(data: CreateWorkflowRunRequest): Promise<WorkflowRun> {
      const runId = `wrun_${ulid()}`;
      const now = new Date();

      const run = {
        runId,
        deploymentId: data.deploymentId,
        workflowName: data.workflowName,
        status: 'pending' as const,
        input: data.input,
        executionContext: data.executionContext as Record<string, any> | null,
        output: undefined,
        error: undefined,
        completedAt: undefined,
        startedAt: undefined,
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

      return compact(run);
    },

    async get(
      id: string,
      _params?: GetWorkflowRunParams
    ): Promise<WorkflowRun> {
      const data = await redis.get(runKey(id));
      if (!data) {
        throw new WorkflowAPIError(`Run not found: ${id}`, { status: 404 });
      }
      return parseWithDates<WorkflowRun>(data);
    },

    async update(
      id: string,
      data: UpdateWorkflowRunRequest
    ): Promise<WorkflowRun> {
      const existingData = await redis.get(runKey(id));
      if (!existingData) {
        throw new WorkflowAPIError(`Run not found: ${id}`, { status: 404 });
      }

      const currentRun = parseWithDates<WorkflowRun>(existingData);
      const updates: any = {
        ...data,
        updatedAt: new Date(),
      };

      // Set startedAt only on first transition to 'running'
      if (data.status === 'running' && !currentRun.startedAt) {
        updates.startedAt = new Date();
      }

      // Set completedAt on terminal states
      if (
        data.status === 'completed' ||
        data.status === 'failed' ||
        data.status === 'cancelled'
      ) {
        updates.completedAt = new Date();
      }

      const updatedRun = { ...currentRun, ...updates } as WorkflowRun;

      // Update run and reindex if status changed
      const pipeline = redis
        .pipeline()
        .set(runKey(id), JSON.stringify(updatedRun));

      if (data.status && data.status !== currentRun.status) {
        // Remove from old status index
        pipeline.zrem(runsByStatusKey(currentRun.status), id);
        // Add to new status index with current timestamp
        pipeline.zadd(
          runsByStatusKey(data.status),
          updatedRun.updatedAt.getTime(),
          id
        );
      }

      await pipeline.exec();

      return compact(updatedRun);
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

      const currentRun = parseWithDates<WorkflowRun>(existingData);
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
  async function getStepData(key: string, stepId: string): Promise<Step> {
    const data = await redis.get(key);

    if (!data) {
      throw new WorkflowAPIError(`Step not found: ${stepId}`, {
        status: 404,
      });
    }

    return parseWithDates<Step>(data);
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
      _params?: GetStepParams
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

        return getStepData(foundKey, stepId);
      }

      // Fast path: Direct key lookup when runId is provided
      return getStepData(stepKey(runId, stepId), stepId);
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

      const currentStep = parseWithDates<Step>(existingData);
      const now = new Date();
      const updates: Partial<Step> = {
        ...data,
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

      return compact(updatedStep);
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
          steps.push(parseWithDates<Step>(result[1] as string));
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
      _params?: GetHookParams
    ): Promise<Hook> {
      const createdAt = new Date();

      const hook: Hook = {
        runId,
        hookId: data.hookId,
        token: data.token,
        // NOTE: Context fields not available in storage layer. These could be populated
        // from execution context if workflow framework passes them in CreateHookRequest.
        ownerId: '',
        projectId: '',
        environment: '',
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

      return hook;
    },

    async get(hookId: string, _params?: GetHookParams): Promise<Hook> {
      const data = await redis.get(hookKey(hookId));
      if (!data) {
        throw new WorkflowAPIError(`Hook not found: ${hookId}`, {
          status: 404,
        });
      }
      return parseWithDates<Hook>(data);
    },

    async getByToken(token: string, _params?: GetHookParams): Promise<Hook> {
      const hookId = await redis.get(hooksByTokenKey(token));
      if (!hookId) {
        throw new WorkflowAPIError(`Hook not found for token: ${token}`, {
          status: 404,
        });
      }
      return this.get(hookId);
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
          hooks.push(parseWithDates<Hook>(result[1] as string));
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

    async dispose(hookId: string, _params?: GetHookParams): Promise<Hook> {
      const data = await redis.get(hookKey(hookId));
      if (!data) {
        throw new WorkflowAPIError(`Hook not found: ${hookId}`, {
          status: 404,
        });
      }

      const hook = parseWithDates<Hook>(data);

      // Delete hook and remove from indexes
      await redis
        .pipeline()
        .del(hookKey(hookId))
        .del(hooksByTokenKey(hook.token))
        .zrem(hooksIndexKey(hook.runId), hookId)
        .exec();

      return hook;
    },
  };
}

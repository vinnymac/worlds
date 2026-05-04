import { WorkflowWorldError } from '@workflow/errors';
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
 * JSON replacer function that converts Uint8Array to a special marker object.
 * This ensures Uint8Array fields are preserved through JSON.stringify/parse.
 */
function uint8ArrayReplacer(key: string, value: any): any {
  // Only process input, output, and executionContext fields
  if (key === 'input' || key === 'output' || key === 'executionContext') {
    if (value instanceof Uint8Array) {
      return {
        __uint8array: true,
        data: Array.from(value),
      };
    }
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
  if (
    dateValue &&
    typeof dateValue === 'object' &&
    dateValue.__uint8array === true
  ) {
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
function filterStepData(
  step: Step,
  resolveData: ResolveData
): Step | StepWithoutData;
function filterStepData(
  step: Step,
  resolveData: ResolveData
): Step | StepWithoutData {
  if (resolveData === 'none') {
    const { input: _, output: __, ...rest } = step;
    return { input: undefined, output: undefined, ...rest };
  }
  return step;
}

function filterRunData(
  run: WorkflowRun,
  resolveData: 'none'
): WorkflowRunWithoutData;
function filterRunData(run: WorkflowRun, resolveData: 'all'): WorkflowRun;
function filterRunData(
  run: WorkflowRun,
  resolveData: ResolveData
): WorkflowRun | WorkflowRunWithoutData;
function filterRunData(
  run: WorkflowRun,
  resolveData: ResolveData
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

/**
 * Create storage for workflow runs using Redis hashes and sorted sets
 */
export function createRunsStorage(config: RedisStorageConfig): Storage['runs'] {
  const { redis, keyPrefix } = config;

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
  ): (WorkflowRun | WorkflowRunWithoutData)[] {
    const runs: (WorkflowRun | WorkflowRunWithoutData)[] = [];

    for (const result of results ?? []) {
      if (!result?.[1]) {
        continue;
      }

      const run: WorkflowRun = deserializeError(
        parseWithUint8Array<WorkflowRun>(result[1] as string)
      );

      // Apply filters
      const statusMatches = !params?.status || run.status === params.status;
      const nameMatches =
        !params?.workflowName || run.workflowName === params.workflowName;

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
        throw new WorkflowWorldError(`Run not found: ${id}`, { status: 404 });
      }
      const run = deserializeError(parseWithUint8Array<WorkflowRun>(data));
      const parsed = WorkflowRunSchema.parse(compact(run));
      const resolveData = params?.resolveData ?? 'all';
      return filterRunData(parsed, resolveData);
    }) as Storage['runs']['get'],

    list: (async (params?: ListWorkflowRunsParams) => {
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
    }) as Storage['runs']['list'],
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

  // Run key helpers (needed for event-sourced entity mutations)
  const runKey = (id: string) => `${keyPrefix}run:${id}`;
  const runsIndexKey = () => `${keyPrefix}runs:index`;
  const runsByNameKey = (name: string) => `${keyPrefix}runs:by_name:${name}`;
  const runsByStatusKey = (status: string) =>
    `${keyPrefix}runs:by_status:${status}`;

  // Step key helpers
  const stepKey = (runId: string, stepId: string) =>
    `${keyPrefix}step:${runId}:${stepId}`;
  const stepsIndexKey = (runId: string) => `${keyPrefix}steps:by_run:${runId}`;

  // Hook key helpers
  const hookKey = (hookId: string) => `${keyPrefix}hook:${hookId}`;
  const hooksByTokenKey = (token: string) =>
    `${keyPrefix}hooks:by_token:${token}`;
  const hooksIndexKey = (runId: string) => `${keyPrefix}hooks:by_run:${runId}`;

  // Helper: Clean up hooks when run reaches terminal status
  async function cleanupHooks(runId: string): Promise<void> {
    const indexKey = hooksIndexKey(runId);
    const hookIds = await redis.zrange(indexKey, 0, -1);

    const pipeline = redis.pipeline();
    for (const hookId of hookIds) {
      const hookData = await redis.get(hookKey(hookId));
      if (hookData) {
        const hook = parseWithDates<Hook>(hookData);
        pipeline.del(hookKey(hookId));
        pipeline.del(hooksByTokenKey(hook.token));
      }
    }
    pipeline.del(indexKey);
    await pipeline.exec();
  }

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

  /**
   * Handle events for legacy runs (pre-event-sourcing, specVersion < 2).
   */
  async function handleLegacyEvent(
    runId: string,
    eventId: string,
    data: any,
    currentRun: { status: string; specVersion?: number },
    params?: { resolveData?: ResolveData }
  ): Promise<EventResult> {
    const resolveData = params?.resolveData ?? 'all';

    switch (data.eventType) {
      case 'run_cancelled': {
        // Legacy: Skip event storage, directly update run to cancelled
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
          await redis.set(runKey(runId), stringifyWithUint8Array(updatedRun));

          // Update status index
          const pipeline = redis.pipeline();
          pipeline.zrem(runsByStatusKey(existing.status), runId);
          pipeline.zadd(runsByStatusKey('cancelled'), now.getTime(), runId);
          await pipeline.exec();

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
        // Legacy: Store event only (no entity mutation)
        const createdAt = new Date();
        const event: Event = {
          ...data,
          runId,
          eventId,
          createdAt,
          specVersion: SPEC_VERSION_CURRENT,
        };

        await redis.set(eventKey(eventId), JSON.stringify(event));
        const score = createdAt.getTime();
        const pipeline = redis.pipeline();
        pipeline.zadd(eventsIndexKey(runId), score, eventId);
        if (data.correlationId) {
          pipeline.zadd(
            eventsByCorrelationKey(data.correlationId),
            score,
            eventId
          );
        }
        await pipeline.exec();

        const parsed = EventSchema.parse(event);
        return { event: filterEventData(parsed, resolveData) };
      }

      default:
        throw new Error(
          `Event type '${data.eventType}' not supported for legacy runs ` +
            `(specVersion: ${currentRun.specVersion || 'undefined'}). ` +
            `Please upgrade @workflow packages.`
        );
    }
  }

  return {
    async create(
      runId: string | null,
      data: CreateEventRequest | RunCreatedEventRequest,
      params?: CreateEventParams
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
        ['completed', 'failed'].includes(status);

      // ============================================================
      // VALIDATION: Terminal state and event ordering checks
      // ============================================================

      let currentRun: {
        status: string;
        specVersion?: number;
      } | null = null;
      const skipRunValidationEvents = ['step_completed', 'step_retrying'];
      if (
        data.eventType !== 'run_created' &&
        !skipRunValidationEvents.includes(data.eventType)
      ) {
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
      // VERSION COMPATIBILITY: Check run spec version
      // ============================================================
      if (currentRun) {
        if (requiresNewerWorld(currentRun.specVersion)) {
          throw new (await import('@workflow/errors')).RunNotSupportedError(
            currentRun.specVersion!,
            SPEC_VERSION_CURRENT
          );
        }

        if (isLegacySpecVersion(currentRun.specVersion)) {
          return handleLegacyEvent(
            effectiveRunId,
            eventId,
            data,
            currentRun,
            params
          );
        }
      }

      // Run terminal state validation
      if (currentRun && isRunTerminal(currentRun.status)) {
        const runTerminalEvents = [
          'run_started',
          'run_completed',
          'run_failed',
        ];

        // Idempotent operation: run_cancelled on already cancelled run is allowed
        if (
          data.eventType === 'run_cancelled' &&
          currentRun.status === 'cancelled'
        ) {
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
          await redis.set(eventKey(eventId), JSON.stringify(event));
          const score = createdAt.getTime();
          await redis.zadd(eventsIndexKey(effectiveRunId), score, eventId);

          const parsed = EventSchema.parse(event);
          const resolveData = params?.resolveData ?? 'all';
          return {
            event: filterEventData(parsed, resolveData),
            run: fullRunData
              ? (deserializeError(
                  parseWithUint8Array<WorkflowRun>(fullRunData)
                ) as WorkflowRun)
              : undefined,
          };
        }

        // Run state transitions are not allowed on terminal runs
        if (
          runTerminalEvents.includes(data.eventType) ||
          data.eventType === 'run_cancelled'
        ) {
          throw new WorkflowWorldError(
            `Cannot transition run from terminal state "${currentRun.status}"`,
            { status: 410 }
          );
        }

        // Creating new entities on terminal runs is not allowed
        if (
          data.eventType === 'step_created' ||
          data.eventType === 'hook_created'
        ) {
          throw new WorkflowWorldError(
            `Cannot create new entities on run in terminal state "${currentRun.status}"`,
            { status: 410 }
          );
        }
      }

      // Step-related event validation
      let validatedStep: { status: string; startedAt?: Date } | null = null;
      const stepEventsNeedingValidation = ['step_started', 'step_retrying'];
      if (
        stepEventsNeedingValidation.includes(data.eventType) &&
        data.correlationId
      ) {
        const stepData = await redis.get(
          stepKey(effectiveRunId, data.correlationId)
        );
        if (stepData) {
          const parsed = parseWithUint8Array<Step>(stepData);
          validatedStep = {
            status: parsed.status,
            startedAt: parsed.startedAt,
          };
        }

        if (!validatedStep) {
          throw new WorkflowWorldError(
            `Step "${data.correlationId}" not found`,
            { status: 404 }
          );
        }

        if (isStepTerminal(validatedStep.status)) {
          throw new WorkflowWorldError(
            `Cannot modify step in terminal state "${validatedStep.status}"`,
            { status: 410 }
          );
        }

        if (currentRun && isRunTerminal(currentRun.status)) {
          if (validatedStep.status !== 'running') {
            throw new WorkflowWorldError(
              `Cannot modify non-running step on run in terminal state "${currentRun.status}"`,
              { status: 410 }
            );
          }
        }
      }

      // Hook-related event validation
      const hookEventsRequiringExistence = ['hook_disposed', 'hook_received'];
      if (
        hookEventsRequiringExistence.includes(data.eventType) &&
        data.correlationId
      ) {
        const existingHook = await redis.get(hookKey(data.correlationId));
        if (!existingHook) {
          throw new WorkflowWorldError(
            `Hook "${data.correlationId}" not found`,
            { status: 404 }
          );
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

        // Use SET NX to ensure run doesn't already exist
        const existed = await redis.setnx(
          runKey(effectiveRunId),
          stringifyWithUint8Array(newRun)
        );
        if (existed) {
          const score = now.getTime();
          await redis
            .pipeline()
            .zadd(runsIndexKey(), score, effectiveRunId)
            .zadd(runsByNameKey(eventData.workflowName), score, effectiveRunId)
            .zadd(runsByStatusKey('pending'), score, effectiveRunId)
            .exec();
          run = WorkflowRunSchema.parse(compact(newRun));
        }
      }

      // Handle run_started event: update run status
      if (data.eventType === 'run_started') {
        const existingData = await redis.get(runKey(effectiveRunId));
        if (existingData) {
          const existing = parseWithUint8Array<WorkflowRun>(existingData);
          const updatedRun = {
            ...existing,
            status: 'running' as const,
            startedAt: now,
            updatedAt: now,
          };
          await redis.set(
            runKey(effectiveRunId),
            stringifyWithUint8Array(updatedRun)
          );

          // Update status index
          const pipeline = redis.pipeline();
          pipeline.zrem(runsByStatusKey(existing.status), effectiveRunId);
          pipeline.zadd(
            runsByStatusKey('running'),
            now.getTime(),
            effectiveRunId
          );
          await pipeline.exec();

          run = WorkflowRunSchema.parse(compact(updatedRun));
        }
      }

      // Handle run_completed event: update run status and cleanup hooks
      if (data.eventType === 'run_completed') {
        const eventData = (data as any).eventData as { output?: any };
        const existingData = await redis.get(runKey(effectiveRunId));
        if (existingData) {
          const existing = parseWithUint8Array<WorkflowRun>(existingData);
          const updatedRun = {
            ...existing,
            status: 'completed' as const,
            output: eventData.output,
            completedAt: now,
            updatedAt: now,
          };
          await redis.set(
            runKey(effectiveRunId),
            stringifyWithUint8Array(updatedRun)
          );

          const pipeline = redis.pipeline();
          pipeline.zrem(runsByStatusKey(existing.status), effectiveRunId);
          pipeline.zadd(
            runsByStatusKey('completed'),
            now.getTime(),
            effectiveRunId
          );
          await pipeline.exec();

          await cleanupHooks(effectiveRunId);

          run = WorkflowRunSchema.parse(compact(updatedRun));
        }
      }

      // Handle run_failed event: update run status and cleanup hooks
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
        if (existingData) {
          const existing = parseWithUint8Array<WorkflowRun>(existingData);
          const updatedRun = serializeError({
            ...existing,
            status: 'failed' as const,
            error: {
              message: errorMessage,
              stack: eventData.error?.stack,
              code: eventData.errorCode,
            },
            completedAt: now,
            updatedAt: now,
          });
          await redis.set(
            runKey(effectiveRunId),
            stringifyWithUint8Array(updatedRun)
          );

          const pipeline = redis.pipeline();
          pipeline.zrem(runsByStatusKey(existing.status), effectiveRunId);
          pipeline.zadd(
            runsByStatusKey('failed'),
            now.getTime(),
            effectiveRunId
          );
          await pipeline.exec();

          await cleanupHooks(effectiveRunId);

          run = deserializeError(
            parseWithUint8Array<WorkflowRun>(
              stringifyWithUint8Array(updatedRun)
            )
          );
          run = WorkflowRunSchema.parse(compact(run));
        }
      }

      // Handle run_cancelled event: update run status and cleanup hooks
      if (data.eventType === 'run_cancelled') {
        const existingData = await redis.get(runKey(effectiveRunId));
        if (existingData) {
          const existing = parseWithUint8Array<WorkflowRun>(existingData);
          const updatedRun = {
            ...existing,
            status: 'cancelled' as const,
            completedAt: now,
            updatedAt: now,
          };
          await redis.set(
            runKey(effectiveRunId),
            stringifyWithUint8Array(updatedRun)
          );

          const pipeline = redis.pipeline();
          pipeline.zrem(runsByStatusKey(existing.status), effectiveRunId);
          pipeline.zadd(
            runsByStatusKey('cancelled'),
            now.getTime(),
            effectiveRunId
          );
          await pipeline.exec();

          await cleanupHooks(effectiveRunId);

          run = WorkflowRunSchema.parse(compact(updatedRun));
        }
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

        const existed = await redis.setnx(
          stepKey(effectiveRunId, data.correlationId!),
          stringifyWithUint8Array(newStep)
        );
        if (existed) {
          await redis.zadd(
            stepsIndexKey(effectiveRunId),
            now.getTime(),
            data.correlationId!
          );
          step = StepSchema.parse(compact(newStep));
        }
      }

      // Handle step_started event: increment attempt, set status to 'running'
      if (data.eventType === 'step_started') {
        const isFirstStart = !validatedStep?.startedAt;
        const existingData = await redis.get(
          stepKey(effectiveRunId, data.correlationId!)
        );
        if (existingData) {
          const existing = parseWithUint8Array<Step>(existingData);
          const updatedStep = {
            ...existing,
            status: 'running' as const,
            attempt: existing.attempt + 1,
            ...(isFirstStart ? { startedAt: now } : {}),
            updatedAt: now,
          };
          await redis.set(
            stepKey(effectiveRunId, data.correlationId!),
            stringifyWithUint8Array(updatedStep)
          );
          step = StepSchema.parse(compact(updatedStep));
        }
      }

      // Handle step_completed event: update step status
      if (data.eventType === 'step_completed') {
        const eventData = (data as any).eventData as { result?: any };
        const existingData = await redis.get(
          stepKey(effectiveRunId, data.correlationId!)
        );
        if (existingData) {
          const existing = parseWithUint8Array<Step>(existingData);
          if (['completed', 'failed'].includes(existing.status)) {
            throw new WorkflowWorldError(
              `Cannot modify step in terminal state "${existing.status}"`,
              { status: 410 }
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
            stringifyWithUint8Array(updatedStep)
          );
          step = StepSchema.parse(compact(updatedStep));
        } else {
          throw new WorkflowWorldError(
            `Step "${data.correlationId}" not found`,
            { status: 404 }
          );
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

        const existingData = await redis.get(
          stepKey(effectiveRunId, data.correlationId!)
        );
        if (existingData) {
          const existing = parseWithUint8Array<Step>(existingData);
          if (['completed', 'failed'].includes(existing.status)) {
            throw new WorkflowWorldError(
              `Cannot modify step in terminal state "${existing.status}"`,
              { status: 410 }
            );
          }
          const updatedStep = serializeError({
            ...existing,
            status: 'failed' as const,
            error: {
              message: errorMessage,
              stack: eventData.stack,
            },
            completedAt: now,
            updatedAt: now,
          });
          await redis.set(
            stepKey(effectiveRunId, data.correlationId!),
            stringifyWithUint8Array(updatedStep)
          );
          step = deserializeError(
            parseWithUint8Array<Step>(stringifyWithUint8Array(updatedStep))
          );
          step = StepSchema.parse(compact(step));
        } else {
          throw new WorkflowWorldError(
            `Step "${data.correlationId}" not found`,
            { status: 404 }
          );
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

        const existingData = await redis.get(
          stepKey(effectiveRunId, data.correlationId!)
        );
        if (existingData) {
          const existing = parseWithUint8Array<Step>(existingData);
          const updatedStep = serializeError({
            ...existing,
            status: 'pending' as const,
            error: {
              message: errorMessage,
              stack: eventData.stack,
            },
            retryAfter: eventData.retryAfter,
            updatedAt: now,
          });
          await redis.set(
            stepKey(effectiveRunId, data.correlationId!),
            stringifyWithUint8Array(updatedStep)
          );
          step = deserializeError(
            parseWithUint8Array<Step>(stringifyWithUint8Array(updatedStep))
          );
          step = StepSchema.parse(compact(step));
        }
      }

      // Handle hook_created event: create hook entity
      if (data.eventType === 'hook_created') {
        const eventData = (data as any).eventData as {
          token: string;
          metadata?: any;
        };

        // Check for duplicate token
        const existingHookId = await redis.get(
          hooksByTokenKey(eventData.token)
        );
        if (existingHookId) {
          // Create hook_conflict event instead of throwing 409
          const conflictEventData = { token: eventData.token };
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

          await redis.set(eventKey(eventId), JSON.stringify(conflictEvent));
          const score = createdAt.getTime();
          const pipeline = redis.pipeline();
          pipeline.zadd(eventsIndexKey(effectiveRunId), score, eventId);
          if (data.correlationId) {
            pipeline.zadd(
              eventsByCorrelationKey(data.correlationId),
              score,
              eventId
            );
          }
          await pipeline.exec();

          const parsedConflict = EventSchema.parse(conflictEvent);
          const resolveData = params?.resolveData ?? 'all';
          return {
            event: filterEventData(parsedConflict, resolveData),
            run,
            step,
            hook: undefined,
          };
        }

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

        const existed = await redis.setnx(
          hookKey(data.correlationId!),
          JSON.stringify(newHook)
        );
        if (existed) {
          await redis
            .pipeline()
            .set(hooksByTokenKey(eventData.token), data.correlationId!)
            .zadd(
              hooksIndexKey(effectiveRunId),
              now.getTime(),
              data.correlationId!
            )
            .exec();
          hook = HookSchema.parse(compact(newHook));
        }
      }

      // Handle hook_disposed event: delete hook entity
      if (data.eventType === 'hook_disposed' && data.correlationId) {
        const hookData = await redis.get(hookKey(data.correlationId));
        if (hookData) {
          const existingHook = parseWithDates<Hook>(hookData);
          await redis
            .pipeline()
            .del(hookKey(data.correlationId))
            .del(hooksByTokenKey(existingHook.token))
            .zrem(hooksIndexKey(effectiveRunId), data.correlationId)
            .exec();
        }
      }

      // Store the event
      const createdAt = new Date();
      const event = {
        ...data,
        runId: effectiveRunId,
        eventId,
        createdAt,
        specVersion: effectiveSpecVersion,
      };

      await redis.set(eventKey(eventId), JSON.stringify(event));

      const score = createdAt.getTime();
      const pipeline = redis.pipeline();
      pipeline.zadd(eventsIndexKey(effectiveRunId), score, eventId);
      if (data.correlationId) {
        pipeline.zadd(
          eventsByCorrelationKey(data.correlationId),
          score,
          eventId
        );
      }
      await pipeline.exec();

      const parsed = EventSchema.parse(event);
      const resolveData = params?.resolveData ?? 'all';
      return {
        event: filterEventData(parsed, resolveData),
        run,
        step,
        hook,
      };
    },

    async get(_runId: string, eventId: string): Promise<Event> {
      const data = await redis.get(eventKey(eventId));
      if (!data) {
        throw new WorkflowWorldError(`Event not found: ${eventId}`, {
          status: 404,
        });
      }
      return parseWithDates<Event>(data);
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
  ): Promise<Step | StepWithoutData> {
    const data = await redis.get(key);

    if (!data) {
      throw new WorkflowWorldError(`Step not found: ${stepId}`, {
        status: 404,
      });
    }

    const step = deserializeError(parseWithUint8Array<Step>(data));
    const parsed = StepSchema.parse(compact(step));
    const resolveData = params?.resolveData ?? 'all';
    return filterStepData(parsed, resolveData);
  }

  return {
    get: (async (
      runId: string | undefined,
      stepId: string,
      params?: GetStepParams
    ) => {
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
      const start = fromCursor
        ? await redis
            .zrevrank(indexKey, fromCursor)
            .then((rank) => (rank ?? 0) + 1)
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
          const step = deserializeError(
            parseWithUint8Array<Step>(result[1] as string)
          );
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
export function createHooksStorage(
  config: RedisStorageConfig
): Storage['hooks'] {
  const { redis, keyPrefix } = config;

  const hookKeyFn = (hookId: string) => `${keyPrefix}hook:${hookId}`;
  const hooksByTokenKey = (token: string) =>
    `${keyPrefix}hooks:by_token:${token}`;
  const hooksIndexKey = (runId: string) => `${keyPrefix}hooks:by_run:${runId}`;

  return {
    async get(hookId: string, params?: GetHookParams): Promise<Hook> {
      const data = await redis.get(hookKeyFn(hookId));
      if (!data) {
        throw new WorkflowWorldError(`Hook not found: ${hookId}`, {
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
        throw new WorkflowWorldError(`Hook not found for token: ${token}`, {
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
      for (const hId of hookIds) {
        pipeline.get(hookKeyFn(hId));
      }
      const results = await pipeline.exec();

      const hooks: Hook[] = [];
      for (const result of results ?? []) {
        if (result?.[1]) {
          const hook = parseWithDates<Hook>(result[1] as string);
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

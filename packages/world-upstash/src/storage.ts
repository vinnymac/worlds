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
import type { Redis } from '@upstash/redis';
import { monotonicFactory } from 'ulid';

interface UpstashStorageConfig {
  redis: Redis;
  keyPrefix: string;
}

/**
 * Date fields that need to be converted from ISO strings back to Date objects
 * when deserializing from Redis JSON storage.
 */
const DATE_FIELDS = new Set(['createdAt', 'updatedAt', 'startedAt', 'completedAt', 'retryAfter']);

/**
 * Reviver function for JSON.parse() that converts ISO date strings to Date objects.
 */
function dateReviver(key: string, value: any): any {
  if (DATE_FIELDS.has(key) && typeof value === 'string') {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date;
  }
  return value;
}

/**
 * JSON replacer function that converts Uint8Array to a special marker object.
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
  const dateValue = dateReviver(key, value);

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
 * Compact utility to remove undefined values
 */
function compact<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj)) as T;
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

/**
 * Create storage for workflow runs using Upstash Redis
 */
export function createRunsStorage(config: UpstashStorageConfig): Storage['runs'] {
  const { redis, keyPrefix } = config;

  const runKey = (id: string) => `${keyPrefix}run:${id}`;
  const runsIndexKey = () => `${keyPrefix}runs:index`;
  const runsByNameKey = (name: string) => `${keyPrefix}runs:by_name:${name}`;
  const runsByStatusKey = (status: string) => `${keyPrefix}runs:by_status:${status}`;

  function selectIndexKey(params?: ListWorkflowRunsParams): string {
    if (params?.workflowName && params?.status) {
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

  async function calculateStartPosition(
    indexKey: string,
    cursor: string | undefined,
  ): Promise<number> {
    if (!cursor) {
      return 0;
    }
    const rank = await redis.zrevrank(indexKey, cursor);
    return (rank ?? 0) + 1;
  }

  return {
    get: (async (id: string, params?: GetWorkflowRunParams) => {
      const data = await redis.get<string>(runKey(id));
      if (!data) {
        throw new WorkflowWorldError(`Run not found: ${id}`, { status: 404 });
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
      const start = await calculateStartPosition(indexKey, fromCursor);
      const runIds = await redis.zrange<string[]>(indexKey, start, start + limit, { rev: true });

      // Fetch all runs
      const runs: (WorkflowRun | WorkflowRunWithoutData)[] = [];
      for (const runId of runIds) {
        const data = await redis.get<string>(runKey(runId));
        if (!data) {
          continue;
        }

        const run: WorkflowRun = parseWithUint8Array<WorkflowRun>(data);
        const statusMatches = !params?.status || run.status === params.status;
        const nameMatches = !params?.workflowName || run.workflowName === params.workflowName;

        if (statusMatches && nameMatches) {
          const resolveData = params?.resolveData ?? 'all';
          const parsed = WorkflowRunSchema.parse(compact(run));
          runs.push(filterRunData(parsed, resolveData));
        }
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
 * Create storage for workflow events using Upstash Redis
 */
export function createEventsStorage(config: UpstashStorageConfig): Storage['events'] {
  const { redis, keyPrefix } = config;
  const ulid = monotonicFactory();

  const eventKey = (id: string) => `${keyPrefix}event:${id}`;
  const eventsIndexKey = (runId: string) => `${keyPrefix}events:by_run:${runId}`;
  const eventsByCorrelationKey = (correlationId: string) =>
    `${keyPrefix}events:by_correlation:${correlationId}`;

  const runKey = (id: string) => `${keyPrefix}run:${id}`;
  const runsIndexKey = () => `${keyPrefix}runs:index`;
  const runsByNameKey = (name: string) => `${keyPrefix}runs:by_name:${name}`;
  const runsByStatusKey = (status: string) => `${keyPrefix}runs:by_status:${status}`;

  const stepKey = (runId: string, stepId: string) => `${keyPrefix}step:${runId}:${stepId}`;
  const stepsIndexKey = (runId: string) => `${keyPrefix}steps:by_run:${runId}`;

  const hookKey = (hookId: string) => `${keyPrefix}hook:${hookId}`;
  const hooksByTokenKey = (token: string) => `${keyPrefix}hooks:by_token:${token}`;
  const hooksIndexKey = (runId: string) => `${keyPrefix}hooks:by_run:${runId}`;

  async function cleanupHooks(runId: string): Promise<void> {
    const indexKey = hooksIndexKey(runId);
    const hookIds = await redis.zrange<string[]>(indexKey, 0, -1);

    for (const hookId of hookIds) {
      const hookData = await redis.get<string>(hookKey(hookId));
      if (hookData) {
        const hook = parseWithUint8Array<Hook>(hookData);
        await redis.del(hookKey(hookId));
        await redis.del(hooksByTokenKey(hook.token));
      }
    }
    await redis.del(indexKey);
  }

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
        const now = new Date();
        const existingData = await redis.get<string>(runKey(runId));
        if (existingData) {
          const existing = parseWithUint8Array<WorkflowRun>(existingData);
          const updatedRun = {
            ...existing,
            status: 'cancelled' as const,
            completedAt: now,
            updatedAt: now,
          };
          await redis.set(runKey(runId), stringifyWithUint8Array(updatedRun));

          await redis.zrem(runsByStatusKey(existing.status), runId);
          await redis.zadd(runsByStatusKey('cancelled'), { score: now.getTime(), member: runId });

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

        await redis.set(eventKey(eventId), stringifyWithUint8Array(event));
        const score = createdAt.getTime();
        await redis.zadd(eventsIndexKey(runId), { score, member: eventId });
        if (data.correlationId) {
          await redis.zadd(eventsByCorrelationKey(data.correlationId), { score, member: eventId });
        }

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

      const isRunTerminal = (status: string) =>
        ['completed', 'failed', 'cancelled'].includes(status);
      const isStepTerminal = (status: string) => ['completed', 'failed'].includes(status);

      let currentRun: {
        status: string;
        specVersion?: number;
      } | null = null;
      const skipRunValidationEvents = ['step_completed', 'step_retrying'];
      if (data.eventType !== 'run_created' && !skipRunValidationEvents.includes(data.eventType)) {
        const runData = await redis.get<string>(runKey(effectiveRunId));
        if (runData) {
          const parsed = parseWithUint8Array<WorkflowRun>(runData);
          currentRun = {
            status: parsed.status,
            specVersion: parsed.specVersion,
          };
        }
      }

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

      if (currentRun && isRunTerminal(currentRun.status)) {
        const runTerminalEvents = ['run_started', 'run_completed', 'run_failed'];

        if (data.eventType === 'run_cancelled' && currentRun.status === 'cancelled') {
          const fullRunData = await redis.get<string>(runKey(effectiveRunId));

          const createdAt = new Date();
          const event = {
            ...data,
            runId: effectiveRunId,
            eventId,
            createdAt,
            specVersion: effectiveSpecVersion,
          };
          await redis.set(eventKey(eventId), stringifyWithUint8Array(event));
          const score = createdAt.getTime();
          await redis.zadd(eventsIndexKey(effectiveRunId), { score, member: eventId });

          const parsed = EventSchema.parse(event);
          const resolveData = params?.resolveData ?? 'all';
          return {
            event: filterEventData(parsed, resolveData),
            run: fullRunData
              ? (parseWithUint8Array<WorkflowRun>(fullRunData) as WorkflowRun)
              : undefined,
          };
        }

        if (runTerminalEvents.includes(data.eventType) || data.eventType === 'run_cancelled') {
          throw new WorkflowWorldError(
            `Cannot transition run from terminal state "${currentRun.status}"`,
            { status: 410 },
          );
        }

        if (data.eventType === 'step_created' || data.eventType === 'hook_created') {
          throw new WorkflowWorldError(
            `Cannot create new entities on run in terminal state "${currentRun.status}"`,
            { status: 410 },
          );
        }
      }

      let validatedStep: { status: string; startedAt?: Date } | null = null;
      const stepEventsNeedingValidation = ['step_started', 'step_retrying'];
      if (stepEventsNeedingValidation.includes(data.eventType) && data.correlationId) {
        const stepData = await redis.get<string>(stepKey(effectiveRunId, data.correlationId));
        if (stepData) {
          const parsed = parseWithUint8Array<Step>(stepData);
          validatedStep = {
            status: parsed.status,
            startedAt: parsed.startedAt,
          };
        }

        if (!validatedStep) {
          throw new WorkflowWorldError(`Step "${data.correlationId}" not found`, { status: 404 });
        }

        if (isStepTerminal(validatedStep.status)) {
          throw new WorkflowWorldError(
            `Cannot modify step in terminal state "${validatedStep.status}"`,
            { status: 410 },
          );
        }

        if (currentRun && isRunTerminal(currentRun.status)) {
          if (validatedStep.status !== 'running') {
            throw new WorkflowWorldError(
              `Cannot modify non-running step on run in terminal state "${currentRun.status}"`,
              { status: 410 },
            );
          }
        }
      }

      const hookEventsRequiringExistence = ['hook_disposed', 'hook_received'];
      if (hookEventsRequiringExistence.includes(data.eventType) && data.correlationId) {
        const existingHook = await redis.get<string>(hookKey(data.correlationId));
        if (!existingHook) {
          throw new WorkflowWorldError(`Hook "${data.correlationId}" not found`, { status: 404 });
        }
      }

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

        const wasCreated = await redis.setnx(
          runKey(effectiveRunId),
          stringifyWithUint8Array(newRun),
        );

        // Always add to indexes (idempotent)
        const score = now.getTime();
        await redis.zadd(runsIndexKey(), { score, member: effectiveRunId });
        await redis.zadd(runsByNameKey(eventData.workflowName), {
          score,
          member: effectiveRunId,
        });
        await redis.zadd(runsByStatusKey('pending'), { score, member: effectiveRunId });

        if (wasCreated === 1) {
          run = WorkflowRunSchema.parse(compact(newRun));
        } else {
          // Event replay: fetch existing run
          const existingData = await redis.get<string>(runKey(effectiveRunId));
          if (existingData) {
            run = WorkflowRunSchema.parse(compact(parseWithUint8Array<WorkflowRun>(existingData)));
          }
        }
      }

      if (data.eventType === 'run_started') {
        const existingData = await redis.get<string>(runKey(effectiveRunId));
        if (existingData) {
          const existing = parseWithUint8Array<WorkflowRun>(existingData);
          const updatedRun = {
            ...existing,
            status: 'running' as const,
            startedAt: now,
            updatedAt: now,
          };
          await redis.set(runKey(effectiveRunId), stringifyWithUint8Array(updatedRun));

          await redis.zrem(runsByStatusKey(existing.status), existing.runId);
          await redis.zadd(runsByStatusKey('running'), {
            score: now.getTime(),
            member: effectiveRunId,
          });

          run = WorkflowRunSchema.parse(compact(updatedRun));
        }
      }

      if (data.eventType === 'run_completed') {
        const eventData = (data as any).eventData as { output?: any };
        const existingData = await redis.get<string>(runKey(effectiveRunId));
        if (existingData) {
          const existing = parseWithUint8Array<WorkflowRun>(existingData);
          const updatedRun = {
            ...existing,
            status: 'completed' as const,
            output: eventData.output,
            completedAt: now,
            updatedAt: now,
          };
          await redis.set(runKey(effectiveRunId), stringifyWithUint8Array(updatedRun));

          await redis.zrem(runsByStatusKey(existing.status), existing.runId);
          await redis.zadd(runsByStatusKey('completed'), {
            score: now.getTime(),
            member: effectiveRunId,
          });

          await cleanupHooks(effectiveRunId);

          run = WorkflowRunSchema.parse(compact(updatedRun));
        }
      }

      if (data.eventType === 'run_failed') {
        const eventData = (data as any).eventData as {
          error: any;
          errorCode?: string;
        };
        const errorMessage =
          typeof eventData.error === 'string'
            ? eventData.error
            : (eventData.error?.message ?? 'Unknown error');

        const existingData = await redis.get<string>(runKey(effectiveRunId));
        if (existingData) {
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
          await redis.set(runKey(effectiveRunId), stringifyWithUint8Array(updatedRun));

          await redis.zrem(runsByStatusKey(existing.status), existing.runId);
          await redis.zadd(runsByStatusKey('failed'), {
            score: now.getTime(),
            member: effectiveRunId,
          });

          await cleanupHooks(effectiveRunId);

          run = WorkflowRunSchema.parse(compact(updatedRun));
        }
      }

      if (data.eventType === 'run_cancelled') {
        const existingData = await redis.get<string>(runKey(effectiveRunId));
        if (existingData) {
          const existing = parseWithUint8Array<WorkflowRun>(existingData);
          const updatedRun = {
            ...existing,
            status: 'cancelled' as const,
            completedAt: now,
            updatedAt: now,
          };
          await redis.set(runKey(effectiveRunId), stringifyWithUint8Array(updatedRun));

          await redis.zrem(runsByStatusKey(existing.status), existing.runId);
          await redis.zadd(runsByStatusKey('cancelled'), {
            score: now.getTime(),
            member: effectiveRunId,
          });

          await cleanupHooks(effectiveRunId);

          run = WorkflowRunSchema.parse(compact(updatedRun));
        }
      }

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

        const wasCreated = await redis.setnx(
          stepKey(effectiveRunId, data.correlationId!),
          stringifyWithUint8Array(newStep),
        );

        // Always add to index (ZADD is idempotent)
        await redis.zadd(stepsIndexKey(effectiveRunId), {
          score: now.getTime(),
          member: data.correlationId!,
        });

        if (wasCreated === 1) {
          step = StepSchema.parse(compact(newStep));
        } else {
          // Event replay: fetch existing step
          const existingData = await redis.get<string>(
            stepKey(effectiveRunId, data.correlationId!),
          );
          if (existingData) {
            step = StepSchema.parse(compact(parseWithUint8Array<Step>(existingData)));
          }
        }
      }

      if (data.eventType === 'step_started') {
        const isFirstStart = !validatedStep?.startedAt;
        const existingData = await redis.get<string>(stepKey(effectiveRunId, data.correlationId!));
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
            stringifyWithUint8Array(updatedStep),
          );
          step = StepSchema.parse(compact(updatedStep));
        }
      }

      if (data.eventType === 'step_completed') {
        const eventData = (data as any).eventData as { result?: any };
        const existingData = await redis.get<string>(stepKey(effectiveRunId, data.correlationId!));
        if (existingData) {
          const existing = parseWithUint8Array<Step>(existingData);
          if (['completed', 'failed'].includes(existing.status)) {
            throw new WorkflowWorldError(
              `Cannot modify step in terminal state "${existing.status}"`,
              { status: 410 },
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

      if (data.eventType === 'step_failed') {
        const eventData = (data as any).eventData as {
          error?: any;
          stack?: string;
        };
        const errorMessage =
          typeof eventData.error === 'string'
            ? eventData.error
            : (eventData.error?.message ?? 'Unknown error');

        const existingData = await redis.get<string>(stepKey(effectiveRunId, data.correlationId!));
        if (existingData) {
          const existing = parseWithUint8Array<Step>(existingData);
          if (['completed', 'failed'].includes(existing.status)) {
            throw new WorkflowWorldError(
              `Cannot modify step in terminal state "${existing.status}"`,
              { status: 410 },
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

        const existingData = await redis.get<string>(stepKey(effectiveRunId, data.correlationId!));
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

      if (data.eventType === 'hook_created') {
        const eventData = (data as any).eventData as {
          token: string;
          metadata?: any;
        };

        const existingHookId = await redis.get<string>(hooksByTokenKey(eventData.token));
        if (existingHookId) {
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

          await redis.set(eventKey(eventId), stringifyWithUint8Array(conflictEvent));
          const score = createdAt.getTime();
          await redis.zadd(eventsIndexKey(effectiveRunId), { score, member: eventId });
          if (data.correlationId) {
            await redis.zadd(eventsByCorrelationKey(data.correlationId), {
              score,
              member: eventId,
            });
          }

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

        const wasCreated = await redis.setnx(
          hookKey(data.correlationId!),
          stringifyWithUint8Array(newHook),
        );

        // Always add to indexes (idempotent)
        await redis.set(hooksByTokenKey(eventData.token), data.correlationId!);
        await redis.zadd(hooksIndexKey(effectiveRunId), {
          score: now.getTime(),
          member: data.correlationId!,
        });

        if (wasCreated === 1) {
          hook = HookSchema.parse(compact(newHook));
        } else {
          // Event replay: fetch existing hook
          const existingData = await redis.get<string>(hookKey(data.correlationId!));
          if (existingData) {
            hook = HookSchema.parse(compact(parseWithUint8Array<Hook>(existingData)));
          }
        }
      }

      if (data.eventType === 'hook_disposed' && data.correlationId) {
        const hookData = await redis.get<string>(hookKey(data.correlationId));
        if (hookData) {
          const existingHook = parseWithUint8Array<Hook>(hookData);
          await redis.del(hookKey(data.correlationId));
          await redis.del(hooksByTokenKey(existingHook.token));
          await redis.zrem(hooksIndexKey(effectiveRunId), data.correlationId);
        }
      }

      const createdAt = new Date();
      const event = {
        ...data,
        runId: effectiveRunId,
        eventId,
        createdAt,
        specVersion: effectiveSpecVersion,
      };

      await redis.set(eventKey(eventId), stringifyWithUint8Array(event));

      const score = createdAt.getTime();
      await redis.zadd(eventsIndexKey(effectiveRunId), { score, member: eventId });
      if (data.correlationId) {
        await redis.zadd(eventsByCorrelationKey(data.correlationId), { score, member: eventId });
      }

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
      const data = await redis.get<string>(eventKey(eventId));
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
      const start = fromCursor
        ? sortOrder === 'desc'
          ? await redis.zrevrank(indexKey, fromCursor).then((rank) => (rank ?? 0) + 1)
          : await redis.zrank(indexKey, fromCursor).then((rank) => (rank ?? 0) + 1)
        : 0;

      const eventIds = await redis.zrange<string[]>(indexKey, start, start + limit, {
        rev: sortOrder === 'desc',
      });

      const events: Event[] = [];
      for (const eid of eventIds) {
        const data = await redis.get<string>(eventKey(eid));
        if (data) {
          const event = parseWithUint8Array<Event>(data);
          events.push(event);
        }
      }

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
        ? sortOrder === 'desc'
          ? await redis.zrevrank(indexKey, fromCursor).then((rank) => (rank ?? 0) + 1)
          : await redis.zrank(indexKey, fromCursor).then((rank) => (rank ?? 0) + 1)
        : 0;

      const eventIds = await redis.zrange<string[]>(indexKey, start, start + limit, {
        rev: sortOrder === 'desc',
      });

      const events: Event[] = [];
      for (const eid of eventIds) {
        const data = await redis.get<string>(eventKey(eid));
        if (data) {
          const event = parseWithUint8Array<Event>(data);
          events.push(event);
        }
      }

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
 * Create storage for workflow steps using Upstash Redis
 */
export function createStepsStorage(config: UpstashStorageConfig): Storage['steps'] {
  const { redis, keyPrefix } = config;

  const stepKey = (runId: string, stepId: string) => `${keyPrefix}step:${runId}:${stepId}`;
  const stepsIndexKey = (runId: string) => `${keyPrefix}steps:by_run:${runId}`;

  async function getStepData(
    key: string,
    stepId: string,
    params?: GetStepParams,
  ): Promise<Step | StepWithoutData> {
    const data = await redis.get<string>(key);

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
      if (!runId) {
        const pattern = `${keyPrefix}step:*:${stepId}`;
        const keys = await redis.keys(pattern);

        if (!keys || keys.length === 0) {
          throw new WorkflowWorldError(`Step not found: ${stepId}`, {
            status: 404,
          });
        }

        return getStepData(keys[0], stepId, params);
      }

      return getStepData(stepKey(runId, stepId), stepId, params);
    }) as Storage['steps']['get'],

    list: (async (params: ListWorkflowRunStepsParams) => {
      const limit = params?.pagination?.limit ?? 20;
      const fromCursor = params?.pagination?.cursor;

      const indexKey = stepsIndexKey(params.runId);

      const start = fromCursor
        ? await redis.zrevrank(indexKey, fromCursor).then((rank) => (rank ?? 0) + 1)
        : 0;

      const stepIds = await redis.zrange<string[]>(indexKey, start, start + limit, { rev: true });

      const resolveData = params?.resolveData ?? 'all';
      const steps: (Step | StepWithoutData)[] = [];
      for (const sid of stepIds) {
        const data = await redis.get<string>(stepKey(params.runId, sid));
        if (data) {
          const step = parseWithUint8Array<Step>(data);
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
 * Create storage for hooks using Upstash Redis
 */
export function createHooksStorage(config: UpstashStorageConfig): Storage['hooks'] {
  const { redis, keyPrefix } = config;

  const hookKeyFn = (hookId: string) => `${keyPrefix}hook:${hookId}`;
  const hooksByTokenKey = (token: string) => `${keyPrefix}hooks:by_token:${token}`;
  const hooksIndexKey = (runId: string) => `${keyPrefix}hooks:by_run:${runId}`;

  return {
    async get(hookId: string, params?: GetHookParams): Promise<Hook> {
      const data = await redis.get<string>(hookKeyFn(hookId));
      if (!data) {
        throw new WorkflowWorldError(`Hook not found: ${hookId}`, {
          status: 404,
        });
      }
      const hook = parseWithUint8Array<Hook>(data);
      const parsed = HookSchema.parse(compact(hook));
      const resolveData = params?.resolveData ?? 'all';
      return filterHookData(parsed, resolveData);
    },

    async getByToken(token: string, params?: GetHookParams): Promise<Hook> {
      const hookId = await redis.get<string>(hooksByTokenKey(token));
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

      const start = fromCursor
        ? await redis.zrevrank(indexKey, fromCursor).then((rank) => (rank ?? 0) + 1)
        : 0;

      const hookIds = await redis.zrange<string[]>(indexKey, start, start + limit, { rev: true });

      const hooks: Hook[] = [];
      for (const hId of hookIds) {
        const data = await redis.get<string>(hookKeyFn(hId));
        if (data) {
          const hook = parseWithUint8Array<Hook>(data);
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

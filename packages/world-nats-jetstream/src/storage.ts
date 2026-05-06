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
import type { JetStreamClient, KV } from 'nats';
import { monotonicFactory } from 'ulid';
import { compact } from './util.js';

interface NatsStorageConfig {
  getJetStream: () => Promise<JetStreamClient>;
  keyPrefix: string;
}

/**
 * Date fields that need to be converted from ISO strings back to Date objects
 * when deserializing from NATS JetStream KV storage.
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
 * Convert KV entry value to string (handles both string and Uint8Array)
 */
function kvValueToString(value: string | Uint8Array): string {
  if (typeof value === 'string') return value;
  return new TextDecoder().decode(value);
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
 * Create storage for workflow runs using JetStream KV Store
 */
export function createRunsStorage(config: NatsStorageConfig): Storage['runs'] {
  const { getJetStream, keyPrefix } = config;
  let runsBucket: KV;

  // Initialize KV buckets on first access
  const initBuckets = async () => {
    if (!runsBucket) {
      const jetstream = await getJetStream();
      const kv = jetstream.views.kv(`${keyPrefix}runs`, {
        history: 10,
      });
      runsBucket = await kv;
    }
  };

  return {
    get: (async (id: string, params?: GetWorkflowRunParams) => {
      await initBuckets();
      const entry = await runsBucket.get(id);
      if (!entry) {
        throw new WorkflowWorldError(`Run not found: ${id}`, { status: 404 });
      }
      const data = kvValueToString(entry.value);
      const run = parseWithUint8Array<WorkflowRun>(data);
      const parsed = WorkflowRunSchema.parse(compact(run));
      const resolveData = params?.resolveData ?? 'all';
      return filterRunData(parsed, resolveData);
    }) as Storage['runs']['get'],

    list: (async (params?: ListWorkflowRunsParams) => {
      await initBuckets();
      const limit = params?.pagination?.limit ?? 20;
      const resolveData = params?.resolveData ?? 'all';

      // Get all runs and filter/sort in memory
      // For production: consider using JetStream streams for better filtering
      const runs: (WorkflowRun | WorkflowRunWithoutData)[] = [];

      for await (const entry of await runsBucket.history()) {
        if (!entry || entry.operation === 'DEL') continue;

        const data = kvValueToString(entry.value);
        const run: WorkflowRun = parseWithUint8Array<WorkflowRun>(data);

        // Apply filters
        const statusMatches = !params?.status || run.status === params.status;
        const nameMatches = !params?.workflowName || run.workflowName === params.workflowName;

        if (statusMatches && nameMatches) {
          const parsed = WorkflowRunSchema.parse(compact(run));
          runs.push(filterRunData(parsed, resolveData));
        }
      }

      // Sort by createdAt descending
      runs.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

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

/**
 * Create storage for workflow events using JetStream KV Store
 */
export function createEventsStorage(config: NatsStorageConfig): Storage['events'] {
  const { getJetStream, keyPrefix } = config;
  const ulid = monotonicFactory();

  let eventsBucket: KV;
  let runsBucket: KV;
  let stepsBucket: KV;
  let hooksBucket: KV;
  let hooksTokenBucket: KV;

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
    }
  };

  // Helper: Clean up hooks when run reaches terminal status
  async function cleanupHooks(runId: string): Promise<void> {
    await initBuckets();

    // Get all hooks for this run
    for await (const entry of await hooksBucket.history()) {
      if (!entry || entry.operation === 'DEL') continue;

      const data = kvValueToString(entry.value);
      const hook = parseWithUint8Array<Hook>(data);

      if (hook.runId === runId) {
        await hooksBucket.delete(hook.hookId);
        await hooksTokenBucket.delete(hook.token);
      }
    }
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
    await initBuckets();
    const resolveData = params?.resolveData ?? 'all';

    switch (data.eventType) {
      case 'run_cancelled': {
        const entry = await runsBucket.get(runId);
        if (entry) {
          const existingData = kvValueToString(entry.value);
          const existing = parseWithUint8Array<WorkflowRun>(existingData);
          const now = new Date();
          const updatedRun = {
            ...existing,
            status: 'cancelled' as const,
            completedAt: now,
            updatedAt: now,
          };
          await runsBucket.put(runId, stringifyWithUint8Array(updatedRun));
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

        await eventsBucket.put(eventId, stringifyWithUint8Array(event));
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
      await initBuckets();

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

      let run: WorkflowRun | undefined;
      let step: Step | undefined;
      let hook: Hook | undefined;

      const isRunTerminal = (status: string) =>
        ['completed', 'failed', 'cancelled'].includes(status);

      const isStepTerminal = (status: string) => ['completed', 'failed'].includes(status);

      // Validation
      let currentRun: {
        status: string;
        specVersion?: number;
      } | null = null;

      const skipRunValidationEvents = ['step_completed', 'step_retrying'];
      if (data.eventType !== 'run_created' && !skipRunValidationEvents.includes(data.eventType)) {
        const runEntry = await runsBucket.get(effectiveRunId);
        if (runEntry) {
          const runData = kvValueToString(runEntry.value);
          const parsed = parseWithUint8Array<WorkflowRun>(runData);
          currentRun = {
            status: parsed.status,
            specVersion: parsed.specVersion,
          };
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
          const fullRunEntry = await runsBucket.get(effectiveRunId);
          const createdAt = new Date();
          const event = {
            ...data,
            runId: effectiveRunId,
            eventId,
            createdAt,
            specVersion: effectiveSpecVersion,
          };
          await eventsBucket.put(eventId, stringifyWithUint8Array(event));

          const parsed = EventSchema.parse(event);
          const resolveData = params?.resolveData ?? 'all';
          return {
            event: filterEventData(parsed, resolveData),
            run: fullRunEntry
              ? (parseWithUint8Array<WorkflowRun>(
                  kvValueToString(fullRunEntry.value),
                ) as WorkflowRun)
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

      // Step validation
      let validatedStep: { status: string; startedAt?: Date } | null = null;
      const stepEventsNeedingValidation = ['step_started', 'step_retrying'];
      if (stepEventsNeedingValidation.includes(data.eventType) && data.correlationId) {
        const stepKey = `${effectiveRunId}.${data.correlationId}`;
        const stepEntry = await stepsBucket.get(stepKey);
        if (stepEntry) {
          const stepData = kvValueToString(stepEntry.value);
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

      // Hook validation
      const hookEventsRequiringExistence = ['hook_disposed', 'hook_received'];
      if (hookEventsRequiringExistence.includes(data.eventType) && data.correlationId) {
        const existingHook = await hooksBucket.get(data.correlationId);
        if (!existingHook) {
          throw new WorkflowWorldError(`Hook "${data.correlationId}" not found`, { status: 404 });
        }
      }

      // Entity creation/updates
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

        // Check if run already exists
        const existing = await runsBucket.get(effectiveRunId);
        if (!existing) {
          await runsBucket.put(effectiveRunId, stringifyWithUint8Array(newRun));
          run = WorkflowRunSchema.parse(compact(newRun));
        } else {
          // Event replay: return existing run
          const existingData = kvValueToString(existing.value);
          run = WorkflowRunSchema.parse(compact(parseWithUint8Array<WorkflowRun>(existingData)));
        }
      }

      if (data.eventType === 'run_started') {
        const entry = await runsBucket.get(effectiveRunId);
        if (entry) {
          const existingData = kvValueToString(entry.value);
          const existing = parseWithUint8Array<WorkflowRun>(existingData);
          const updatedRun = {
            ...existing,
            status: 'running' as const,
            startedAt: now,
            updatedAt: now,
          };
          await runsBucket.put(effectiveRunId, stringifyWithUint8Array(updatedRun));
          run = WorkflowRunSchema.parse(compact(updatedRun));
        }
      }

      if (data.eventType === 'run_completed') {
        const eventData = (data as any).eventData as { output?: any };
        const entry = await runsBucket.get(effectiveRunId);
        if (entry) {
          const existingData = kvValueToString(entry.value);
          const existing = parseWithUint8Array<WorkflowRun>(existingData);
          const updatedRun = {
            ...existing,
            status: 'completed' as const,
            output: eventData.output,
            completedAt: now,
            updatedAt: now,
          };
          await runsBucket.put(effectiveRunId, stringifyWithUint8Array(updatedRun));
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

        const entry = await runsBucket.get(effectiveRunId);
        if (entry) {
          const existingData = kvValueToString(entry.value);
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
          await runsBucket.put(effectiveRunId, stringifyWithUint8Array(updatedRun));
          await cleanupHooks(effectiveRunId);
          run = WorkflowRunSchema.parse(compact(updatedRun));
        }
      }

      if (data.eventType === 'run_cancelled') {
        const entry = await runsBucket.get(effectiveRunId);
        if (entry) {
          const existingData = kvValueToString(entry.value);
          const existing = parseWithUint8Array<WorkflowRun>(existingData);
          const updatedRun = {
            ...existing,
            status: 'cancelled' as const,
            completedAt: now,
            updatedAt: now,
          };
          await runsBucket.put(effectiveRunId, stringifyWithUint8Array(updatedRun));
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

        const stepKey = `${effectiveRunId}.${data.correlationId}`;
        const existing = await stepsBucket.get(stepKey);
        if (!existing) {
          await stepsBucket.put(stepKey, stringifyWithUint8Array(newStep));
          step = StepSchema.parse(compact(newStep));
        } else {
          // Event replay: return existing step
          const existingData = kvValueToString(existing.value);
          step = StepSchema.parse(compact(parseWithUint8Array<Step>(existingData)));
        }
      }

      if (data.eventType === 'step_started') {
        const isFirstStart = !validatedStep?.startedAt;
        const stepKey = `${effectiveRunId}.${data.correlationId}`;
        const entry = await stepsBucket.get(stepKey);
        if (entry) {
          const existingData = kvValueToString(entry.value);
          const existing = parseWithUint8Array<Step>(existingData);
          const updatedStep = {
            ...existing,
            status: 'running' as const,
            attempt: existing.attempt + 1,
            ...(isFirstStart ? { startedAt: now } : {}),
            updatedAt: now,
          };
          await stepsBucket.put(stepKey, stringifyWithUint8Array(updatedStep));
          step = StepSchema.parse(compact(updatedStep));
        }
      }

      if (data.eventType === 'step_completed') {
        const eventData = (data as any).eventData as { result?: any };
        const stepKey = `${effectiveRunId}.${data.correlationId}`;
        const entry = await stepsBucket.get(stepKey);
        if (entry) {
          const existingData = kvValueToString(entry.value);
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
          await stepsBucket.put(stepKey, stringifyWithUint8Array(updatedStep));
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

        const stepKey = `${effectiveRunId}.${data.correlationId}`;
        const entry = await stepsBucket.get(stepKey);
        if (entry) {
          const existingData = kvValueToString(entry.value);
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
          await stepsBucket.put(stepKey, stringifyWithUint8Array(updatedStep));
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

        const stepKey = `${effectiveRunId}.${data.correlationId}`;
        const entry = await stepsBucket.get(stepKey);
        if (entry) {
          const existingData = kvValueToString(entry.value);
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
          await stepsBucket.put(stepKey, stringifyWithUint8Array(updatedStep));
          step = StepSchema.parse(compact(updatedStep));
        }
      }

      if (data.eventType === 'hook_created') {
        const eventData = (data as any).eventData as {
          token: string;
          metadata?: any;
        };

        // Check for duplicate token
        const existingHookId = await hooksTokenBucket.get(eventData.token);
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

          await eventsBucket.put(eventId, stringifyWithUint8Array(conflictEvent));

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

        const existing = await hooksBucket.get(data.correlationId!);
        if (!existing) {
          await hooksBucket.put(data.correlationId!, stringifyWithUint8Array(newHook));
          await hooksTokenBucket.put(eventData.token, data.correlationId!);
          hook = HookSchema.parse(compact(newHook));
        } else {
          // Event replay: return existing hook
          const existingData = kvValueToString(existing.value);
          hook = HookSchema.parse(compact(parseWithUint8Array<Hook>(existingData)));
        }
      }

      if (data.eventType === 'hook_disposed' && data.correlationId) {
        const hookEntry = await hooksBucket.get(data.correlationId);
        if (hookEntry) {
          const hookData = kvValueToString(hookEntry.value);
          const existingHook = parseWithUint8Array<Hook>(hookData);
          await hooksBucket.delete(data.correlationId);
          await hooksTokenBucket.delete(existingHook.token);
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

      await eventsBucket.put(eventId, stringifyWithUint8Array(event));

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
      await initBuckets();
      const entry = await eventsBucket.get(eventId);
      if (!entry) {
        throw new WorkflowWorldError(`Event not found: ${eventId}`, {
          status: 404,
        });
      }
      const data = kvValueToString(entry.value);
      return parseWithUint8Array<Event>(data);
    },

    async list(params: ListEventsParams): Promise<PaginatedResponse<Event>> {
      await initBuckets();
      const limit = params?.pagination?.limit ?? 100;
      const sortOrder = params.pagination?.sortOrder || 'asc';
      const resolveData = params?.resolveData ?? 'all';

      const events: Event[] = [];

      for await (const entry of await eventsBucket.history()) {
        if (!entry || entry.operation === 'DEL') continue;

        const data = kvValueToString(entry.value);
        const event = parseWithUint8Array<Event>(data);

        if (event.runId === params.runId) {
          events.push(event);
        }
      }

      // Sort by createdAt
      if (sortOrder === 'asc') {
        events.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      } else {
        events.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
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
          return filterEventData(parsed, resolveData);
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

      for await (const entry of await eventsBucket.history()) {
        if (!entry || entry.operation === 'DEL') continue;

        const data = kvValueToString(entry.value);
        const event = parseWithUint8Array<Event>(data);

        if (event.correlationId === params.correlationId) {
          events.push(event);
        }
      }

      // Sort by createdAt
      if (sortOrder === 'asc') {
        events.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      } else {
        events.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
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
          return filterEventData(parsed, resolveData);
        }),
        cursor: values.at(-1)?.eventId ?? null,
        hasMore,
      };
    },
  };
}

/**
 * Create storage for workflow steps using JetStream KV Store
 */
export function createStepsStorage(config: NatsStorageConfig): Storage['steps'] {
  const { getJetStream, keyPrefix } = config;
  let stepsBucket: KV;

  const initBuckets = async () => {
    if (!stepsBucket) {
      const jetstream = await getJetStream();
      stepsBucket = await jetstream.views.kv(`${keyPrefix}steps`, {
        history: 10,
      });
    }
  };

  return {
    get: (async (runId: string | undefined, stepId: string, params?: GetStepParams) => {
      await initBuckets();

      // If runId provided, use direct lookup
      if (runId) {
        const stepKey = `${runId}.${stepId}`;
        const entry = await stepsBucket.get(stepKey);
        if (!entry) {
          throw new WorkflowWorldError(`Step not found: ${stepId}`, {
            status: 404,
          });
        }
        const data = kvValueToString(entry.value);
        const step = parseWithUint8Array<Step>(data);
        const parsed = StepSchema.parse(compact(step));
        const resolveData = params?.resolveData ?? 'all';
        return filterStepData(parsed, resolveData);
      }

      // Otherwise scan all steps
      for await (const entry of await stepsBucket.history()) {
        if (!entry || entry.operation === 'DEL') continue;

        const data = kvValueToString(entry.value);
        const step = parseWithUint8Array<Step>(data);

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

      for await (const entry of await stepsBucket.history()) {
        if (!entry || entry.operation === 'DEL') continue;

        const data = kvValueToString(entry.value);
        const step = parseWithUint8Array<Step>(data);

        if (step.runId === params.runId) {
          const parsed = StepSchema.parse(compact(step));
          steps.push(filterStepData(parsed, resolveData));
        }
      }

      // Sort by createdAt descending
      steps.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

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

/**
 * Create storage for hooks using JetStream KV Store
 */
export function createHooksStorage(config: NatsStorageConfig): Storage['hooks'] {
  const { getJetStream, keyPrefix } = config;
  let hooksBucket: KV;
  let hooksTokenBucket: KV;

  const initBuckets = async () => {
    if (!hooksBucket) {
      const jetstream = await getJetStream();
      hooksBucket = await jetstream.views.kv(`${keyPrefix}hooks`, {
        history: 10,
      });
      hooksTokenBucket = await jetstream.views.kv(`${keyPrefix}hooks_by_token`, {
        history: 1,
      });
    }
  };

  return {
    async get(hookId: string, params?: GetHookParams): Promise<Hook> {
      await initBuckets();
      const entry = await hooksBucket.get(hookId);
      if (!entry) {
        throw new WorkflowWorldError(`Hook not found: ${hookId}`, {
          status: 404,
        });
      }
      const data = kvValueToString(entry.value);
      const hook = parseWithUint8Array<Hook>(data);
      const parsed = HookSchema.parse(compact(hook));
      const resolveData = params?.resolveData ?? 'all';
      return filterHookData(parsed, resolveData);
    },

    async getByToken(token: string, params?: GetHookParams): Promise<Hook> {
      await initBuckets();
      const entry = await hooksTokenBucket.get(token);
      if (!entry) {
        throw new WorkflowWorldError(`Hook not found for token: ${token}`, {
          status: 404,
        });
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

      for await (const entry of await hooksBucket.history()) {
        if (!entry || entry.operation === 'DEL') continue;

        const data = kvValueToString(entry.value);
        const hook = parseWithUint8Array<Hook>(data);

        if (hook.runId === params.runId) {
          const parsed = HookSchema.parse(compact(hook));
          const filtered = filterHookData(parsed, params?.resolveData ?? 'all');
          hooks.push(filtered);
        }
      }

      // Sort by createdAt descending
      hooks.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

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

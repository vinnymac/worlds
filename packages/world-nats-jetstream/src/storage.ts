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
import { parse, stringify } from '@fantasticfour/utils';
import { compact, debug } from './util.js';

interface NatsStorageConfig {
  getJetStream: () => Promise<JetStreamClient>;
  keyPrefix: string;
  terminalRunTTLMs?: number;
}

/** Default TTL for terminal runs: 30 days. */
const DEFAULT_TERMINAL_RUN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

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

// ---------------------------------------------------------------------------
// Secondary index helpers
// ---------------------------------------------------------------------------

/**
 * Collect all keys currently stored in a KV bucket that match a given prefix.
 * Returns the *values* (decoded as strings) for matching keys.
 */
async function collectIndexKeys(bucket: KV, prefix: string): Promise<string[]> {
  const results: string[] = [];
  try {
    const keys = await bucket.keys();
    for await (const key of keys) {
      if (key.startsWith(prefix)) {
        results.push(key.slice(prefix.length));
      }
    }
  } catch {
    // Bucket may be empty — that's fine
  }
  return results;
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

  const initBuckets = async () => {
    if (!runsBucket) {
      const jetstream = await getJetStream();
      runsBucket = await jetstream.views.kv(`${keyPrefix}runs`, {
        history: 10,
      });
      runsByStatusBucket = await jetstream.views.kv(`${keyPrefix}runs_by_status`, {
        history: 1,
      });
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
            const entry = await runsBucket.get(runId);
            if (!entry || entry.operation === 'DEL') continue;

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
        // No status filter — fall back to full bucket scan
        for await (const entry of await runsBucket.history()) {
          if (!entry || entry.operation === 'DEL') continue;

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

// ---------------------------------------------------------------------------
// Events storage
// ---------------------------------------------------------------------------

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
  // Secondary index buckets
  let runsByStatusBucket: KV;
  let stepsByRunBucket: KV;
  let hooksByRunBucket: KV;

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
      // Secondary indexes
      runsByStatusBucket = await jetstream.views.kv(`${keyPrefix}runs_by_status`, {
        history: 1,
      });
      stepsByRunBucket = await jetstream.views.kv(`${keyPrefix}steps_by_run`, {
        history: 1,
      });
      hooksByRunBucket = await jetstream.views.kv(`${keyPrefix}hooks_by_run`, {
        history: 1,
      });
    }
  };

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

  // Helper: Clean up hooks when run reaches terminal status
  async function cleanupHooks(runId: string): Promise<void> {
    await initBuckets();

    // Try index-based lookup first
    const hookIds = await collectIndexKeys(hooksByRunBucket, `${runId}.`);

    if (hookIds.length > 0) {
      for (const hookId of hookIds) {
        try {
          const hookEntry = await hooksBucket.get(hookId);
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
    } else {
      // Fallback: full scan (handles data created before indexes existed)
      for await (const entry of await hooksBucket.history()) {
        if (!entry || entry.operation === 'DEL') continue;

        const data = kvValueToString(entry.value);
        const hook = parse<Hook>(data);

        if (hook.runId === runId) {
          await hooksBucket.delete(hook.hookId);
          await hooksTokenBucket.delete(hook.token);
        }
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
        const event: Event = {
          ...data,
          runId,
          eventId,
          createdAt,
          specVersion: SPEC_VERSION_CURRENT,
        };

        await eventsBucket.put(eventId, stringify(event));
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
          const parsed = parse<WorkflowRun>(runData);
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
          await eventsBucket.put(eventId, stringify(event));

          const parsed = EventSchema.parse(event);
          const resolveData = params?.resolveData ?? 'all';
          return {
            event: filterEventData(parsed, resolveData),
            run: fullRunEntry
              ? (parse<WorkflowRun>(kvValueToString(fullRunEntry.value)) as WorkflowRun)
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
          const parsed = parse<Step>(stepData);
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
          await runsBucket.put(effectiveRunId, stringify(newRun));
          await indexRunStatus(effectiveRunId, 'pending');
          run = WorkflowRunSchema.parse(compact(newRun));
        } else {
          // Event replay: return existing run
          const existingData = kvValueToString(existing.value);
          run = WorkflowRunSchema.parse(compact(parse<WorkflowRun>(existingData)));
        }
      }

      if (data.eventType === 'run_started') {
        const entry = await runsBucket.get(effectiveRunId);
        if (entry) {
          const existingData = kvValueToString(entry.value);
          const existing = parse<WorkflowRun>(existingData);
          const oldStatus = existing.status;
          const updatedRun = {
            ...existing,
            status: 'running' as const,
            startedAt: now,
            updatedAt: now,
          };
          await runsBucket.put(effectiveRunId, stringify(updatedRun));
          await reindexRunStatus(effectiveRunId, oldStatus, 'running');
          run = WorkflowRunSchema.parse(compact(updatedRun));
        }
      }

      if (data.eventType === 'run_completed') {
        const eventData = (data as any).eventData as { output?: any };
        const entry = await runsBucket.get(effectiveRunId);
        if (entry) {
          const existingData = kvValueToString(entry.value);
          const existing = parse<WorkflowRun>(existingData);
          const oldStatus = existing.status;
          const updatedRun = {
            ...existing,
            status: 'completed' as const,
            output: eventData.output,
            completedAt: now,
            updatedAt: now,
          };
          await runsBucket.put(effectiveRunId, stringify(updatedRun));
          await reindexRunStatus(effectiveRunId, oldStatus, 'completed');
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
          const existing = parse<WorkflowRun>(existingData);
          const oldStatus = existing.status;
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
          await runsBucket.put(effectiveRunId, stringify(updatedRun));
          await reindexRunStatus(effectiveRunId, oldStatus, 'failed');
          await cleanupHooks(effectiveRunId);
          run = WorkflowRunSchema.parse(compact(updatedRun));
        }
      }

      if (data.eventType === 'run_cancelled') {
        const entry = await runsBucket.get(effectiveRunId);
        if (entry) {
          const existingData = kvValueToString(entry.value);
          const existing = parse<WorkflowRun>(existingData);
          const oldStatus = existing.status;
          const updatedRun = {
            ...existing,
            status: 'cancelled' as const,
            completedAt: now,
            updatedAt: now,
          };
          await runsBucket.put(effectiveRunId, stringify(updatedRun));
          await reindexRunStatus(effectiveRunId, oldStatus, 'cancelled');
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
          await stepsBucket.put(stepKey, stringify(newStep));
          await indexStep(effectiveRunId, data.correlationId!);
          step = StepSchema.parse(compact(newStep));
        } else {
          // Event replay: return existing step
          const existingData = kvValueToString(existing.value);
          step = StepSchema.parse(compact(parse<Step>(existingData)));
        }
      }

      if (data.eventType === 'step_started') {
        const isFirstStart = !validatedStep?.startedAt;
        const stepKey = `${effectiveRunId}.${data.correlationId}`;
        const entry = await stepsBucket.get(stepKey);
        if (entry) {
          const existingData = kvValueToString(entry.value);
          const existing = parse<Step>(existingData);
          const updatedStep = {
            ...existing,
            status: 'running' as const,
            attempt: existing.attempt + 1,
            ...(isFirstStart ? { startedAt: now } : {}),
            updatedAt: now,
          };
          await stepsBucket.put(stepKey, stringify(updatedStep));
          step = StepSchema.parse(compact(updatedStep));
        }
      }

      if (data.eventType === 'step_completed') {
        const eventData = (data as any).eventData as { result?: any };
        const stepKey = `${effectiveRunId}.${data.correlationId}`;
        const entry = await stepsBucket.get(stepKey);
        if (entry) {
          const existingData = kvValueToString(entry.value);
          const existing = parse<Step>(existingData);
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
          await stepsBucket.put(stepKey, stringify(updatedStep));
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
          const existing = parse<Step>(existingData);
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
          await stepsBucket.put(stepKey, stringify(updatedStep));
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
          const existing = parse<Step>(existingData);
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
          await stepsBucket.put(stepKey, stringify(updatedStep));
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

          await eventsBucket.put(eventId, stringify(conflictEvent));

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
          await hooksBucket.put(data.correlationId!, stringify(newHook));
          await hooksTokenBucket.put(eventData.token, data.correlationId!);
          await indexHook(effectiveRunId, data.correlationId!);
          hook = HookSchema.parse(compact(newHook));
        } else {
          // Event replay: return existing hook
          const existingData = kvValueToString(existing.value);
          hook = HookSchema.parse(compact(parse<Hook>(existingData)));
        }
      }

      if (data.eventType === 'hook_disposed' && data.correlationId) {
        const hookEntry = await hooksBucket.get(data.correlationId);
        if (hookEntry) {
          const hookData = kvValueToString(hookEntry.value);
          const existingHook = parse<Hook>(hookData);
          await hooksBucket.delete(data.correlationId);
          await hooksTokenBucket.delete(existingHook.token);
          await removeHookIndex(effectiveRunId, data.correlationId);
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

      await eventsBucket.put(eventId, stringify(event));

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
      return parse<Event>(data);
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
        const event = parse<Event>(data);

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
        const event = parse<Event>(data);

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

  const initBuckets = async () => {
    if (!stepsBucket) {
      const jetstream = await getJetStream();
      stepsBucket = await jetstream.views.kv(`${keyPrefix}steps`, {
        history: 10,
      });
      stepsByRunBucket = await jetstream.views.kv(`${keyPrefix}steps_by_run`, {
        history: 1,
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
        const step = parse<Step>(data);
        const parsed = StepSchema.parse(compact(step));
        const resolveData = params?.resolveData ?? 'all';
        return filterStepData(parsed, resolveData);
      }

      // Otherwise scan all steps
      for await (const entry of await stepsBucket.history()) {
        if (!entry || entry.operation === 'DEL') continue;

        const data = kvValueToString(entry.value);
        const step = parse<Step>(data);

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

      // Try index-based lookup first
      const stepIds = await collectIndexKeys(stepsByRunBucket, `${params.runId}.`);

      if (stepIds.length > 0) {
        for (const stepId of stepIds) {
          const stepKey = `${params.runId}.${stepId}`;
          try {
            const entry = await stepsBucket.get(stepKey);
            if (!entry || entry.operation === 'DEL') continue;

            const data = kvValueToString(entry.value);
            const step = parse<Step>(data);
            const parsed = StepSchema.parse(compact(step));
            steps.push(filterStepData(parsed, resolveData));
          } catch {
            debug(`Stale index entry for step ${stepId}, skipping`);
          }
        }
      } else {
        // Fallback: full scan (handles data created before indexes existed)
        for await (const entry of await stepsBucket.history()) {
          if (!entry || entry.operation === 'DEL') continue;

          const data = kvValueToString(entry.value);
          const step = parse<Step>(data);

          if (step.runId === params.runId) {
            const parsed = StepSchema.parse(compact(step));
            steps.push(filterStepData(parsed, resolveData));
          }
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

  const initBuckets = async () => {
    if (!hooksBucket) {
      const jetstream = await getJetStream();
      hooksBucket = await jetstream.views.kv(`${keyPrefix}hooks`, {
        history: 10,
      });
      hooksTokenBucket = await jetstream.views.kv(`${keyPrefix}hooks_by_token`, {
        history: 1,
      });
      hooksByRunBucket = await jetstream.views.kv(`${keyPrefix}hooks_by_run`, {
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
      const hook = parse<Hook>(data);
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

      // Try index-based lookup first
      const hookIds = await collectIndexKeys(hooksByRunBucket, `${params.runId}.`);

      if (hookIds.length > 0) {
        for (const hookId of hookIds) {
          try {
            const entry = await hooksBucket.get(hookId);
            if (!entry || entry.operation === 'DEL') continue;

            const data = kvValueToString(entry.value);
            const hook = parse<Hook>(data);
            const parsed = HookSchema.parse(compact(hook));
            const filtered = filterHookData(parsed, params?.resolveData ?? 'all');
            hooks.push(filtered);
          } catch {
            debug(`Stale index entry for hook ${hookId}, skipping`);
          }
        }
      } else {
        // Fallback: full scan (handles data created before indexes existed)
        for await (const entry of await hooksBucket.history()) {
          if (!entry || entry.operation === 'DEL') continue;

          const data = kvValueToString(entry.value);
          const hook = parse<Hook>(data);

          if (hook.runId === params.runId) {
            const parsed = HookSchema.parse(compact(hook));
            const filtered = filterHookData(parsed, params?.resolveData ?? 'all');
            hooks.push(filtered);
          }
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

// ---------------------------------------------------------------------------
// Compaction
// ---------------------------------------------------------------------------

const TERMINAL_STATUSES = ['completed', 'failed', 'cancelled'] as const;

/**
 * Compact terminal runs that exceed the configured TTL.
 *
 * Deletes the run plus its associated steps, hooks, events, and index
 * entries. Intended to be called periodically (e.g. via `setInterval`).
 */
export async function compactTerminalRuns(config: NatsStorageConfig): Promise<number> {
  const { getJetStream, keyPrefix, terminalRunTTLMs } = config;
  const ttl = terminalRunTTLMs ?? DEFAULT_TERMINAL_RUN_TTL_MS;

  // 0 means retain indefinitely
  if (ttl === 0) return 0;

  const cutoff = Date.now() - ttl;

  const jetstream = await getJetStream();
  const runsBucket = await jetstream.views.kv(`${keyPrefix}runs`, { history: 10 });
  const runsByStatusBucket = await jetstream.views.kv(`${keyPrefix}runs_by_status`, { history: 1 });
  const stepsBucket = await jetstream.views.kv(`${keyPrefix}steps`, { history: 10 });
  const stepsByRunBucket = await jetstream.views.kv(`${keyPrefix}steps_by_run`, { history: 1 });
  const hooksBucket = await jetstream.views.kv(`${keyPrefix}hooks`, { history: 10 });
  const hooksByRunBucket = await jetstream.views.kv(`${keyPrefix}hooks_by_run`, { history: 1 });
  const hooksTokenBucket = await jetstream.views.kv(`${keyPrefix}hooks_by_token`, { history: 1 });
  const eventsBucket = await jetstream.views.kv(`${keyPrefix}events`, { history: 10 });

  let compactedCount = 0;

  // Iterate terminal run index entries
  for (const status of TERMINAL_STATUSES) {
    const runIds = await collectIndexKeys(runsByStatusBucket, `${status}.`);

    for (const runId of runIds) {
      try {
        const entry = await runsBucket.get(runId);
        if (!entry) {
          // Stale index — clean up
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
            const hookEntry = await hooksBucket.get(hookId);
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

        // Delete associated events (full scan — events aren't indexed by run)
        for await (const evtEntry of await eventsBucket.history()) {
          if (!evtEntry || evtEntry.operation === 'DEL') continue;
          const evtData = kvValueToString(evtEntry.value);
          const evt = parse<Event>(evtData);
          if (evt.runId === runId) {
            try {
              await eventsBucket.delete(evt.eventId);
            } catch {
              /* noop */
            }
          }
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

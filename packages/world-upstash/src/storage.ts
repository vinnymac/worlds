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
  ulidToDate,
  WorkflowRunSchema,
} from '@workflow/world';
import type { Redis } from '@upstash/redis';
import { monotonicFactory } from 'ulid';
import { compact, stringify, parse } from './util.js';

interface UpstashStorageConfig {
  redis: Redis;
  keyPrefix: string;
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
 * A hook token claim, stored at `hooks:by_token:{token}`.
 *
 * The claim is the atomic arbiter for token ownership (written with SETNX).
 * It records the owning (runId, hookId) so a duplicate hook_created from the
 * same run can be told apart from a real cross-run conflict, and the
 * canonical hook_created eventId so crash-recovery retries converge on a
 * single event in the log (mirrors world-local's token claim file).
 */
interface HookTokenClaim {
  hookId: string;
  runId?: string;
  eventId?: string;
}

/**
 * Parse a hook token claim value.
 *
 * New format: JSON `{ runId, hookId, eventId }` — @upstash/redis
 * auto-deserialization returns it as an object. Legacy format (pre-1.4):
 * a plain hookId string with no ownership metadata.
 */
function parseHookTokenClaim(raw: unknown): HookTokenClaim | null {
  if (raw == null) {
    return null;
  }
  if (typeof raw === 'object') {
    const claim = raw as Record<string, unknown>;
    if (typeof claim.hookId !== 'string') {
      return null;
    }
    return {
      hookId: claim.hookId,
      runId: typeof claim.runId === 'string' ? claim.runId : undefined,
      eventId: typeof claim.eventId === 'string' ? claim.eventId : undefined,
    };
  }
  if (typeof raw === 'string') {
    // A JSON claim that escaped auto-deserialization, or a legacy plain hookId.
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        return parseHookTokenClaim(parsed);
      }
    } catch {
      // Not JSON — fall through to the legacy plain-hookId format.
    }
    return { hookId: raw };
  }
  return null;
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
        // Core retries runs.get on WorkflowRunNotFoundError (matched by name)
        // to absorb the create/start race — a generic error would not match.
        throw new WorkflowRunNotFoundError(id);
      }
      const run = parse<WorkflowRun>(data);
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

        const run: WorkflowRun = parse<WorkflowRun>(data);
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
  // Exactly-once arbiter for entity-creating events (SETNX stores the
  // canonical eventId). This is the Redis equivalent of world-postgres's
  // `workflow_events_entity_creation_unique` constraint: it prevents two
  // concurrent deliveries from appending duplicate creation events, and it
  // lets a crash-recovery retry adopt the canonical eventId to complete a
  // partial write.
  const creationEventClaimKey = (runId: string, correlationId: string, eventType: string) =>
    `${keyPrefix}events:creation:${runId}:${correlationId}:${eventType}`;

  const runKey = (id: string) => `${keyPrefix}run:${id}`;
  const runsIndexKey = () => `${keyPrefix}runs:index`;
  const runsByNameKey = (name: string) => `${keyPrefix}runs:by_name:${name}`;
  const runsByStatusKey = (status: string) => `${keyPrefix}runs:by_status:${status}`;

  const stepKey = (runId: string, stepId: string) => `${keyPrefix}step:${runId}:${stepId}`;
  const stepsIndexKey = (runId: string) => `${keyPrefix}steps:by_run:${runId}`;

  const hookKey = (hookId: string) => `${keyPrefix}hook:${hookId}`;
  const hooksByTokenKey = (token: string) => `${keyPrefix}hooks:by_token:${token}`;
  const hooksIndexKey = (runId: string) => `${keyPrefix}hooks:by_run:${runId}`;

  /**
   * Probe the event log for an existing hook_created event for this
   * (runId, hookId). Used by the legacy-claim recovery path to detect
   * "already published" before appending — legacy token claims (plain
   * hookId, no eventId) cannot arbitrate publication on their own.
   */
  async function findHookCreatedEventId(runId: string, hookId: string): Promise<string | null> {
    const eventIds = await redis.zrange<string[]>(eventsByCorrelationKey(hookId), 0, -1);
    for (const eid of eventIds) {
      const data = await redis.get<string>(eventKey(eid));
      if (!data) {
        continue;
      }
      const event = parse<Event>(data);
      if (event.eventType === 'hook_created' && event.runId === runId) {
        return eid;
      }
    }
    return null;
  }

  async function cleanupHooks(runId: string): Promise<void> {
    const indexKey = hooksIndexKey(runId);
    const hookIds = await redis.zrange<string[]>(indexKey, 0, -1);

    for (const hookId of hookIds) {
      const hookData = await redis.get<string>(hookKey(hookId));
      if (hookData) {
        const hook = parse<Hook>(hookData);
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
          const existing = parse<WorkflowRun>(existingData);
          const updatedRun = {
            ...existing,
            status: 'cancelled' as const,
            completedAt: now,
            updatedAt: now,
          };
          await redis.set(runKey(runId), stringify(updatedRun));

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

        await redis.set(eventKey(eventId), stringify(event));
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
      let eventId = `wevt_${ulid()}`;
      // When a retry adopts a canonical eventId persisted by a prior
      // (crashed or concurrent) attempt, the event's createdAt is derived
      // from that ULID so converging writers produce consistent content.
      let adoptedEventCreatedAt: Date | undefined;
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
      const isStepTerminal = (status: string) =>
        ['completed', 'failed', 'cancelled'].includes(status);

      let currentRun: {
        status: string;
        specVersion?: number;
      } | null = null;
      const skipRunValidationEvents = ['step_completed', 'step_retrying'];
      if (data.eventType !== 'run_created' && !skipRunValidationEvents.includes(data.eventType)) {
        const runData = await redis.get<string>(runKey(effectiveRunId));
        if (runData) {
          const parsed = parse<WorkflowRun>(runData);
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
          // Use SETNX for idempotent creation
          const wasCreated = await redis.setnx(runKey(effectiveRunId), stringify(newRun));
          if (wasCreated === 1) {
            // Index the new run
            const score = now.getTime();
            await redis.zadd(runsIndexKey(), { score, member: effectiveRunId });
            await redis.zadd(runsByNameKey(runInputData.workflowName), {
              score,
              member: effectiveRunId,
            });
            await redis.zadd(runsByStatusKey('pending'), { score, member: effectiveRunId });
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
            await redis.set(eventKey(runCreatedEventId), stringify(runCreatedEvent));
            await redis.zadd(eventsIndexKey(effectiveRunId), {
              score: now.getTime(),
              member: runCreatedEventId,
            });
            currentRun = { status: 'pending', specVersion: effectiveSpecVersion };
          } else {
            // Run already exists — re-read state
            const runData = await redis.get<string>(runKey(effectiveRunId));
            if (runData) {
              const parsed = parse<WorkflowRun>(runData);
              currentRun = { status: parsed.status, specVersion: parsed.specVersion };
            }
          }
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
          await redis.set(eventKey(eventId), stringify(event));
          const score = createdAt.getTime();
          await redis.zadd(eventsIndexKey(effectiveRunId), { score, member: eventId });

          const parsed = EventSchema.parse(event);
          const resolveData = params?.resolveData ?? 'all';
          return {
            event: filterEventData(parsed, resolveData),
            run: fullRunData ? (parse<WorkflowRun>(fullRunData) as WorkflowRun) : undefined,
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
        if (data.eventType === 'step_created' || data.eventType === 'hook_created') {
          throw new EntityConflictError(
            `Cannot create new entities on run in terminal state "${currentRun.status}"`,
          );
        }
      }

      let validatedStep: { status: string; startedAt?: Date; retryAfter?: Date } | null = null;
      const stepEventsNeedingValidation = ['step_started', 'step_retrying'];
      if (stepEventsNeedingValidation.includes(data.eventType) && data.correlationId) {
        const stepData = await redis.get<string>(stepKey(effectiveRunId, data.correlationId));
        if (stepData) {
          const parsed = parse<Step>(stepData);
          validatedStep = {
            status: parsed.status,
            startedAt: parsed.startedAt,
            retryAfter: parsed.retryAfter,
          };
        }

        if (!validatedStep) {
          throw new WorkflowWorldError(`Step "${data.correlationId}" not found`, { status: 404 });
        }

        // Core detects this by name via EntityConflictError.is() and skips
        // the step + re-enqueues the workflow.
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

      const hookEventsRequiringExistence = ['hook_disposed', 'hook_received'];
      if (hookEventsRequiringExistence.includes(data.eventType) && data.correlationId) {
        const existingHook = await redis.get<string>(hookKey(data.correlationId));
        if (!existingHook) {
          throw new HookNotFoundError(data.correlationId);
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

        const wasCreated = await redis.setnx(runKey(effectiveRunId), stringify(newRun));

        // Duplicate run_created (e.g. the resilient-start bootstrap won the
        // race, or a duplicate start with a client-provided runId). Throw
        // instead of appending a second run_created event — core catches
        // EntityConflictError from start() as the benign "run already
        // exists" signal, and a duplicate event would corrupt the log.
        if (wasCreated !== 1) {
          throw new EntityConflictError(`Workflow run "${effectiveRunId}" already exists`);
        }

        const score = now.getTime();
        await redis.zadd(runsIndexKey(), { score, member: effectiveRunId });
        await redis.zadd(runsByNameKey(eventData.workflowName), {
          score,
          member: effectiveRunId,
        });
        await redis.zadd(runsByStatusKey('pending'), { score, member: effectiveRunId });

        run = WorkflowRunSchema.parse(compact(newRun));
      }

      if (data.eventType === 'run_started') {
        // Idempotency: if run is already past pending, this is a replay.
        // Return existing run state without creating a duplicate event.
        if (currentRun?.status === 'running') {
          const existingData = await redis.get<string>(runKey(effectiveRunId));
          if (existingData) {
            run = WorkflowRunSchema.parse(compact(parse<WorkflowRun>(existingData)));
          }
          const resolveData = params?.resolveData ?? 'all';
          return { run: run ? (filterRunData(run, resolveData) as WorkflowRun) : undefined };
        }

        const existingData = await redis.get<string>(runKey(effectiveRunId));
        if (!existingData) {
          // No run entity and no runInput bootstrap above — surface a
          // retryable not-found instead of logging an orphan run_started
          // event. QStash will retry once run_created lands.
          throw new WorkflowRunNotFoundError(effectiveRunId);
        }
        const existing = parse<WorkflowRun>(existingData);
        const updatedRun = {
          ...existing,
          status: 'running' as const,
          startedAt: now,
          updatedAt: now,
        };
        await redis.set(runKey(effectiveRunId), stringify(updatedRun));

        await redis.zrem(runsByStatusKey(existing.status), existing.runId);
        await redis.zadd(runsByStatusKey('running'), {
          score: now.getTime(),
          member: effectiveRunId,
        });

        run = WorkflowRunSchema.parse(compact(updatedRun));
      }

      if (data.eventType === 'run_completed') {
        const eventData = (data as any).eventData as { output?: any };
        const existingData = await redis.get<string>(runKey(effectiveRunId));
        if (!existingData) {
          throw new WorkflowRunNotFoundError(effectiveRunId);
        }
        const existing = parse<WorkflowRun>(existingData);
        const updatedRun = {
          ...existing,
          status: 'completed' as const,
          output: eventData.output,
          completedAt: now,
          updatedAt: now,
        };
        await redis.set(runKey(effectiveRunId), stringify(updatedRun));

        await redis.zrem(runsByStatusKey(existing.status), existing.runId);
        await redis.zadd(runsByStatusKey('completed'), {
          score: now.getTime(),
          member: effectiveRunId,
        });

        await cleanupHooks(effectiveRunId);

        run = WorkflowRunSchema.parse(compact(updatedRun));
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
        if (!existingData) {
          throw new WorkflowRunNotFoundError(effectiveRunId);
        }
        const existing = parse<WorkflowRun>(existingData);
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
        await redis.set(runKey(effectiveRunId), stringify(updatedRun));

        await redis.zrem(runsByStatusKey(existing.status), existing.runId);
        await redis.zadd(runsByStatusKey('failed'), {
          score: now.getTime(),
          member: effectiveRunId,
        });

        await cleanupHooks(effectiveRunId);

        run = WorkflowRunSchema.parse(compact(updatedRun));
      }

      if (data.eventType === 'run_cancelled') {
        const existingData = await redis.get<string>(runKey(effectiveRunId));
        if (!existingData) {
          throw new WorkflowRunNotFoundError(effectiveRunId);
        }
        const existing = parse<WorkflowRun>(existingData);
        const updatedRun = {
          ...existing,
          status: 'cancelled' as const,
          completedAt: now,
          updatedAt: now,
        };
        await redis.set(runKey(effectiveRunId), stringify(updatedRun));

        await redis.zrem(runsByStatusKey(existing.status), existing.runId);
        await redis.zadd(runsByStatusKey('cancelled'), {
          score: now.getTime(),
          member: effectiveRunId,
        });

        await cleanupHooks(effectiveRunId);

        run = WorkflowRunSchema.parse(compact(updatedRun));
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
          stringify(newStep),
        );

        // Always add to index (ZADD is idempotent)
        await redis.zadd(stepsIndexKey(effectiveRunId), {
          score: now.getTime(),
          member: data.correlationId!,
        });

        if (wasCreated === 1) {
          step = StepSchema.parse(compact(newStep));
        } else {
          // Entity already exists — duplicate delivery or crash orphan.
          // Which one is decided by the creation-event claim below.
          const existingData = await redis.get<string>(
            stepKey(effectiveRunId, data.correlationId!),
          );
          if (existingData) {
            step = StepSchema.parse(compact(parse<Step>(existingData)));
          }
        }

        // Claim the step_created event slot. Exactly one delivery may append
        // the event; a real duplicate (event already in the log) throws
        // EntityConflictError, which core catches as "step already exists,
        // continuing". A crash orphan (entity written, event lost) adopts
        // the canonical eventId and completes the partial write.
        const claimKey = creationEventClaimKey(effectiveRunId, data.correlationId!, 'step_created');
        const claimedEvent = await redis.setnx(claimKey, eventId);
        if (claimedEvent !== 1) {
          const canonicalEventId = String(await redis.get(claimKey));
          const existingEvent = await redis.get(eventKey(canonicalEventId));
          if (existingEvent) {
            throw new EntityConflictError(`Step "${data.correlationId}" already exists`);
          }
          eventId = canonicalEventId;
          adoptedEventCreatedAt = ulidToDate(canonicalEventId.replace(/^wevt_/, '')) ?? undefined;
        }
      }

      if (data.eventType === 'step_started') {
        // Retried steps may be scheduled for later. Core converts
        // TooEarlyError into a { timeoutSeconds } redelivery signal.
        if (validatedStep?.retryAfter && validatedStep.retryAfter.getTime() > Date.now()) {
          throw new TooEarlyError(
            `Cannot start step "${data.correlationId}": retryAfter timestamp has not been reached yet`,
            {
              retryAfter: Math.ceil((validatedStep.retryAfter.getTime() - Date.now()) / 1000),
            },
          );
        }

        const isFirstStart = !validatedStep?.startedAt;
        const existingData = await redis.get<string>(stepKey(effectiveRunId, data.correlationId!));
        if (existingData) {
          const existing = parse<Step>(existingData);
          const updatedStep = {
            ...existing,
            status: 'running' as const,
            attempt: existing.attempt + 1,
            ...(isFirstStart ? { startedAt: now } : {}),
            // Clear retryAfter now that the step has started
            retryAfter: undefined,
            updatedAt: now,
          };
          await redis.set(stepKey(effectiveRunId, data.correlationId!), stringify(updatedStep));
          step = StepSchema.parse(compact(updatedStep));
        }
      }

      if (data.eventType === 'step_completed') {
        const eventData = (data as any).eventData as { result?: any };
        const existingData = await redis.get<string>(stepKey(effectiveRunId, data.correlationId!));
        if (existingData) {
          const existing = parse<Step>(existingData);
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
          await redis.set(stepKey(effectiveRunId, data.correlationId!), stringify(updatedStep));
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
          const existing = parse<Step>(existingData);
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
          await redis.set(stepKey(effectiveRunId, data.correlationId!), stringify(updatedStep));
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
          await redis.set(stepKey(effectiveRunId, data.correlationId!), stringify(updatedStep));
          step = StepSchema.parse(compact(updatedStep));
        }
      }

      if (data.eventType === 'hook_created') {
        const eventData = (data as any).eventData as {
          token: string;
          metadata?: any;
          isWebhook?: boolean;
        };
        const hookId = data.correlationId!;
        const tokenKey = hooksByTokenKey(eventData.token);

        const buildHook = (): Hook => ({
          runId: effectiveRunId,
          hookId,
          token: eventData.token,
          ownerId: '',
          projectId: '',
          environment: '',
          metadata: eventData.metadata,
          // Persist isWebhook so core's resumeWebhook can reject hooks
          // created via createHook() (isWebhook === false).
          isWebhook: eventData.isWebhook ?? false,
          specVersion: effectiveSpecVersion,
          createdAt: now,
        });

        // Atomically claim the token (first writer wins). The claim records
        // the owning (runId, hookId) and the canonical hook_created eventId
        // so duplicate deliveries and crash-recovery retries converge on a
        // single event in the log.
        const tokenClaimed = await redis.setnx(
          tokenKey,
          stringify({ runId: effectiveRunId, hookId, eventId }),
        );

        if (tokenClaimed === 1) {
          const newHook = buildHook();
          await redis.setnx(hookKey(hookId), stringify(newHook));
          await redis.zadd(hooksIndexKey(effectiveRunId), {
            score: now.getTime(),
            member: hookId,
          });
          hook = HookSchema.parse(compact(newHook));
        } else {
          const claim = parseHookTokenClaim(await redis.get(tokenKey));
          let claimRunId = claim?.runId;
          if (claim && claimRunId === undefined) {
            // Legacy claim (plain hookId): resolve ownership from the entity.
            const claimedHookData = await redis.get<string>(hookKey(claim.hookId));
            if (claimedHookData) {
              claimRunId = parse<Hook>(claimedHookData).runId;
            }
          }

          if (claim && claim.hookId === hookId && claimRunId === effectiveRunId) {
            // Same (runId, hookId): duplicate delivery or crash orphan.
            if (claim.eventId) {
              const existingEvent = await redis.get(eventKey(claim.eventId));
              if (existingEvent) {
                // Real duplicate — the event is already in the log. Core
                // catches EntityConflictError and continues.
                throw new EntityConflictError(`Hook "${hookId}" already created`);
              }
              // Crash orphan: claim/entity landed but the event write was
              // lost. Adopt the canonical eventId and complete the write.
              eventId = claim.eventId;
              adoptedEventCreatedAt = ulidToDate(claim.eventId.replace(/^wevt_/, '')) ?? undefined;
            } else {
              // Legacy claim without a canonical eventId: probe the log.
              const existingEventId = await findHookCreatedEventId(effectiveRunId, hookId);
              if (existingEventId) {
                throw new EntityConflictError(`Hook "${hookId}" already created`);
              }
              // Upgrade the claim with this retry's eventId. This narrows
              // (but cannot fully close) the cross-process race for claims
              // written before eventId was persisted inline.
              await redis.set(tokenKey, stringify({ runId: effectiveRunId, hookId, eventId }));
            }

            const existingData = await redis.get<string>(hookKey(hookId));
            if (existingData) {
              hook = HookSchema.parse(compact(parse<Hook>(existingData)));
            } else {
              const newHook = buildHook();
              await redis.setnx(hookKey(hookId), stringify(newHook));
              hook = HookSchema.parse(compact(newHook));
            }
            await redis.zadd(hooksIndexKey(effectiveRunId), {
              score: now.getTime(),
              member: hookId,
            });
          } else {
            // Cross-run conflict: a different (runId, hookId) holds this
            // token. Persist a hook_conflict event (with conflictingRunId
            // when known) so the workflow fails gracefully on await.
            const conflictEventData = {
              token: eventData.token,
              ...(claimRunId ? { conflictingRunId: claimRunId } : {}),
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

            await redis.set(eventKey(eventId), stringify(conflictEvent));
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
        }
      }

      if (data.eventType === 'hook_disposed' && data.correlationId) {
        const hookData = await redis.get<string>(hookKey(data.correlationId));
        if (hookData) {
          const existingHook = parse<Hook>(hookData);
          await redis.del(hookKey(data.correlationId));
          await redis.del(hooksByTokenKey(existingHook.token));
          await redis.zrem(hooksIndexKey(effectiveRunId), data.correlationId);
        }
      }

      const createdAt = adoptedEventCreatedAt ?? new Date();
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

      await redis.set(eventKey(eventId), stringify(event));

      const score = createdAt.getTime();
      await redis.zadd(eventsIndexKey(effectiveRunId), { score, member: eventId });
      if (data.correlationId) {
        await redis.zadd(eventsByCorrelationKey(data.correlationId), { score, member: eventId });
      }

      const parsed = EventSchema.parse(event);
      const resolveData = params?.resolveData ?? 'all';

      // Preload all events for run_started to reduce TTFB
      let allEvents: Event[] | undefined;
      if (data.eventType === 'run_started' && run) {
        const allEventIds = await redis.zrange<string[]>(eventsIndexKey(effectiveRunId), 0, -1);
        if (allEventIds.length > 0) {
          const eventsList: Event[] = [];
          for (const eid of allEventIds) {
            const eData = await redis.get<string>(eventKey(eid));
            if (eData) {
              const e = parse<Event>(eData);
              const p = EventSchema.parse(compact(e));
              eventsList.push(filterEventData(p, resolveData));
            }
          }
          allEvents = eventsList;
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
      const data = await redis.get<string>(eventKey(eventId));
      if (!data) {
        throw new WorkflowWorldError(`Event not found: ${eventId}`, {
          status: 404,
        });
      }
      return parse<Event>(data);
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
          const event = parse<Event>(data);
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
          const event = parse<Event>(data);
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

    const step = parse<Step>(data);
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
          const step = parse<Step>(data);
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
        // Core (resumeHook/resumeWebhook) matches this by name so unknown
        // or expired tokens surface as a 404, not an unrecognized 500.
        throw new HookNotFoundError(hookId);
      }
      const hook = parse<Hook>(data);
      const parsed = HookSchema.parse(compact(hook));
      const resolveData = params?.resolveData ?? 'all';
      return filterHookData(parsed, resolveData);
    },

    async getByToken(token: string, params?: GetHookParams): Promise<Hook> {
      const claim = parseHookTokenClaim(await redis.get(hooksByTokenKey(token)));
      if (!claim) {
        throw new HookNotFoundError(token);
      }
      return this.get(claim.hookId, params);
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
          const hook = parse<Hook>(data);
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

import { WorkflowWorldError } from '@workflow/errors';
import type {
  Event,
  EventResult,
  Hook,
  ListEventsParams,
  ListHooksParams,
  PaginatedResponse,
  ResolveData,
  Step,
  StepWithoutData,
  Storage,
  StructuredError,
  WorkflowRun,
  WorkflowRunWithoutData,
} from '@workflow/world';
import { EventSchema, HookSchema, StepSchema, WorkflowRunSchema } from '@workflow/world';
import { and, desc, eq, gt, lt, notInArray, sql } from 'drizzle-orm';
import { monotonicFactory } from 'ulid';
import { type Drizzle, Schema } from './drizzle/index.js';
import type { SerializedContent } from './drizzle/schema.js';
import { compact } from './util.js';

/**
 * Parse error JSON string into a StructuredError object.
 * Used for backwards compatibility when reading from text error column.
 */
function parseErrorJson(errorJson: string | null): any {
  if (!errorJson) return null;
  try {
    const parsed = JSON.parse(errorJson);
    if (typeof parsed === 'object' && parsed.message !== undefined) {
      return {
        message: parsed.message,
        stack: parsed.stack,
        code: parsed.code,
      };
    }
    // Not a structured error object, treat as plain string
    return { message: String(parsed) };
  } catch {
    // Not JSON, treat as plain string error message
    return { message: errorJson };
  }
}

/**
 * Deserialize run data, handling legacy error fields.
 */
function deserializeRunError(run: any): WorkflowRun {
  const { errorStack, errorCode, ...rest } = run;

  // If no legacy fields, return as-is
  if (!errorStack && !errorCode) {
    return rest as WorkflowRun;
  }

  // Very old legacy: separate errorStack/errorCode fields
  const existingError = rest.error as StructuredError | undefined;
  return {
    ...rest,
    error: {
      message: existingError?.message || '',
      stack: existingError?.stack || errorStack,
      code: existingError?.code || errorCode,
    },
  } as WorkflowRun;
}

/**
 * Deserialize step data, mapping DB columns to interface fields.
 */
function deserializeStepError(step: any): Step {
  const { startedAt, ...rest } = step;

  return {
    ...rest,
    startedAt,
  } as Step;
}

/**
 * Apply CBOR fallback logic for step data.
 * Prefers CBOR columns, falls back to JSON columns for backwards compatibility.
 * Returns `any` because the result is immediately parsed through a Zod schema.
 */
function applyCborFallbackStep(value: any): any {
  if (!value) return value;
  value.output ||= value.outputJson;
  value.input ||= value.inputJson;
  return value;
}

export function createRunsStorage(drizzle: Drizzle): Storage['runs'] {
  const { runs } = Schema;
  const get = drizzle
    .select()
    .from(runs)
    .where(eq(runs.runId, sql.placeholder('id')))
    .limit(1)
    .prepare('workflow_runs_get');

  return {
    get: (async (id, params) => {
      const [value] = await get.execute({ id });
      if (!value) {
        throw new WorkflowWorldError(`Run not found: ${id}`, { status: 404 });
      }
      value.output ||= value.outputJson;
      value.input ||= value.inputJson;
      value.executionContext ||= value.executionContextJson;
      value.error = parseErrorJson(value.error);
      const deserialized = deserializeRunError(compact(value));
      const parsed = WorkflowRunSchema.parse(deserialized);
      const resolveData = params?.resolveData ?? 'all';
      return filterRunData(parsed, resolveData);
    }) as Storage['runs']['get'],
    list: (async (params) => {
      const limit = params?.pagination?.limit ?? 20;
      const fromCursor = params?.pagination?.cursor;

      const all = await drizzle
        .select()
        .from(runs)
        .where(
          and(
            map(fromCursor, (c) => lt(runs.runId, c)),
            map(params?.workflowName, (wf) => eq(runs.workflowName, wf)),
            map(params?.status, (wf) => eq(runs.status, wf)),
          ),
        )
        .orderBy(desc(runs.runId))
        .limit(limit + 1);
      const values = all.slice(0, limit);
      const hasMore = all.length > limit;

      const resolveData = params?.resolveData ?? 'all';
      return {
        data: values.map((v) => {
          v.output ||= v.outputJson;
          v.input ||= v.inputJson;
          v.executionContext ||= v.executionContextJson;
          v.error = parseErrorJson(v.error);
          const deserialized = deserializeRunError(compact(v));
          const parsed = WorkflowRunSchema.parse(deserialized);
          return filterRunData(parsed, resolveData);
        }),
        hasMore,
        cursor: values.at(-1)?.runId ?? null,
      };
    }) as Storage['runs']['list'],
  };
}

function map<T, R>(obj: T | null | undefined, fn: (v: T) => R): undefined | R {
  return obj ? fn(obj) : undefined;
}

export function createEventsStorage(drizzle: Drizzle): Storage['events'] {
  const ulid = monotonicFactory();
  const { events } = Schema;

  // Prepared statements for validation queries
  const getRunForValidation = drizzle
    .select({
      status: Schema.runs.status,
    })
    .from(Schema.runs)
    .where(eq(Schema.runs.runId, sql.placeholder('runId')))
    .limit(1)
    .prepare('events_get_run_for_validation');

  const getStepForValidation = drizzle
    .select({
      status: Schema.steps.status,
      startedAt: Schema.steps.startedAt,
    })
    .from(Schema.steps)
    .where(
      and(
        eq(Schema.steps.runId, sql.placeholder('runId')),
        eq(Schema.steps.stepId, sql.placeholder('stepId')),
      ),
    )
    .limit(1)
    .prepare('events_get_step_for_validation');

  return {
    async create(runId, data, params): Promise<EventResult> {
      const eventId = `wevt_${ulid()}`;

      // For run_created events, generate runId server-side if null or empty
      let effectiveRunId: string;
      if (data.eventType === 'run_created' && (!runId || runId === '')) {
        effectiveRunId = `wrun_${ulid()}`;
      } else if (!runId) {
        throw new Error('runId is required for non-run_created events');
      } else {
        effectiveRunId = runId;
      }

      // Track entity created/updated for EventResult
      let run: WorkflowRun | undefined;
      let step: Step | undefined;
      let hook: Hook | undefined;
      const now = new Date();

      // Helper to check if run is in terminal state
      const isRunTerminal = (status: string) =>
        ['completed', 'failed', 'cancelled'].includes(status);

      // Helper to check if step is in terminal state
      const isStepTerminal = (status: string) => ['completed', 'failed'].includes(status);

      // ============================================================
      // VALIDATION: Terminal state checks
      // ============================================================

      // Get current run state for validation (if not creating a new run)
      // Skip run validation for step_completed and step_retrying
      let currentRun: { status: string } | null = null;
      const skipRunValidationEvents = ['step_completed', 'step_retrying'];
      if (data.eventType !== 'run_created' && !skipRunValidationEvents.includes(data.eventType)) {
        const [runValue] = await getRunForValidation.execute({
          runId: effectiveRunId,
        });
        currentRun = runValue ?? null;
      }

      // Run terminal state validation
      if (currentRun && isRunTerminal(currentRun.status)) {
        const runTerminalEvents = ['run_started', 'run_completed', 'run_failed'];

        // Idempotent operation: run_cancelled on already cancelled run is allowed
        if (data.eventType === 'run_cancelled' && currentRun.status === 'cancelled') {
          // Get full run for return value
          const [fullRun] = await drizzle
            .select()
            .from(Schema.runs)
            .where(eq(Schema.runs.runId, effectiveRunId))
            .limit(1);

          // Create the event (still record it)
          const [value] = await drizzle
            .insert(Schema.events)
            .values({
              runId: effectiveRunId,
              eventId,
              correlationId: data.correlationId,
              eventType: data.eventType,
              eventData: 'eventData' in data ? data.eventData : undefined,
            })
            .returning({ createdAt: Schema.events.createdAt });

          const result = { ...data, ...value, runId: effectiveRunId, eventId };
          const parsed = EventSchema.parse(result);
          const resolveData = params?.resolveData ?? 'all';
          return {
            event: filterEventData(parsed, resolveData),
            run: fullRun
              ? (() => {
                  fullRun.output ||= fullRun.outputJson;
                  fullRun.input ||= fullRun.inputJson;
                  fullRun.executionContext ||= fullRun.executionContextJson;
                  fullRun.error = parseErrorJson(fullRun.error);
                  return deserializeRunError(compact(fullRun));
                })()
              : undefined,
          };
        }

        // Run state transitions are not allowed on terminal runs
        if (runTerminalEvents.includes(data.eventType) || data.eventType === 'run_cancelled') {
          throw new WorkflowWorldError(
            `Cannot transition run from terminal state "${currentRun.status}"`,
            { status: 410 },
          );
        }

        // Creating new entities on terminal runs is not allowed
        if (data.eventType === 'step_created' || data.eventType === 'hook_created') {
          throw new WorkflowWorldError(
            `Cannot create new entities on run in terminal state "${currentRun.status}"`,
            { status: 410 },
          );
        }
      }

      // Step-related event validation
      let validatedStep: { status: string; startedAt: Date | null } | null = null;
      const stepEventsNeedingValidation = ['step_started', 'step_retrying'];
      if (stepEventsNeedingValidation.includes(data.eventType) && data.correlationId) {
        const [existingStep] = await getStepForValidation.execute({
          runId: effectiveRunId,
          stepId: data.correlationId,
        });

        validatedStep = existingStep ?? null;

        if (!validatedStep) {
          throw new WorkflowWorldError(`Step "${data.correlationId}" not found`, { status: 404 });
        }

        if (isStepTerminal(validatedStep.status)) {
          throw new WorkflowWorldError(
            `Cannot modify step in terminal state "${validatedStep.status}"`,
            { status: 410 },
          );
        }

        // On terminal runs: only allow completing/failing in-progress steps
        if (currentRun && isRunTerminal(currentRun.status)) {
          if (validatedStep.status !== 'running') {
            throw new WorkflowWorldError(
              `Cannot modify non-running step on run in terminal state "${currentRun.status}"`,
              { status: 410 },
            );
          }
        }
      }

      // Hook-related event validation (ordering)
      const hookEventsRequiringExistence = ['hook_disposed', 'hook_received'];
      if (hookEventsRequiringExistence.includes(data.eventType) && data.correlationId) {
        const [existingHook] = await drizzle
          .select({ hookId: Schema.hooks.hookId })
          .from(Schema.hooks)
          .where(eq(Schema.hooks.hookId, data.correlationId))
          .limit(1);

        if (!existingHook) {
          throw new WorkflowWorldError(`Hook "${data.correlationId}" not found`, { status: 404 });
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
        const [runValue] = await drizzle
          .insert(Schema.runs)
          .values({
            runId: effectiveRunId,
            deploymentId: eventData.deploymentId,
            workflowName: eventData.workflowName,
            input: eventData.input as SerializedContent,
            executionContext: eventData.executionContext as SerializedContent | undefined,
            status: 'pending',
          })
          .onConflictDoNothing()
          .returning();
        if (runValue) {
          runValue.output ||= runValue.outputJson;
          runValue.input ||= runValue.inputJson;
          runValue.executionContext ||= runValue.executionContextJson;
          runValue.error = parseErrorJson(runValue.error);
          run = deserializeRunError(compact(runValue));
        }
      }

      // Handle run_started event: update run status
      if (data.eventType === 'run_started') {
        const [runValue] = await drizzle
          .update(Schema.runs)
          .set({
            status: 'running',
            startedAt: now,
            updatedAt: now,
          })
          .where(eq(Schema.runs.runId, effectiveRunId))
          .returning();
        if (runValue) {
          runValue.output ||= runValue.outputJson;
          runValue.input ||= runValue.inputJson;
          runValue.executionContext ||= runValue.executionContextJson;
          runValue.error = parseErrorJson(runValue.error);
          run = deserializeRunError(compact(runValue));
        }
      }

      // Handle run_completed event: update run status and cleanup hooks
      if (data.eventType === 'run_completed') {
        const eventData = (data as any).eventData as { output?: any };
        const [runValue] = await drizzle
          .update(Schema.runs)
          .set({
            status: 'completed',
            output: eventData.output as SerializedContent | undefined,
            completedAt: now,
            updatedAt: now,
          })
          .where(eq(Schema.runs.runId, effectiveRunId))
          .returning();
        if (runValue) {
          runValue.output ||= runValue.outputJson;
          runValue.input ||= runValue.inputJson;
          runValue.executionContext ||= runValue.executionContextJson;
          runValue.error = parseErrorJson(runValue.error);
          run = deserializeRunError(compact(runValue));
        }
        // Delete all hooks for this run to allow token reuse
        await drizzle.delete(Schema.hooks).where(eq(Schema.hooks.runId, effectiveRunId));
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
        const errorObj: StructuredError = {
          message: errorMessage,
          stack: eventData.error?.stack,
          code: eventData.errorCode,
        };
        const [runValue] = await drizzle
          .update(Schema.runs)
          .set({
            status: 'failed',
            error: JSON.stringify(errorObj),
            completedAt: now,
            updatedAt: now,
          })
          .where(eq(Schema.runs.runId, effectiveRunId))
          .returning();
        if (runValue) {
          runValue.output ||= runValue.outputJson;
          runValue.input ||= runValue.inputJson;
          runValue.executionContext ||= runValue.executionContextJson;
          runValue.error = parseErrorJson(runValue.error);
          run = deserializeRunError(compact(runValue));
        }
        // Delete all hooks for this run to allow token reuse
        await drizzle.delete(Schema.hooks).where(eq(Schema.hooks.runId, effectiveRunId));
      }

      // Handle run_cancelled event: update run status and cleanup hooks
      if (data.eventType === 'run_cancelled') {
        const [runValue] = await drizzle
          .update(Schema.runs)
          .set({
            status: 'cancelled',
            completedAt: now,
            updatedAt: now,
          })
          .where(eq(Schema.runs.runId, effectiveRunId))
          .returning();
        if (runValue) {
          runValue.output ||= runValue.outputJson;
          runValue.input ||= runValue.inputJson;
          runValue.executionContext ||= runValue.executionContextJson;
          runValue.error = parseErrorJson(runValue.error);
          run = deserializeRunError(compact(runValue));
        }
        // Delete all hooks for this run to allow token reuse
        await drizzle.delete(Schema.hooks).where(eq(Schema.hooks.runId, effectiveRunId));
      }

      // Handle step_created event: create step entity
      if (data.eventType === 'step_created') {
        const eventData = (data as any).eventData as {
          stepName: string;
          input: any;
        };
        const [stepValue] = await drizzle
          .insert(Schema.steps)
          .values({
            runId: effectiveRunId,
            stepId: data.correlationId!,
            stepName: eventData.stepName,
            input: eventData.input as SerializedContent,
            status: 'pending',
            attempt: 0,
          })
          .onConflictDoNothing()
          .returning();
        if (stepValue) {
          applyCborFallbackStep(stepValue);
          stepValue.error = parseErrorJson(stepValue.error);
          step = deserializeStepError(compact(stepValue));
        }
      }

      // Handle step_started event: increment attempt, set status to 'running'
      if (data.eventType === 'step_started') {
        const isFirstStart = !validatedStep?.startedAt;

        const [stepValue] = await drizzle
          .update(Schema.steps)
          .set({
            status: 'running',
            attempt: sql`${Schema.steps.attempt} + 1`,
            ...(isFirstStart ? { startedAt: now } : {}),
          })
          .where(
            and(
              eq(Schema.steps.runId, effectiveRunId),
              eq(Schema.steps.stepId, data.correlationId!),
            ),
          )
          .returning();
        if (stepValue) {
          applyCborFallbackStep(stepValue);
          stepValue.error = parseErrorJson(stepValue.error);
          step = deserializeStepError(compact(stepValue));
        }
      }

      // Handle step_completed event: update step status
      if (data.eventType === 'step_completed') {
        const eventData = (data as any).eventData as { result?: any };
        const [stepValue] = await drizzle
          .update(Schema.steps)
          .set({
            status: 'completed',
            output: eventData.result as SerializedContent | undefined,
            completedAt: now,
          })
          .where(
            and(
              eq(Schema.steps.runId, effectiveRunId),
              eq(Schema.steps.stepId, data.correlationId!),
              notInArray(Schema.steps.status, ['completed', 'failed']),
            ),
          )
          .returning();
        if (stepValue) {
          applyCborFallbackStep(stepValue);
          stepValue.error = parseErrorJson(stepValue.error);
          step = deserializeStepError(compact(stepValue));
        } else {
          const [existing] = await getStepForValidation.execute({
            runId: effectiveRunId,
            stepId: data.correlationId!,
          });
          if (!existing) {
            throw new WorkflowWorldError(`Step "${data.correlationId}" not found`, { status: 404 });
          }
          if (['completed', 'failed'].includes(existing.status)) {
            throw new WorkflowWorldError(
              `Cannot modify step in terminal state "${existing.status}"`,
              { status: 410 },
            );
          }
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

        const [stepValue] = await drizzle
          .update(Schema.steps)
          .set({
            status: 'failed',
            error: JSON.stringify({
              message: errorMessage,
              stack: eventData.stack,
            }),
            completedAt: now,
          })
          .where(
            and(
              eq(Schema.steps.runId, effectiveRunId),
              eq(Schema.steps.stepId, data.correlationId!),
              notInArray(Schema.steps.status, ['completed', 'failed']),
            ),
          )
          .returning();
        if (stepValue) {
          applyCborFallbackStep(stepValue);
          stepValue.error = parseErrorJson(stepValue.error);
          step = deserializeStepError(compact(stepValue));
        } else {
          const [existing] = await getStepForValidation.execute({
            runId: effectiveRunId,
            stepId: data.correlationId!,
          });
          if (!existing) {
            throw new WorkflowWorldError(`Step "${data.correlationId}" not found`, { status: 404 });
          }
          if (['completed', 'failed'].includes(existing.status)) {
            throw new WorkflowWorldError(
              `Cannot modify step in terminal state "${existing.status}"`,
              { status: 410 },
            );
          }
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

        const [stepValue] = await drizzle
          .update(Schema.steps)
          .set({
            status: 'pending',
            error: JSON.stringify({
              message: errorMessage,
              stack: eventData.stack,
            }),
            retryAfter: eventData.retryAfter,
          })
          .where(
            and(
              eq(Schema.steps.runId, effectiveRunId),
              eq(Schema.steps.stepId, data.correlationId!),
            ),
          )
          .returning();
        if (stepValue) {
          applyCborFallbackStep(stepValue);
          stepValue.error = parseErrorJson(stepValue.error);
          step = deserializeStepError(compact(stepValue));
        }
      }

      // Handle hook_created event: create hook entity
      if (data.eventType === 'hook_created') {
        const eventData = (data as any).eventData as {
          token: string;
          metadata?: any;
        };

        // Check for duplicate token
        const [existingHook] = await drizzle
          .select({ hookId: Schema.hooks.hookId })
          .from(Schema.hooks)
          .where(eq(Schema.hooks.token, eventData.token))
          .limit(1);

        if (existingHook) {
          // Create hook_conflict event instead of throwing 409
          const conflictEventData = { token: eventData.token };

          const [conflictValue] = await drizzle
            .insert(events)
            .values({
              runId: effectiveRunId,
              eventId,
              correlationId: data.correlationId,
              eventType: 'hook_conflict',
              eventData: conflictEventData,
            })
            .returning({ createdAt: events.createdAt });

          if (!conflictValue) {
            throw new WorkflowWorldError(`Event ${eventId} could not be created`, { status: 409 });
          }

          const conflictResult = {
            eventType: 'hook_conflict' as const,
            correlationId: data.correlationId,
            eventData: conflictEventData,
            ...conflictValue,
            runId: effectiveRunId,
            eventId,
          };
          const parsedConflict = EventSchema.parse(conflictResult);
          const resolveData = params?.resolveData ?? 'all';
          return {
            event: filterEventData(parsedConflict, resolveData),
            run,
            step,
            hook: undefined,
          };
        }

        const [hookValue] = await drizzle
          .insert(Schema.hooks)
          .values({
            runId: effectiveRunId,
            hookId: data.correlationId!,
            token: eventData.token,
            metadata: eventData.metadata as SerializedContent,
            // Multi-tenancy fields - not yet implemented, using empty strings as placeholders
            ownerId: '',
            projectId: '',
            environment: '',
          })
          .onConflictDoNothing()
          .returning();
        if (hookValue) {
          hookValue.metadata ||= hookValue.metadataJson;
          hook = HookSchema.parse(compact(hookValue));
        }
      }

      // Handle hook_disposed event: delete hook entity
      if (data.eventType === 'hook_disposed' && data.correlationId) {
        await drizzle.delete(Schema.hooks).where(eq(Schema.hooks.hookId, data.correlationId));
      }

      const [value] = await drizzle
        .insert(events)
        .values({
          runId: effectiveRunId,
          eventId,
          correlationId: data.correlationId,
          eventType: data.eventType,
          eventData: 'eventData' in data ? data.eventData : undefined,
        })
        .returning({ createdAt: events.createdAt });
      if (!value) {
        throw new WorkflowWorldError(`Event ${eventId} could not be created`, {
          status: 409,
        });
      }
      const result = { ...data, ...value, runId: effectiveRunId, eventId };
      const parsed = EventSchema.parse(result);
      const resolveData = params?.resolveData ?? 'all';
      return { event: filterEventData(parsed, resolveData), run, step, hook };
    },
    async get(runId, eventId, params) {
      const [value] = await drizzle
        .select()
        .from(events)
        .where(and(eq(events.runId, runId), eq(events.eventId, eventId)))
        .limit(1);
      if (!value) {
        throw new WorkflowWorldError(`Event not found: ${eventId}`, {
          status: 404,
        });
      }
      value.eventData ||= value.eventDataJson;
      const parsed = EventSchema.parse(compact(value));
      const resolveData = params?.resolveData ?? 'all';
      return filterEventData(parsed, resolveData);
    },
    async list(params: ListEventsParams): Promise<PaginatedResponse<Event>> {
      const limit = params?.pagination?.limit ?? 100;
      const sortOrder = params.pagination?.sortOrder || 'asc';
      const order =
        sortOrder === 'desc'
          ? { by: desc(events.eventId), compare: lt }
          : { by: events.eventId, compare: gt };
      const all = await drizzle
        .select()
        .from(events)
        .where(
          and(
            eq(events.runId, params.runId),
            map(params.pagination?.cursor, (c) => order.compare(events.eventId, c)),
          ),
        )
        .orderBy(order.by)
        .limit(limit + 1);

      const values = all.slice(0, limit);

      const resolveData = params?.resolveData ?? 'all';
      return {
        data: values.map((v) => {
          v.eventData ||= v.eventDataJson;
          const parsed = EventSchema.parse(compact(v));
          return filterEventData(parsed, resolveData);
        }),
        cursor: values.at(-1)?.eventId ?? null,
        hasMore: all.length > limit,
      };
    },
    async listByCorrelationId(params) {
      const limit = params?.pagination?.limit ?? 100;
      const sortOrder = params.pagination?.sortOrder || 'asc';
      const order =
        sortOrder === 'desc'
          ? { by: desc(events.eventId), compare: lt }
          : { by: events.eventId, compare: gt };
      const all = await drizzle
        .select()
        .from(events)
        .where(
          and(
            eq(events.correlationId, params.correlationId),
            map(params.pagination?.cursor, (c) => order.compare(events.eventId, c)),
          ),
        )
        .orderBy(order.by)
        .limit(limit + 1);

      const values = all.slice(0, limit);

      const resolveData = params?.resolveData ?? 'all';
      return {
        data: values.map((v) => {
          v.eventData ||= v.eventDataJson;
          const parsed = EventSchema.parse(compact(v));
          return filterEventData(parsed, resolveData);
        }),
        cursor: values.at(-1)?.eventId ?? null,
        hasMore: all.length > limit,
      };
    },
  };
}

export function createHooksStorage(drizzle: Drizzle): Storage['hooks'] {
  const { hooks } = Schema;
  const getByToken = drizzle
    .select()
    .from(hooks)
    .where(eq(hooks.token, sql.placeholder('token')))
    .limit(1)
    .prepare('workflow_hooks_get_by_token');

  return {
    async get(hookId, params) {
      const [value] = await drizzle.select().from(hooks).where(eq(hooks.hookId, hookId)).limit(1);
      value.metadata ||= value.metadataJson;
      const parsed = HookSchema.parse(compact(value));
      const resolveData = params?.resolveData ?? 'all';
      return filterHookData(parsed, resolveData);
    },
    async getByToken(token, params) {
      const [value] = await getByToken.execute({ token });
      if (!value) {
        throw new WorkflowWorldError(`Hook not found for token: ${token}`, {
          status: 404,
        });
      }
      value.metadata ||= value.metadataJson;
      const parsed = HookSchema.parse(compact(value));
      const resolveData = params?.resolveData ?? 'all';
      return filterHookData(parsed, resolveData);
    },
    async list(params: ListHooksParams) {
      const limit = params?.pagination?.limit ?? 100;
      const fromCursor = params?.pagination?.cursor;
      const all = await drizzle
        .select()
        .from(hooks)
        .where(
          and(
            map(params.runId, (id) => eq(hooks.runId, id)),
            map(fromCursor, (c) => lt(hooks.hookId, c)),
          ),
        )
        .orderBy(desc(hooks.hookId))
        .limit(limit + 1);
      const values = all.slice(0, limit);
      const hasMore = all.length > limit;

      const resolveData = params?.resolveData ?? 'all';
      return {
        data: values.map((v) => {
          v.metadata ||= v.metadataJson;
          const parsed = HookSchema.parse(compact(v));
          return filterHookData(parsed, resolveData);
        }),
        cursor: values.at(-1)?.hookId ?? null,
        hasMore,
      };
    },
  };
}

export function createStepsStorage(drizzle: Drizzle): Storage['steps'] {
  const { steps } = Schema;

  return {
    get: (async (runId, stepId, params) => {
      // If runId is not provided, query only by stepId
      const whereClause = runId
        ? and(eq(steps.stepId, stepId), eq(steps.runId, runId))
        : eq(steps.stepId, stepId);

      const [value] = await drizzle.select().from(steps).where(whereClause).limit(1);

      if (!value) {
        throw new WorkflowWorldError(`Step not found: ${stepId}`, {
          status: 404,
        });
      }
      applyCborFallbackStep(value);
      value.error = parseErrorJson(value.error);
      const deserialized = deserializeStepError(compact(value));
      const parsed = StepSchema.parse(deserialized);
      const resolveData = params?.resolveData ?? 'all';
      return filterStepData(parsed, resolveData);
    }) as Storage['steps']['get'],
    list: (async (params) => {
      const limit = params?.pagination?.limit ?? 20;
      const fromCursor = params?.pagination?.cursor;

      const all = await drizzle
        .select()
        .from(steps)
        .where(
          and(
            eq(steps.runId, params.runId),
            map(fromCursor, (c) => lt(steps.stepId, c)),
          ),
        )
        .orderBy(desc(steps.stepId))
        .limit(limit + 1);
      const values = all.slice(0, limit);
      const hasMore = all.length > limit;

      const resolveData = params?.resolveData ?? 'all';
      return {
        data: values.map((v) => {
          applyCborFallbackStep(v);
          v.error = parseErrorJson(v.error);
          const deserialized = deserializeStepError(compact(v));
          const parsed = StepSchema.parse(deserialized);
          return filterStepData(parsed, resolveData);
        }),
        hasMore,
        cursor: values.at(-1)?.stepId ?? null,
      };
    }) as Storage['steps']['list'],
  };
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

function filterHookData(hook: Hook, resolveData: ResolveData): Hook {
  if (resolveData === 'none' && 'metadata' in hook) {
    const { metadata: _, ...rest } = hook;

    return { metadata: undefined, ...rest };
  }
  return hook;
}

function filterEventData(event: Event, resolveData: ResolveData): Event {
  if (resolveData === 'none' && 'eventData' in event) {
    const { eventData: _, ...rest } = event;

    return rest as Event;
  }
  return event;
}

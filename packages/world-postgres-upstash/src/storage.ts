import { WorkflowAPIError } from '@workflow/errors';
import type {
  Event,
  Hook,
  ListEventsParams,
  ListHooksParams,
  PaginatedResponse,
  ResolveData,
  Step,
  Storage,
  UpdateStepRequest,
  UpdateWorkflowRunRequest,
  WorkflowRun,
} from '@workflow/world';
import { HookSchema } from '@workflow/world';
import { and, desc, eq, gt, lt, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { monotonicFactory } from 'ulid';
import type { SerializedContent } from './schema.js';
import * as schema from './schema.js';
import { compact } from './util.js';

// Type for Drizzle client with our schema
type Drizzle = PostgresJsDatabase<typeof schema>;

/**
 * Serialize a StructuredError object into a JSON string
 */
function serializeRunError(data: UpdateWorkflowRunRequest): any {
  if (!data.error) {
    return data;
  }

  const { error, ...rest } = data;
  return {
    ...rest,
    error: JSON.stringify({
      message: error.message,
      stack: error.stack,
      code: error.code,
    }),
  };
}

/**
 * Deserialize error JSON string (or legacy flat fields) into a StructuredError object
 * Handles backwards compatibility:
 * - If error is a JSON string with {message, stack, code} → parse into StructuredError
 * - If error is a plain string → treat as error message
 * - If errorStack/errorCode exist (legacy) → combine into StructuredError
 */
function deserializeRunError(run: any): WorkflowRun {
  const { error, errorStack, errorCode, ...rest } = run;

  if (!error && !errorStack && !errorCode) {
    return run as WorkflowRun;
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
        } as WorkflowRun;
      }
    } catch {
      // Not JSON, treat as plain string
    }
  }

  // Backwards compatibility: handle legacy separate fields or plain string error
  return {
    ...rest,
    error: {
      message: error || '',
      stack: errorStack,
      code: errorCode,
    },
  } as WorkflowRun;
}

/**
 * Serialize a StructuredError object into a JSON string for steps
 */
function serializeStepError(data: UpdateStepRequest): any {
  if (!data.error) {
    return data;
  }

  const { error, ...rest } = data;
  return {
    ...rest,
    error: JSON.stringify({
      message: error.message,
      stack: error.stack,
      code: error.code,
    }),
  };
}

/**
 * Deserialize error JSON string into a StructuredError object for steps
 */
function deserializeStepError(step: any): Step {
  const { error, ...rest } = step;

  if (!error) {
    return step as Step;
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
        } as Step;
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
  } as Step;
}

/**
 * Apply CBOR fallback logic for run data
 * Prefers CBOR columns, falls back to JSON columns for backwards compatibility
 */
function applyCborFallback(value: any): any {
  if (!value) return value;
  value.output ||= value.outputJson;
  value.input ||= value.inputJson;
  value.executionContext ||= value.executionContextJson;
  return value;
}

/**
 * Apply CBOR fallback logic for step data
 * Prefers CBOR columns, falls back to JSON columns for backwards compatibility
 */
function applyCborFallbackStep(value: any): any {
  if (!value) return value;
  value.output ||= value.outputJson;
  value.input ||= value.inputJson;
  return value;
}

/**
 * Apply CBOR fallback logic for event data
 * Prefers CBOR columns, falls back to JSON columns for backwards compatibility
 */
function applyCborFallbackEvent(value: any): any {
  if (!value) return value;
  value.eventData ||= value.eventDataJson;
  return value;
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

export function createRunsStorage(
  drizzle: Drizzle,
  _deploymentId: string
): Storage['runs'] {
  const ulid = monotonicFactory();
  const runs = schema.runs;
  const get = drizzle
    .select()
    .from(runs)
    .where(eq(runs.runId, sql.placeholder('id')))
    .limit(1);

  return {
    async get(id) {
      const [value] = await get.execute({ id });
      if (!value) {
        throw new WorkflowAPIError(`Run not found: ${id}`, { status: 404 });
      }
      return deserializeRunError(compact(applyCborFallback(value)));
    },
    async cancel(id) {
      // Fetch current run to check status
      const [currentRun] = await drizzle
        .select({ status: runs.status })
        .from(runs)
        .where(eq(runs.runId, id))
        .limit(1);

      if (!currentRun) {
        throw new WorkflowAPIError(`Run not found: ${id}`, { status: 404 });
      }

      // Guard: cannot cancel already terminal states
      const terminalStates = ['completed', 'failed', 'cancelled'];
      if (terminalStates.includes(currentRun.status)) {
        throw new WorkflowAPIError(
          `Cannot cancel run in '${currentRun.status}' status`,
          { status: 400 }
        );
      }

      const [value] = await drizzle
        .update(schema.runs)
        .set({ status: 'cancelled', completedAt: sql`now()` })
        .where(eq(runs.runId, id))
        .returning();
      if (!value) {
        throw new WorkflowAPIError(`Run not found: ${id}`, { status: 404 });
      }
      return deserializeRunError(compact(applyCborFallback(value)));
    },
    async pause(id) {
      // Fetch current run to check status
      const [currentRun] = await drizzle
        .select({ status: runs.status })
        .from(runs)
        .where(eq(runs.runId, id))
        .limit(1);

      if (!currentRun) {
        throw new WorkflowAPIError(`Run not found: ${id}`, { status: 404 });
      }

      // Guard: can only pause pending or running runs
      const pausableStates = ['pending', 'running'];
      if (!pausableStates.includes(currentRun.status)) {
        throw new WorkflowAPIError(
          `Cannot pause run in '${currentRun.status}' status`,
          { status: 400 }
        );
      }

      const [value] = await drizzle
        .update(schema.runs)
        .set({ status: 'paused' })
        .where(eq(runs.runId, id))
        .returning();
      if (!value) {
        throw new WorkflowAPIError(`Run not found: ${id}`, { status: 404 });
      }
      return deserializeRunError(compact(applyCborFallback(value)));
    },
    async resume(id) {
      // Fetch current run to check if startedAt is already set
      const [currentRun] = await drizzle
        .select()
        .from(runs)
        .where(eq(runs.runId, id))
        .limit(1);

      if (!currentRun) {
        throw new WorkflowAPIError(`Run not found: ${id}`, { status: 404 });
      }

      const updates: Partial<typeof runs._.inferInsert> = {
        status: 'running',
      };

      // Only set startedAt the first time the run transitions to 'running'
      if (!currentRun.startedAt) {
        updates.startedAt = new Date();
      }

      const [value] = await drizzle
        .update(schema.runs)
        .set(updates)
        .where(and(eq(runs.runId, id), eq(runs.status, 'paused')))
        .returning();
      if (!value) {
        throw new WorkflowAPIError(`Paused run not found: ${id}`, {
          status: 404,
        });
      }
      return deserializeRunError(compact(applyCborFallback(value)));
    },
    async list(params) {
      const limit = params?.pagination?.limit ?? 20;
      const fromCursor = params?.pagination?.cursor;

      const all = await drizzle
        .select()
        .from(runs)
        .where(
          and(
            map(fromCursor, (c) => lt(runs.runId, c)),
            map(params?.workflowName, (wf) => eq(runs.workflowName, wf)),
            map(params?.status, (wf) => eq(runs.status, wf))
          )
        )
        .orderBy(desc(runs.runId))
        .limit(limit + 1);
      const values = all.slice(0, limit);
      const hasMore = all.length > limit;

      return {
        data: values.map((v) =>
          deserializeRunError(compact(applyCborFallback(v)))
        ),
        hasMore,
        cursor: values.at(-1)?.runId ?? null,
      };
    },
    async create(data) {
      const runId = `wrun_${ulid()}`;
      const [value] = await drizzle
        .insert(runs)
        .values({
          runId,
          input: data.input,
          executionContext: data.executionContext as Record<
            string,
            unknown
          > | null,
          deploymentId: data.deploymentId,
          status: 'pending',
          workflowName: data.workflowName,
        })
        .onConflictDoNothing()
        .returning();
      if (!value) {
        // Run already exists - fetch and return it instead of throwing 409
        const [existing] = await drizzle
          .select()
          .from(runs)
          .where(eq(runs.runId, runId))
          .limit(1);
        if (!existing) {
          throw new WorkflowAPIError(`Run ${runId} not found`, {
            status: 404,
          });
        }
        return deserializeRunError(compact(existing));
      }
      return deserializeRunError(compact(applyCborFallback(value)));
    },
    async update(id, data) {
      // Fetch current run to check if startedAt is already set
      const [currentRun] = await drizzle
        .select()
        .from(runs)
        .where(eq(runs.runId, id))
        .limit(1);

      if (!currentRun) {
        throw new WorkflowAPIError(`Run not found: ${id}`, { status: 404 });
      }

      // Serialize the error field if present
      const serialized = serializeRunError(data);

      const updates: Partial<typeof runs._.inferInsert> = {
        ...serialized,
        output: data.output as SerializedContent,
      };

      // Only set startedAt the first time transitioning to 'running'
      if (data.status === 'running' && !currentRun.startedAt) {
        updates.startedAt = new Date();
      }
      if (
        data.status === 'completed' ||
        data.status === 'failed' ||
        data.status === 'cancelled'
      ) {
        updates.completedAt = new Date();
      }

      const [value] = await drizzle
        .update(runs)
        .set(updates)
        .where(eq(runs.runId, id))
        .returning();
      if (!value) {
        throw new WorkflowAPIError(`Run not found: ${id}`, { status: 404 });
      }
      return deserializeRunError(compact(applyCborFallback(value)));
    },
  };
}

function map<T, R>(obj: T | null | undefined, fn: (v: T) => R): undefined | R {
  return obj ? fn(obj) : undefined;
}

export function createEventsStorage(drizzle: Drizzle): Storage['events'] {
  const ulid = monotonicFactory();
  const events = schema.events;

  return {
    async create(runId, data) {
      const eventId = `wevt_${ulid()}`;
      const [value] = await drizzle
        .insert(events)
        .values({
          runId,
          eventId,
          correlationId: data.correlationId,
          eventType: data.eventType,
          eventData: 'eventData' in data ? data.eventData : undefined,
        })
        .returning({ createdAt: events.createdAt });
      if (!value) {
        throw new WorkflowAPIError(`Event ${eventId} could not be created`, {
          status: 409,
        });
      }
      return { ...data, ...value, runId, eventId };
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
            map(params.pagination?.cursor, (c) =>
              order.compare(events.eventId, c)
            )
          )
        )
        .orderBy(order.by)
        .limit(limit + 1);

      const values = all.slice(0, limit);

      return {
        data: values.map((v) => compact(applyCborFallbackEvent(v))) as Event[],
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
            map(params.pagination?.cursor, (c) =>
              order.compare(events.eventId, c)
            )
          )
        )
        .orderBy(order.by)
        .limit(limit + 1);

      const values = all.slice(0, limit);

      return {
        data: values.map((v) => compact(applyCborFallbackEvent(v))) as Event[],
        cursor: values.at(-1)?.eventId ?? null,
        hasMore: all.length > limit,
      };
    },
  };
}

export function createHooksStorage(
  drizzle: Drizzle,
  hookContext: { ownerId: string; projectId: string; environment: string }
): Storage['hooks'] {
  const hooks = schema.hooks;
  const getByToken = drizzle
    .select()
    .from(hooks)
    .where(eq(hooks.token, sql.placeholder('token')))
    .limit(1);

  return {
    async get(hookId, params) {
      const [value] = await drizzle
        .select()
        .from(hooks)
        .where(eq(hooks.hookId, hookId))
        .limit(1);
      value.metadata ||= value.metadataJson;
      const parsed = HookSchema.parse(compact(value));
      const resolveData = params?.resolveData ?? 'all';
      return filterHookData(parsed, resolveData);
    },
    async create(runId, data, params) {
      const [value] = await drizzle
        .insert(hooks)
        .values({
          runId,
          hookId: data.hookId,
          token: data.token,
          ownerId: hookContext.ownerId,
          projectId: hookContext.projectId,
          environment: hookContext.environment,
        })
        .onConflictDoNothing()
        .returning();
      if (!value) {
        // Hook already exists - fetch and return it instead of throwing 409
        const [existing] = await drizzle
          .select()
          .from(hooks)
          .where(eq(hooks.hookId, data.hookId))
          .limit(1);
        if (!existing) {
          throw new WorkflowAPIError(`Hook ${data.hookId} not found`, {
            status: 404,
          });
        }
        existing.metadata ||= existing.metadataJson;
        const parsed = HookSchema.parse(compact(existing));
        const resolveData = params?.resolveData ?? 'all';
        return filterHookData(parsed, resolveData);
      }
      value.metadata ||= value.metadataJson;
      const parsed = HookSchema.parse(compact(value));
      const resolveData = params?.resolveData ?? 'all';
      return filterHookData(parsed, resolveData);
    },
    async getByToken(token, params) {
      const [value] = await getByToken.execute({ token });
      if (!value) {
        throw new WorkflowAPIError(`Hook not found for token: ${token}`, {
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
            map(fromCursor, (c) => lt(hooks.hookId, c))
          )
        )
        .orderBy(desc(hooks.hookId))
        .limit(limit + 1);
      const values = all.slice(0, limit);
      const hasMore = all.length > limit;
      return {
        data: values.map((v) => {
          v.metadata ||= v.metadataJson;
          return HookSchema.parse(compact(v));
        }),
        cursor: values.at(-1)?.hookId ?? null,
        hasMore,
      };
    },
    async dispose(hookId, params) {
      const [value] = await drizzle
        .delete(hooks)
        .where(eq(hooks.hookId, hookId))
        .returning();
      if (!value) {
        throw new WorkflowAPIError(`Hook not found: ${hookId}`, {
          status: 404,
        });
      }
      value.metadata ||= value.metadataJson;
      const parsed = HookSchema.parse(compact(value));
      const resolveData = params?.resolveData ?? 'all';
      return filterHookData(parsed, resolveData);
    },
  };
}

export function createStepsStorage(drizzle: Drizzle): Storage['steps'] {
  const steps = schema.steps;

  return {
    async create(runId, data) {
      const [value] = await drizzle
        .insert(steps)
        .values({
          runId,
          stepId: data.stepId,
          stepName: data.stepName,
          input: data.input as SerializedContent,
          status: 'pending',
          attempt: 1,
        })
        .onConflictDoNothing()
        .returning();
      if (!value) {
        // Step already exists - fetch and return it instead of throwing 409
        // This matches Firestore's behavior and allows the workflow runtime to continue
        const [existing] = await drizzle
          .select()
          .from(steps)
          .where(eq(steps.stepId, data.stepId))
          .limit(1);
        if (!existing) {
          throw new WorkflowAPIError(`Step ${data.stepId} not found`, {
            status: 404,
          });
        }
        return deserializeStepError(compact(applyCborFallbackStep(existing)));
      }
      return deserializeStepError(compact(applyCborFallbackStep(value)));
    },
    async get(runId, stepId) {
      // If runId is not provided, query only by stepId
      const whereClause = runId
        ? and(eq(steps.stepId, stepId), eq(steps.runId, runId))
        : eq(steps.stepId, stepId);

      const [value] = await drizzle
        .select()
        .from(steps)
        .where(whereClause)
        .limit(1);
      if (!value) {
        throw new WorkflowAPIError(`Step not found: ${stepId}`, {
          status: 404,
        });
      }
      return deserializeStepError(compact(applyCborFallbackStep(value)));
    },
    async update(runId, stepId, data) {
      // Fetch current step to check if startedAt is already set
      const [currentStep] = await drizzle
        .select()
        .from(steps)
        .where(and(eq(steps.stepId, stepId), eq(steps.runId, runId)))
        .limit(1);

      if (!currentStep) {
        throw new WorkflowAPIError(`Step not found: ${stepId}`, {
          status: 404,
        });
      }

      // Serialize the error field if present
      const serialized = serializeStepError(data);

      const updates: Partial<typeof steps._.inferInsert> = {
        ...serialized,
        output: data.output as SerializedContent,
      };
      const now = new Date();
      // Only set startedAt the first time the step transitions to 'running'
      if (data.status === 'running' && !currentStep.startedAt) {
        updates.startedAt = now;
      }
      if (data.status === 'completed' || data.status === 'failed') {
        updates.completedAt = now;
      }
      const [value] = await drizzle
        .update(steps)
        .set(updates)
        .where(and(eq(steps.stepId, stepId), eq(steps.runId, runId)))
        .returning();
      if (!value) {
        throw new WorkflowAPIError(`Step not found: ${stepId}`, {
          status: 404,
        });
      }
      return deserializeStepError(compact(applyCborFallbackStep(value)));
    },
    async list(params) {
      const limit = params?.pagination?.limit ?? 20;
      const fromCursor = params?.pagination?.cursor;

      const all = await drizzle
        .select()
        .from(steps)
        .where(
          and(
            eq(steps.runId, params.runId),
            map(fromCursor, (c) => lt(steps.stepId, c))
          )
        )
        .orderBy(desc(steps.stepId))
        .limit(limit + 1);
      const values = all.slice(0, limit);
      const hasMore = all.length > limit;

      return {
        data: values.map((v) =>
          deserializeStepError(compact(applyCborFallbackStep(v)))
        ),
        hasMore,
        cursor: values.at(-1)?.stepId ?? null,
      };
    },
  };
}
export function createStorage(
  drizzle: Drizzle,
  deploymentId: string,
  hookContext: { ownerId: string; projectId: string; environment: string }
): Storage {
  return {
    runs: createRunsStorage(drizzle, deploymentId),
    events: createEventsStorage(drizzle),
    hooks: createHooksStorage(drizzle, hookContext),
    steps: createStepsStorage(drizzle),
  };
}

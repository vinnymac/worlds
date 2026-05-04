import { WorkflowWorldError } from '@workflow/errors';
import type {
  CreateEventParams,
  CreateEventRequest,
  Event,
  EventResult,
  GetEventParams,
  GetHookParams,
  GetStepParams,
  GetWorkflowRunParams,
  Hook,
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
import { EventSchema, HookSchema } from '@workflow/world';
import { monotonicFactory } from 'ulid';
import { compact } from './util.js';

export interface CloudflareStorageConfig {
  env: {
    WORKFLOW_DB: any; // DurableObjectNamespace<WorkflowRunDO> causes circular type reference
    WORKFLOW_INDEX: KVNamespace;
  };
  deploymentId: string;
}

interface KVNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  list(options?: {
    prefix?: string;
    cursor?: string;
    limit?: number;
  }): Promise<{
    keys: Array<{ name: string }>;
    list_complete: boolean;
    cursor?: string;
  }>;
}

interface SerializedError {
  message: string;
  stack?: string;
  code?: string;
}

function isValidStepData(
  data: unknown
): data is Record<string, unknown> & { error?: unknown } {
  return typeof data === 'object' && data !== null;
}

function deserializeStepError(data: unknown): Step {
  if (!isValidStepData(data)) {
    throw new WorkflowWorldError('Invalid step data', { status: 500 });
  }

  if (!data.error) {
    return data as Step;
  }

  const error = data.error as {
    message?: string;
    stack?: string;
    code?: string;
  };
  return {
    ...data,
    error: {
      message: error.message || '',
      stack: error.stack,
      code: error.code,
    },
  } as Step;
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
 * Serialize an error object for storage.
 */
function serializeError(error: unknown): SerializedError | undefined {
  if (!error) return undefined;
  const err = error as { message?: string; stack?: string; code?: string };
  return {
    message: err.message || '',
    stack: err.stack,
    code: err.code,
  };
}

export function createStorage(config: CloudflareStorageConfig): Storage {
  const { env } = config;
  const ulid = monotonicFactory();

  // Helper to get or create a DO for a run
  const getRunDO = (runId: string) => {
    const id = env.WORKFLOW_DB.idFromName(runId);
    return env.WORKFLOW_DB.get(id);
  };

  return {
    runs: {
      async get(runId: string, params?: GetWorkflowRunParams) {
        const stub = getRunDO(runId);
        const run = await stub.getRun();

        if (!run) {
          throw new WorkflowWorldError(`Run not found: ${runId}`, {
            status: 404,
          });
        }

        return filterData(run, params?.resolveData, ['input', 'output']);
      },

      async list(
        params?: ListWorkflowRunsParams
      ): Promise<PaginatedResponse<WorkflowRun | WorkflowRunWithoutData>> {
        const limit = params?.pagination?.limit ?? 20;
        const prefix = params?.workflowName
          ? `run:${params.workflowName}:`
          : 'run:';

        const kvList = await env.WORKFLOW_INDEX.list({
          prefix,
          limit: limit + 1,
          cursor: params?.pagination?.cursor,
        });

        const keys = kvList.keys.slice(0, limit);
        const hasMore = kvList.keys.length > limit;

        const runs = await Promise.all(
          keys.map(async (key) => {
            const meta = await env.WORKFLOW_INDEX.get(key.name);
            if (!meta) return null;
            const { runId } = JSON.parse(meta);
            try {
              return await this.get(runId, {
                resolveData: params?.resolveData,
              });
            } catch {
              return null;
            }
          })
        );

        const filtered = runs.filter((r): r is WorkflowRun => r !== null);

        const statusFiltered = params?.status
          ? filtered.filter((r) => r.status === params.status)
          : filtered;

        return {
          data: statusFiltered,
          cursor: hasMore ? (kvList.cursor ?? null) : null,
          hasMore,
        };
      },
    } as Storage['runs'],

    events: {
      async create(
        runId: string | null,
        data: RunCreatedEventRequest | CreateEventRequest,
        _params?: CreateEventParams
      ): Promise<EventResult> {
        const eventId = `wevt_${ulid()}`;
        const now = new Date();

        // For run_created events, generate a runId if null
        const effectiveRunId =
          runId ?? (data.eventType === 'run_created' ? `wrun_${ulid()}` : '');

        // Build event record - EventSchema requires eventData to be an object
        const eventRecord: Record<string, unknown> = {
          ...data,
          eventData: (data as any).eventData || {}, // EventSchema requires this to be an object, default to {}
          runId: effectiveRunId,
          eventId,
          createdAt: now,
          specVersion: 1, // TODO: Add specVersion tracking
        };

        // Store the event in the DO
        const stub = getRunDO(effectiveRunId);
        await stub.createEvent(eventRecord);

        // Parse and validate using EventSchema
        const event = EventSchema.parse(eventRecord);
        const result: EventResult = { event };

        const eventData = (data as any).eventData;

        switch (data.eventType) {
          case 'run_created': {
            const runData = eventData as RunCreatedEventRequest['eventData'];
            const run = await stub.createRun({
              runId: effectiveRunId,
              workflowName: runData.workflowName,
              input: runData.input,
              executionContext: runData.executionContext as
                | Record<string, unknown>
                | undefined,
              deploymentId: runData.deploymentId,
            });

            // Index for list operations
            await env.WORKFLOW_INDEX.put(
              `run:${runData.workflowName}:${effectiveRunId}`,
              JSON.stringify({
                runId: effectiveRunId,
                createdAt: run.createdAt.toISOString(),
                status: 'pending',
              })
            );

            result.run = run;
            break;
          }
          case 'run_started': {
            const updates: any = {
              status: 'running',
              updatedAt: now,
              startedAt: now,
            };
            if (eventData?.input !== undefined) {
              updates.input = eventData.input;
            }
            if (eventData?.deploymentId !== undefined) {
              updates.deploymentId = eventData.deploymentId;
            }
            result.run = await stub.updateRun(updates);
            break;
          }
          case 'run_completed': {
            const updates: any = {
              status: 'completed',
              updatedAt: now,
              completedAt: now,
            };
            if (eventData?.output !== undefined) {
              updates.output = eventData.output;
            }
            result.run = await stub.updateRun(updates);
            break;
          }
          case 'run_failed': {
            const updates: any = {
              status: 'failed',
              updatedAt: now,
              completedAt: now,
            };
            if (eventData?.error !== undefined) {
              updates.error = serializeError(eventData.error);
            }
            result.run = await stub.updateRun(updates);
            break;
          }
          case 'run_cancelled': {
            result.run = await stub.cancelRun({
              updatedAt: now,
            });
            break;
          }
          case 'step_created': {
            const correlationId = (data as any).correlationId;
            const stepNow = new Date();
            const step: Step = {
              runId: effectiveRunId,
              stepId: correlationId,
              stepName: eventData.stepName,
              status: 'pending',
              input: eventData.input,
              output: undefined,
              error: undefined,
              attempt: 1,
              createdAt: stepNow,
              updatedAt: stepNow,
              startedAt: undefined,
              completedAt: undefined,
              retryAfter: undefined,
            };
            await stub.createStep(step);
            result.step = step;
            break;
          }
          case 'step_started': {
            const correlationId = (data as any).correlationId;
            const updates: any = {
              status: 'running',
              updatedAt: now,
              startedAt: now,
            };
            if (eventData?.attempt !== undefined) {
              updates.attempt = eventData.attempt;
            }
            await stub.updateStep(correlationId, updates);
            const stepData = await stub.getStep(correlationId);
            result.step = deserializeStepError({
              ...stepData,
              createdAt: new Date(stepData.createdAt),
              updatedAt: new Date(stepData.updatedAt),
              startedAt: stepData.startedAt
                ? new Date(stepData.startedAt)
                : undefined,
              completedAt: stepData.completedAt
                ? new Date(stepData.completedAt)
                : undefined,
              retryAfter: stepData.retryAfter
                ? new Date(stepData.retryAfter)
                : undefined,
            });
            break;
          }
          case 'step_completed': {
            const correlationId = (data as any).correlationId;
            const updates: any = {
              status: 'completed',
              updatedAt: now,
              completedAt: now,
            };
            if (eventData?.result !== undefined) {
              updates.output = eventData.result;
            }
            await stub.updateStep(correlationId, updates);
            const stepData = await stub.getStep(correlationId);
            result.step = deserializeStepError({
              ...stepData,
              createdAt: new Date(stepData.createdAt),
              updatedAt: new Date(stepData.updatedAt),
              startedAt: stepData.startedAt
                ? new Date(stepData.startedAt)
                : undefined,
              completedAt: stepData.completedAt
                ? new Date(stepData.completedAt)
                : undefined,
              retryAfter: stepData.retryAfter
                ? new Date(stepData.retryAfter)
                : undefined,
            });
            break;
          }
          case 'step_failed': {
            const correlationId = (data as any).correlationId;
            const updates: any = {
              status: 'failed',
              updatedAt: now,
              completedAt: now,
            };
            if (eventData?.error !== undefined) {
              updates.error = serializeError(eventData.error);
            }
            await stub.updateStep(correlationId, updates);
            const stepData = await stub.getStep(correlationId);
            result.step = deserializeStepError({
              ...stepData,
              createdAt: new Date(stepData.createdAt),
              updatedAt: new Date(stepData.updatedAt),
              startedAt: stepData.startedAt
                ? new Date(stepData.startedAt)
                : undefined,
              completedAt: stepData.completedAt
                ? new Date(stepData.completedAt)
                : undefined,
              retryAfter: stepData.retryAfter
                ? new Date(stepData.retryAfter)
                : undefined,
            });
            break;
          }
          case 'step_retrying': {
            const correlationId = (data as any).correlationId;
            const currentStep = await stub.getStep(correlationId);
            const updates: any = {
              status: 'pending',
              updatedAt: now,
              attempt: ((currentStep?.attempt || 1) as number) + 1,
            };
            if (eventData?.error !== undefined) {
              updates.error = serializeError(eventData.error);
            }
            if (eventData?.retryAfter !== undefined) {
              updates.retryAfter = new Date(eventData.retryAfter as string);
            }
            await stub.updateStep(correlationId, updates);
            const stepData = await stub.getStep(correlationId);
            result.step = deserializeStepError({
              ...stepData,
              createdAt: new Date(stepData.createdAt),
              updatedAt: new Date(stepData.updatedAt),
              startedAt: stepData.startedAt
                ? new Date(stepData.startedAt)
                : undefined,
              completedAt: stepData.completedAt
                ? new Date(stepData.completedAt)
                : undefined,
              retryAfter: stepData.retryAfter
                ? new Date(stepData.retryAfter)
                : undefined,
            });
            break;
          }
          case 'hook_created': {
            const correlationId = (data as any).correlationId;
            const hookNow = new Date();

            const hook = {
              runId: effectiveRunId,
              hookId: correlationId,
              token: eventData.token,
              ownerId: '',
              projectId: '',
              environment: '',
              createdAt: hookNow,
              metadata: eventData.metadata,
            };

            await stub.createHook(hook);

            // Index by token for lookup
            await env.WORKFLOW_INDEX.put(
              `hook:${eventData.token}`,
              JSON.stringify(hook)
            );

            result.hook = HookSchema.parse(compact(hook));
            break;
          }
          // hook_received, hook_disposed, hook_conflict, wait_created, wait_completed
          // are event-only; no entity mutation needed at the storage level
        }

        return result;
      },

      async get(
        runId: string,
        eventId: string,
        _params?: GetEventParams
      ): Promise<Event> {
        const stub = getRunDO(runId);
        const result = await stub.listEvents({
          limit: 1000,
          sortOrder: 'asc',
        });

        const event = result.data.find((e: Event) => e.eventId === eventId);
        if (!event) {
          throw new WorkflowWorldError(`Event not found: ${eventId}`, {
            status: 404,
          });
        }

        return {
          ...event,
          createdAt: new Date(event.createdAt),
        };
      },

      async list(params: ListEventsParams): Promise<PaginatedResponse<Event>> {
        const { runId } = params;
        const limit = params?.pagination?.limit ?? 100;

        const stub = getRunDO(runId);
        const result = await stub.listEvents({
          limit,
          cursor: params?.pagination?.cursor || undefined,
          sortOrder: params.pagination?.sortOrder || 'asc',
        });

        return {
          data: result.data.map((e: Event) => ({
            ...e,
            createdAt: new Date(e.createdAt),
          })),
          cursor: result.cursor ?? null,
          hasMore: result.hasMore ?? false,
        };
      },

      async listByCorrelationId(_params) {
        // For Cloudflare, we'd need a global index in KV or D1
        // For now, return empty as this requires cross-DO coordination
        return {
          data: [],
          cursor: null,
          hasMore: false,
        };
      },
    },

    steps: {
      async get(
        runId: string | undefined,
        stepId: string,
        params?: GetStepParams
      ) {
        if (!runId) {
          throw new WorkflowWorldError(
            'runId is required for Cloudflare step lookup',
            { status: 400 }
          );
        }
        const stub = getRunDO(runId);
        const data = await stub.getStep(stepId);

        if (!data) {
          throw new WorkflowWorldError(`Step not found: ${stepId}`, {
            status: 404,
          });
        }

        const step = deserializeStepError({
          ...data,
          createdAt: new Date(data.createdAt),
          updatedAt: new Date(data.updatedAt),
          startedAt: data.startedAt ? new Date(data.startedAt) : undefined,
          completedAt: data.completedAt
            ? new Date(data.completedAt)
            : undefined,
          retryAfter: data.retryAfter ? new Date(data.retryAfter) : undefined,
        });

        return filterData(step, params?.resolveData, ['input', 'output']);
      },

      async list(
        params: ListWorkflowRunStepsParams
      ): Promise<PaginatedResponse<Step | StepWithoutData>> {
        const { runId } = params;
        const limit = params?.pagination?.limit ?? 20;

        const stub = getRunDO(runId);
        const result = await stub.listSteps({
          limit,
          cursor: params?.pagination?.cursor || undefined,
        });

        return {
          data: result.data.map((s: Step) => {
            const step = deserializeStepError({
              ...s,
              createdAt: new Date(s.createdAt),
              updatedAt: new Date(s.updatedAt),
              startedAt: s.startedAt ? new Date(s.startedAt) : undefined,
              completedAt: s.completedAt ? new Date(s.completedAt) : undefined,
              retryAfter: s.retryAfter ? new Date(s.retryAfter) : undefined,
            });
            return filterData(step, params?.resolveData, ['input', 'output']);
          }),
          cursor: result.cursor ?? null,
          hasMore: result.hasMore ?? false,
        };
      },
    } as Storage['steps'],

    hooks: {
      async get(_hookId: string, _params?: GetHookParams) {
        throw new WorkflowWorldError(
          'Hook lookup by ID not implemented for Cloudflare',
          {
            status: 501,
          }
        );
      },

      async getByToken(token: string, params?: GetHookParams) {
        const data = await env.WORKFLOW_INDEX.get(`hook:${token}`);

        if (!data) {
          throw new WorkflowWorldError(`Hook not found for token: ${token}`, {
            status: 404,
          });
        }

        const hook = JSON.parse(data);
        const parsed = HookSchema.parse({
          ...hook,
          createdAt: new Date(hook.createdAt),
        });
        const resolveData = params?.resolveData ?? 'all';
        return filterHookData(parsed, resolveData);
      },

      async list(params: ListHooksParams): Promise<PaginatedResponse<Hook>> {
        if (!params.runId) {
          throw new WorkflowWorldError('runId is required for listing hooks', {
            status: 400,
          });
        }
        const runId = params.runId;
        const limit = params?.pagination?.limit ?? 100;

        const stub = getRunDO(runId);
        const result: { data: Hook[]; cursor: null; hasMore: false } =
          await stub.listHooks({
            limit,
            cursor: params?.pagination?.cursor || undefined,
          });

        return {
          data: result.data.map((h: Hook) => {
            const parsed = HookSchema.parse({
              ...h,
              createdAt: new Date(h.createdAt),
            });
            return filterHookData(parsed, params?.resolveData ?? 'all');
          }),
          cursor: result.cursor ?? null,
          hasMore: result.hasMore ?? false,
        };
      },
    },
  };
}

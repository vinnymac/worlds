import { WorkflowAPIError } from '@workflow/errors';
import type {
  CreateHookRequest,
  CreateStepRequest,
  Event,
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
  Step,
  Storage,
  UpdateStepRequest,
  UpdateWorkflowRunRequest,
  WorkflowRun,
} from '@workflow/world';
import { HookSchema } from '@workflow/world';
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

type SerializedWorkflowRunUpdate = Omit<UpdateWorkflowRunRequest, 'error'> & {
  error?: SerializedError;
};

type SerializedStepUpdate = Omit<UpdateStepRequest, 'error'> & {
  error?: SerializedError;
};

function serializeRunError(
  data: UpdateWorkflowRunRequest
): SerializedWorkflowRunUpdate {
  if (!data.error) {
    return data;
  }

  const { error, ...rest } = data;
  return {
    ...rest,
    error: {
      message: error.message,
      stack: error.stack,
      code: error.code,
    },
  };
}

function isValidRunData(
  data: unknown
): data is Record<string, unknown> & { error?: unknown } {
  return typeof data === 'object' && data !== null;
}

function _deserializeRunError(data: unknown): WorkflowRun {
  if (!isValidRunData(data)) {
    throw new WorkflowAPIError('Invalid run data', { status: 500 });
  }

  if (!data.error) {
    return data as WorkflowRun;
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
  } as WorkflowRun;
}

function serializeStepError(data: UpdateStepRequest): SerializedStepUpdate {
  if (!data.error) {
    return data;
  }

  const { error, ...rest } = data;
  return {
    ...rest,
    error: {
      message: error.message,
      stack: error.stack,
      code: error.code,
    },
  };
}

function isValidStepData(
  data: unknown
): data is Record<string, unknown> & { error?: unknown } {
  return typeof data === 'object' && data !== null;
}

function deserializeStepError(data: unknown): Step {
  if (!isValidStepData(data)) {
    throw new WorkflowAPIError('Invalid step data', { status: 500 });
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
      async create(data) {
        const runId = `wrun_${ulid()}`;

        const stub = getRunDO(runId);
        const run = await stub.createRun({
          runId,
          workflowName: data.workflowName,
          input: data.input,
          executionContext: data.executionContext as
            | Record<string, unknown>
            | undefined,
          deploymentId: data.deploymentId,
        });

        // Index for list operations
        await env.WORKFLOW_INDEX.put(
          `run:${data.workflowName}:${runId}`,
          JSON.stringify({
            runId,
            createdAt: run.createdAt.toISOString(),
            status: 'pending',
          })
        );

        return run;
      },

      async get(runId: string, params?: GetWorkflowRunParams) {
        const stub = getRunDO(runId);
        const run = await stub.getRun();

        if (!run) {
          throw new WorkflowAPIError(`Run not found: ${runId}`, {
            status: 404,
          });
        }

        return filterData(run, params?.resolveData, ['input', 'output']);
      },

      async cancel(runId: string) {
        const stub = getRunDO(runId);
        return await stub.cancelRun({});
      },

      async pause(runId: string) {
        const stub = getRunDO(runId);
        return await stub.pauseRun({});
      },

      async resume(runId: string) {
        const stub = getRunDO(runId);
        const now = new Date();
        return await stub.resumeRun({ updatedAt: now });
      },

      async update(runId: string, data: UpdateWorkflowRunRequest) {
        const stub = getRunDO(runId);
        const now = new Date();

        const serialized = serializeRunError(data);
        const updates: any = { ...serialized, updatedAt: now };

        // Set startedAt when transitioning to 'running' (if not already in data)
        if (data.status === 'running' && !(serialized as any).startedAt) {
          updates.startedAt = now;
        }

        // Set completedAt when transitioning to terminal states (if not already in data)
        if (
          (data.status === 'completed' ||
            data.status === 'failed' ||
            data.status === 'cancelled') &&
          !(serialized as any).completedAt
        ) {
          updates.completedAt = now;
        }

        return await stub.updateRun(updates);
      },

      async list(
        params: ListWorkflowRunsParams
      ): Promise<PaginatedResponse<WorkflowRun>> {
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
    },

    events: {
      async create(runId: string, data) {
        const eventId = `wevt_${ulid()}`;
        const now = new Date();

        const eventData = {
          ...data,
          runId,
          eventId,
          createdAt: now,
        };

        const stub = getRunDO(runId);
        await stub.createEvent(eventData);

        return eventData;
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
      async create(runId: string, data: CreateStepRequest) {
        const now = new Date();

        const step: Step = {
          runId,
          stepId: data.stepId,
          stepName: data.stepName,
          status: 'pending',
          input: data.input,
          output: undefined,
          error: undefined,
          attempt: 1,
          createdAt: now,
          updatedAt: now,
          startedAt: undefined,
          completedAt: undefined,
          retryAfter: undefined,
        };

        const stub = getRunDO(runId);
        await stub.createStep(step);

        return step;
      },

      async get(runId: string, stepId: string, params?: GetStepParams) {
        const stub = getRunDO(runId);
        const data = await stub.getStep(stepId);

        if (!data) {
          throw new WorkflowAPIError(`Step not found: ${stepId}`, {
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

      async update(runId: string, stepId: string, data: UpdateStepRequest) {
        const stub = getRunDO(runId);
        const now = new Date();

        const serialized = serializeStepError(data);
        const updates: any = { ...serialized, updatedAt: now };

        // Set startedAt when transitioning to 'running' (if not already in data)
        if (data.status === 'running' && !(serialized as any).startedAt) {
          updates.startedAt = now;
        }

        // Set completedAt when transitioning to terminal states (if not already in data)
        if (
          (data.status === 'completed' || data.status === 'failed') &&
          !(serialized as any).completedAt
        ) {
          updates.completedAt = now;
        }

        await stub.updateStep(stepId, updates);

        return this.get(runId, stepId);
      },

      async list(
        params: ListWorkflowRunStepsParams
      ): Promise<PaginatedResponse<Step>> {
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
    },

    hooks: {
      async create(
        runId: string,
        data: CreateHookRequest,
        params?: GetHookParams
      ) {
        const now = new Date();

        const hook = {
          runId,
          hookId: data.hookId,
          token: data.token,
          ownerId: '',
          projectId: '',
          environment: '',
          createdAt: now,
          metadata: data.metadata,
        };

        const stub = getRunDO(runId);
        await stub.createHook(hook);

        // Index by token for lookup
        await env.WORKFLOW_INDEX.put(
          `hook:${data.token}`,
          JSON.stringify(hook)
        );

        const parsed = HookSchema.parse(compact(hook));
        const resolveData = params?.resolveData ?? 'all';
        return filterHookData(parsed, resolveData);
      },

      async get(_hookId: string, _params?: GetHookParams) {
        throw new WorkflowAPIError(
          'Hook lookup by ID not implemented for Cloudflare',
          {
            status: 501,
          }
        );
      },

      async getByToken(token: string, params?: GetHookParams) {
        const data = await env.WORKFLOW_INDEX.get(`hook:${token}`);

        if (!data) {
          throw new WorkflowAPIError(`Hook not found for token: ${token}`, {
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
          throw new WorkflowAPIError('runId is required for listing hooks', {
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

      async dispose(_hookId: string, _params?: GetHookParams) {
        throw new WorkflowAPIError(
          'Hook disposal by ID not implemented for Cloudflare',
          {
            status: 501,
          }
        );
      },
    },
  };
}

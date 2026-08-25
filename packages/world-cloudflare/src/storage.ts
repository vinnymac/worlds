import {
  EntityConflictError,
  HookNotFoundError,
  PreconditionFailedError,
  RunExpiredError,
  RunNotSupportedError,
  TooEarlyError,
  WorkflowRunNotFoundError,
  WorkflowWorldError,
} from '@workflow/errors';
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
  SPEC_VERSION_CURRENT,
  StepSchema,
  WorkflowRunSchema,
} from '@workflow/world';
import { parse, stringify } from '@fantasticfour/shared';
import { monotonicFactory } from 'ulid';
import type { ApplyEventFailure, ApplyEventOutcome, ApplyEventRequest } from './apply-event.js';
import { compact } from './util.js';

/**
 * RPC surface of WorkflowRunDO used by the storage layer. Declared
 * structurally to avoid a circular type reference on the DO class.
 */
export interface WorkflowRunDOStub {
  applyEvent(request: ApplyEventRequest): Promise<ApplyEventOutcome>;
  getRun(): Promise<WorkflowRun | null>;
  getStep(stepId: string): Promise<Step | null>;
  getEvent(eventId: string): Promise<Event | null>;
  listEvents(params?: {
    limit?: number;
    cursor?: string;
    sortOrder?: 'asc' | 'desc';
  }): Promise<{ data: Event[]; cursor: string | null; hasMore: boolean }>;
  listSteps(params?: {
    limit?: number;
    cursor?: string;
  }): Promise<{ data: Step[]; cursor: string | null; hasMore: boolean }>;
  listHooks(params?: {
    limit?: number;
    cursor?: string;
  }): Promise<{ data: Hook[]; cursor: string | null; hasMore: boolean }>;
}

export interface WorkflowRunDONamespace {
  idFromName(name: string): DurableObjectIdLike;
  get(id: DurableObjectIdLike): WorkflowRunDOStub;
}

export interface DurableObjectIdLike {
  toString(): string;
}

export interface CloudflareStorageConfig {
  env: {
    WORKFLOW_DB: WorkflowRunDONamespace;
    WORKFLOW_INDEX: KVNamespace;
  };
  deploymentId: string;
  /** Per-run event ceiling reported as `EventResult.maxEvents`. Defaults to
   * `WORKFLOW_MAX_EVENTS` or {@link DEFAULT_MAX_EVENTS_PER_RUN}. */
  maxEventsPerRun?: number;
}

/** Default per-run event ceiling. Mirrors `@workflow/world-local`. */
const DEFAULT_MAX_EVENTS_PER_RUN = 25_000;

/** Minimum page size when scanning a run's log for correlationId matches.
 * Matches are sparse, so scanning in `limit`-sized pages would cost a DO round
 * trip per few matches for small limits. */
const CORRELATION_SCAN_PAGE_SIZE = 100;

/** Resolve the per-run event ceiling: explicit config, then
 * `WORKFLOW_MAX_EVENTS`, then the default. An explicit value must be a
 * positive integer. */
function resolveMaxEventsPerRun(configured: number | undefined): number {
  if (configured !== undefined) {
    if (!Number.isInteger(configured) || configured <= 0) {
      throw new WorkflowWorldError(
        `maxEventsPerRun must be a positive integer, received ${configured}`,
        { status: 500 },
      );
    }
    return configured;
  }
  const raw = process.env.WORKFLOW_MAX_EVENTS;
  const parsed = raw !== undefined ? Number(raw) : Number.NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_EVENTS_PER_RUN;
}

interface KVNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  list(options?: { prefix?: string; cursor?: string; limit?: number }): Promise<{
    keys: Array<{ name: string }>;
    list_complete: boolean;
    cursor?: string;
  }>;
}

/**
 * Filter data based on ResolveData parameter.
 * When resolveData is 'none', strips specified keys to reduce data transfer.
 */
function filterData<T extends object>(
  data: T,
  resolveData: ResolveData | undefined,
  keysToStrip: (keyof T)[],
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
 * Convert a structured applyEvent failure back into the typed error the
 * runtime matches on (via error-name based `.is()` checks). Typed errors
 * cannot cross the DO RPC boundary intact, which is why the DO returns
 * outcome objects instead of throwing.
 */
function throwOutcomeError(
  outcome: ApplyEventFailure,
  runId: string,
  data: CreateEventRequest | RunCreatedEventRequest,
): never {
  switch (outcome.code) {
    case 'RUN_NOT_FOUND':
      throw new WorkflowRunNotFoundError(runId);
    case 'STEP_NOT_FOUND':
      throw new WorkflowWorldError(outcome.message, { status: 404 });
    case 'HOOK_NOT_FOUND':
      throw new HookNotFoundError(data.correlationId ?? runId);
    case 'ENTITY_CONFLICT':
      throw new EntityConflictError(outcome.message);
    case 'RUN_EXPIRED':
      throw new RunExpiredError(outcome.message);
    case 'TOO_EARLY':
      throw new TooEarlyError(outcome.message, { retryAfter: outcome.retryAfterSeconds });
    case 'PRECONDITION_FAILED':
      throw new PreconditionFailedError(outcome.message);
    case 'RUN_NOT_SUPPORTED':
      throw new RunNotSupportedError(outcome.runSpecVersion ?? 0, SPEC_VERSION_CURRENT);
    case 'LEGACY_RUN_NOT_SUPPORTED':
      throw new WorkflowWorldError(outcome.message, { status: 422 });
  }
}

export function createStorage(config: CloudflareStorageConfig): Storage {
  const { env } = config;
  const ulid = monotonicFactory();
  const maxEventsPerRun = resolveMaxEventsPerRun(config.maxEventsPerRun);

  // Helper to get or create a DO for a run
  const getRunDO = (runId: string): WorkflowRunDOStub => {
    const id = env.WORKFLOW_DB.idFromName(runId);
    return env.WORKFLOW_DB.get(id);
  };

  const parseRun = (run: WorkflowRun): WorkflowRun => WorkflowRunSchema.parse(compact(run));
  const parseStep = (step: Step): Step => StepSchema.parse(compact(step));
  const parseHook = (hook: Hook): Hook => HookSchema.parse(compact(hook));
  const parseEvent = (event: Event): Event => EventSchema.parse(compact(event));

  const runsGet = async (
    runId: string,
    params?: GetWorkflowRunParams,
  ): Promise<WorkflowRun | WorkflowRunWithoutData> => {
    const stub = getRunDO(runId);
    const run = await stub.getRun();

    if (!run) {
      throw new WorkflowRunNotFoundError(runId);
    }

    return filterData(parseRun(run), params?.resolveData, ['input', 'output']);
  };

  return {
    runs: {
      get: runsGet,

      async list(
        params?: ListWorkflowRunsParams,
      ): Promise<PaginatedResponse<WorkflowRun | WorkflowRunWithoutData>> {
        const limit = params?.pagination?.limit ?? 20;
        const prefix = params?.workflowName ? `run:${params.workflowName}:` : 'run:';

        // Exact limit + list_complete: fetching limit+1 would advance the KV
        // cursor past the peeked key and silently drop one run per page.
        const kvList = await env.WORKFLOW_INDEX.list({
          prefix,
          limit,
          cursor: params?.pagination?.cursor,
        });

        const hasMore = !kvList.list_complete;

        const runs = await Promise.all(
          kvList.keys.map(async (key) => {
            // The index key is `run:<workflowName>:<runId>` and a runId never
            // contains a colon, so the id is already in hand. Reading the
            // entry back just to parse the same id out of its JSON cost one
            // KV read per run on every page.
            const runId = key.name.slice(key.name.lastIndexOf(':') + 1);
            if (!runId) return null;
            try {
              return await runsGet(runId, { resolveData: params?.resolveData });
            } catch (error) {
              // An index entry whose run row never landed (partial create) is
              // skippable; anything else is a real failure.
              if (WorkflowRunNotFoundError.is(error)) return null;
              throw error;
            }
          }),
        );

        const filtered = runs.filter((r): r is WorkflowRun => r !== null);

        // Status filtering is best-effort within a page: it is applied after
        // KV pagination, so a page may return fewer than `limit` matches
        // while hasMore is still true.
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
        params?: CreateEventParams,
      ): Promise<EventResult> {
        // For run_created events, generate a runId server-side if absent.
        let effectiveRunId: string;
        if (data.eventType === 'run_created' && (!runId || runId === '')) {
          effectiveRunId = `wrun_${ulid()}`;
        } else if (!runId) {
          throw new WorkflowWorldError('runId is required for non-run_created events', {
            status: 400,
          });
        } else {
          effectiveRunId = runId;
        }

        const stub = getRunDO(effectiveRunId);

        // hook_created needs to know who currently holds the token in the
        // global index. The check-then-write across KV and the DO is not
        // atomic (KV has no compare-and-swap); the DO-side hook_created event
        // marker keeps same-run replays exactly-once, while cross-run token
        // races remain best-effort, matching KV's consistency model.
        let tokenHolder: ApplyEventRequest['tokenHolder'];
        if (data.eventType === 'hook_created') {
          const raw = await env.WORKFLOW_INDEX.get(`hook:${data.eventData.token}`);
          if (raw) {
            const holder = parse<Hook>(raw);
            tokenHolder = { runId: holder.runId, hookId: holder.hookId };
          } else {
            tokenHolder = null;
          }
        }

        // Guards, event append, and entity mutation run in ONE DO storage
        // transaction (see apply-event.ts). The event is schema-validated
        // before anything is persisted. `stateUpdatedAt` rides along so the
        // optimistic-concurrency check is atomic with the append.
        const outcome = await stub.applyEvent({
          runId: effectiveRunId,
          data,
          tokenHolder,
          stateUpdatedAt: params?.stateUpdatedAt,
        });

        if (!outcome.ok) {
          throwOutcomeError(outcome, effectiveRunId, data);
        }

        // KV side effects happen after the DO transaction committed; the DO
        // event log is the source of truth and can re-derive these. They are
        // independent of each other, so they go out together rather than as a
        // chain of awaits — a run with N hooks was paying 2N serial KV
        // round trips on its terminal event.
        const kvWrites: Promise<unknown>[] = [];
        if (outcome.runCreated) {
          kvWrites.push(
            env.WORKFLOW_INDEX.put(
              `run:${outcome.runCreated.workflowName}:${effectiveRunId}`,
              JSON.stringify({
                runId: effectiveRunId,
                createdAt: outcome.runCreated.createdAt.toISOString(),
                status: 'pending',
              }),
            ),
          );
        }
        if (outcome.hookToIndex) {
          const serialized = stringify(outcome.hookToIndex);
          kvWrites.push(
            env.WORKFLOW_INDEX.put(`hook:${outcome.hookToIndex.token}`, serialized),
            env.WORKFLOW_INDEX.put(`hookid:${outcome.hookToIndex.hookId}`, serialized),
          );
        }
        for (const released of outcome.releasedHooks) {
          kvWrites.push(
            env.WORKFLOW_INDEX.delete(`hook:${released.token}`),
            env.WORKFLOW_INDEX.delete(`hookid:${released.hookId}`),
          );
        }
        if (kvWrites.length > 0) {
          await Promise.all(kvWrites);
        }

        return {
          event: outcome.event,
          run: outcome.run,
          step: outcome.step,
          hook: outcome.hook,
          events: outcome.events,
          // The runtime reads the ceiling from the run_started response only,
          // so it must also be present on the idempotent already-running
          // replay path -- keying off the request type covers both.
          ...(data.eventType === 'run_started' && outcome.run
            ? { maxEvents: maxEventsPerRun }
            : {}),
        };
      },

      async get(runId: string, eventId: string, _params?: GetEventParams): Promise<Event> {
        const stub = getRunDO(runId);
        const event = await stub.getEvent(eventId);

        if (!event) {
          throw new WorkflowWorldError(`Event not found: ${eventId}`, {
            status: 404,
          });
        }

        return parseEvent(event);
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
          data: result.data.map(parseEvent),
          cursor: result.cursor,
          hasMore: result.hasMore,
        };
      },

      async listByCorrelationId(
        params: ListEventsByCorrelationIdParams,
      ): Promise<PaginatedResponse<Event>> {
        const { correlationId, runId } = params;
        if (!runId) {
          // No global correlationId index exists: events live in per-run DOs,
          // so an unscoped lookup would have to fan out over every run.
          throw new WorkflowWorldError(
            'Unscoped correlationId lookup is not supported on the Cloudflare world; pass runId to scope the lookup to a single run',
            { status: 400 },
          );
        }

        const limit = params.pagination?.limit ?? 100;
        const sortOrder = params.pagination?.sortOrder || 'asc';
        const stub = getRunDO(runId);

        // Page the run's log until `limit + 1` matches are in hand. Filtering
        // after a `limit` slice would make hasMore and the cursor describe the
        // unfiltered log, silently dropping matches at page boundaries.
        const matches: Event[] = [];
        let cursor = params.pagination?.cursor || undefined;
        for (;;) {
          const page = await stub.listEvents({
            limit: Math.max(limit, CORRELATION_SCAN_PAGE_SIZE),
            cursor,
            sortOrder,
          });
          for (const event of page.data) {
            if (event.correlationId === correlationId) matches.push(event);
          }
          // listByPrefix only yields a cursor while more entries remain.
          if (matches.length > limit || !page.hasMore || page.cursor === null) break;
          cursor = page.cursor;
        }

        const data = matches.slice(0, limit);
        const hasMore = matches.length > limit;

        return {
          data: data.map(parseEvent),
          cursor: hasMore ? (data.at(-1)?.eventId ?? null) : null,
          hasMore,
        };
      },
    },

    steps: {
      async get(runId: string | undefined, stepId: string, params?: GetStepParams) {
        if (!runId) {
          throw new WorkflowWorldError('runId is required for Cloudflare step lookup', {
            status: 400,
          });
        }
        const stub = getRunDO(runId);
        const step = await stub.getStep(stepId);

        if (!step) {
          throw new WorkflowWorldError(`Step not found: ${stepId}`, {
            status: 404,
          });
        }

        return filterData(parseStep(step), params?.resolveData, ['input', 'output']);
      },

      async list(
        params: ListWorkflowRunStepsParams,
      ): Promise<PaginatedResponse<Step | StepWithoutData>> {
        const { runId } = params;
        const limit = params?.pagination?.limit ?? 20;

        const stub = getRunDO(runId);
        const result = await stub.listSteps({
          limit,
          cursor: params?.pagination?.cursor || undefined,
        });

        return {
          data: result.data.map((s) =>
            filterData(parseStep(s), params?.resolveData, ['input', 'output']),
          ),
          cursor: result.cursor,
          hasMore: result.hasMore,
        };
      },
    } as Storage['steps'],

    hooks: {
      async get(hookId: string, params?: GetHookParams) {
        const raw = await env.WORKFLOW_INDEX.get(`hookid:${hookId}`);

        if (!raw) {
          throw new HookNotFoundError(hookId);
        }

        const hook = parseHook(parse<Hook>(raw));
        return filterHookData(hook, params?.resolveData ?? 'all');
      },

      async getByToken(token: string, params?: GetHookParams) {
        const raw = await env.WORKFLOW_INDEX.get(`hook:${token}`);

        if (!raw) {
          throw new HookNotFoundError(token);
        }

        const hook = parseHook(parse<Hook>(raw));
        return filterHookData(hook, params?.resolveData ?? 'all');
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
        const result = await stub.listHooks({
          limit,
          cursor: params?.pagination?.cursor || undefined,
        });

        return {
          data: result.data.map((h) => filterHookData(parseHook(h), params?.resolveData ?? 'all')),
          cursor: result.cursor,
          hasMore: result.hasMore,
        };
      },
    },
  };
}

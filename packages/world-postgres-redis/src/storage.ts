import {
  EntityConflictError,
  HookNotFoundError,
  PreconditionFailedError,
  RunExpiredError,
  TooEarlyError,
  WorkflowRunNotFoundError,
  WorkflowWorldError,
} from '@workflow/errors';
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
import {
  EventSchema,
  HookSchema,
  SPEC_VERSION_CURRENT,
  StepSchema,
  stripEventDataRefs,
  WorkflowRunSchema,
} from '@workflow/world';
import { and, desc, eq, gt, lt, notInArray, sql } from 'drizzle-orm';
import { decodeTime, monotonicFactory } from 'ulid';
import { type Drizzle, Schema } from './drizzle/index.js';
import type { SerializedContent } from './drizzle/schema.js';
import { compact } from './util.js';

// A drizzle client or an open transaction on one; lets the state-marker
// helpers run inside the guarded event-insert transaction as well as standalone.
type DrizzleOrTx = Drizzle | Parameters<Parameters<Drizzle['transaction']>[0]>[0];

/** Per-run event ceiling reported on `run_started`. The runtime fails the run
 * with `MAX_EVENTS_EXCEEDED` once the replay log reaches it. */
const DEFAULT_MAX_EVENTS_PER_RUN = 25_000;

export interface EventsStorageOptions {
  /** Per-run event ceiling returned as `EventResult.maxEvents`. Defaults to
   * `WORKFLOW_MAX_EVENTS` when positive, else {@link DEFAULT_MAX_EVENTS_PER_RUN}. */
  maxEventsPerRun?: number;
}

function resolveMaxEventsPerRun(configured: number | undefined): number {
  if (configured !== undefined) {
    if (!Number.isInteger(configured) || configured <= 0) {
      throw new TypeError(
        `maxEventsPerRun must be a positive integer, received ${String(configured)}`,
      );
    }
    return configured;
  }
  // Env is an operator escape hatch, so it fails open to the default rather
  // than crashing a deployment over a malformed value.
  const raw = process.env.WORKFLOW_MAX_EVENTS;
  const parsed = raw !== undefined ? Number(raw) : Number.NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_EVENTS_PER_RUN;
}

/** Event types that advance the `state_updated_at` marker when created
 * without a `stateUpdatedAt`. Excludes `run_created` / `run_started` /
 * `run_failed`, which core also omits it on. */
const EXTERNAL_STATE_EVENT_TYPES: readonly string[] = ['hook_received', 'step_completed'];

/** Epoch ms encoded in a `wevt_<ulid>` id. The client strips at the last `_`. */
function eventIdTime(eventId: string): number {
  return decodeTime(eventId.slice(eventId.lastIndexOf('_') + 1));
}

/** Unlocked fail-fast marker check, ahead of the authoritative locked check
 * in {@link lockRunState}. Rejects only strictly-older snapshots; an absent
 * marker or `stateUpdatedAt` fails open. */
async function assertStateNotStale(
  db: DrizzleOrTx,
  runId: string,
  stateUpdatedAt: number | undefined,
): Promise<void> {
  if (stateUpdatedAt === undefined) return;
  const [row] = await db
    .select({ stateUpdatedAt: Schema.runs.stateUpdatedAt })
    .from(Schema.runs)
    .where(eq(Schema.runs.runId, runId))
    .limit(1);
  const marker = row?.stateUpdatedAt;
  if (marker != null && stateUpdatedAt < marker) {
    throw new PreconditionFailedError(
      `Workflow run "${runId}" advanced past the caller's snapshot (stateUpdatedAt ${stateUpdatedAt} < ${marker})`,
    );
  }
}

/** Locks the run row so the marker check and the event insert are one
 * serializable unit, before the event ULID is allocated so ids stay
 * commit-ordered. Returns whether the caller must advance the marker. */
async function lockRunState(
  tx: DrizzleOrTx,
  runId: string,
  eventType: string,
  stateUpdatedAt: number | undefined,
): Promise<boolean> {
  const guarded = stateUpdatedAt !== undefined;
  const advances = !guarded && EXTERNAL_STATE_EVENT_TYPES.includes(eventType);
  if (!guarded && !advances) return false;

  const [row] = await tx
    .select({ stateUpdatedAt: Schema.runs.stateUpdatedAt })
    .from(Schema.runs)
    .where(eq(Schema.runs.runId, runId))
    .limit(1)
    .for('update');

  if (guarded) {
    const marker = row?.stateUpdatedAt;
    if (marker != null && stateUpdatedAt < marker) {
      throw new PreconditionFailedError(
        `Workflow run "${runId}" advanced past the caller's snapshot (stateUpdatedAt ${stateUpdatedAt} < ${marker})`,
      );
    }
  }
  return advances;
}

/** Advance the run's state marker to the ULID time of the event just written.
 * `GREATEST` keeps it monotonic without a read-modify-write. */
async function advanceStateMarker(db: DrizzleOrTx, runId: string, eventId: string): Promise<void> {
  const marker = eventIdTime(eventId);
  await db
    .update(Schema.runs)
    .set({ stateUpdatedAt: sql`GREATEST(COALESCE(${Schema.runs.stateUpdatedAt}, 0), ${marker})` })
    .where(eq(Schema.runs.runId, runId));
}

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
  // stateUpdatedAt is our internal optimistic-concurrency marker column, not a
  // WorkflowRun field; drop it here so it never leaks onto a returned entity.
  const { errorStack, errorCode, stateUpdatedAt: _stateUpdatedAt, ...rest } = run;

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
        throw new WorkflowRunNotFoundError(id);
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

export function createEventsStorage(
  drizzle: Drizzle,
  options: EventsStorageOptions = {},
): Storage['events'] {
  const ulid = monotonicFactory();
  const maxEvents = resolveMaxEventsPerRun(options.maxEventsPerRun);
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
      retryAfter: Schema.steps.retryAfter,
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

  const getHookByToken = drizzle
    .select({ hookId: Schema.hooks.hookId, runId: Schema.hooks.runId })
    .from(Schema.hooks)
    .where(eq(Schema.hooks.token, sql.placeholder('token')))
    .limit(1)
    .prepare('events_get_hook_by_token');

  // Used to distinguish a real same-hook duplicate from an orphaned hook row
  // left behind by an interruption between the hook INSERT and the events
  // INSERT (see the recovery logic in the hook_created branch).
  const getHookCreatedEvent = drizzle
    .select({ eventId: events.eventId })
    .from(events)
    .where(
      and(
        eq(events.runId, sql.placeholder('runId')),
        eq(events.correlationId, sql.placeholder('correlationId')),
        eq(events.eventType, sql.placeholder('eventType')),
      ),
    )
    .limit(1)
    .prepare('events_get_hook_created_for_run_correlation');

  return {
    async create(runId, data, params): Promise<EventResult> {
      // The event id is allocated lazily so entity writes that insert their
      // own preceding events (e.g. the run_started bootstrap's synthetic
      // run_created) always sort before this event in ULID order.
      let eventId: string | undefined;
      const getEventId = () => (eventId ??= `wevt_${ulid()}`);

      // For run_created events, generate runId server-side if null or empty
      let effectiveRunId: string;
      if (data.eventType === 'run_created' && (!runId || runId === '')) {
        effectiveRunId = `wrun_${ulid()}`;
      } else if (!runId) {
        throw new Error('runId is required for non-run_created events');
      } else {
        effectiveRunId = runId;
      }

      // specVersion is always sent by the runtime, but we provide a fallback for safety
      const effectiveSpecVersion = data.specVersion ?? SPEC_VERSION_CURRENT;

      // Guard pass 1 of 2. Unlocked, so purely fail-fast: rejects a stale
      // replay-origin create before any entity write. Pass 2 is authoritative.
      await assertStateNotStale(drizzle, effectiveRunId, params?.stateUpdatedAt);

      // Track entity created/updated for EventResult
      let run: WorkflowRun | undefined;
      let step: Step | undefined;
      let hook: Hook | undefined;
      const now = new Date();

      // Helper to check if run is in terminal state
      const isRunTerminal = (status: string) =>
        ['completed', 'failed', 'cancelled'].includes(status);

      // Helper to check if step is in terminal state
      const isStepTerminal = (status: string) =>
        ['completed', 'failed', 'cancelled'].includes(status);

      // Terminal statuses for use in SQL WHERE clauses (atomic TOCTOU guards)
      const terminalRunStatuses: ('completed' | 'failed' | 'cancelled')[] = [
        'completed',
        'failed',
        'cancelled',
      ];
      const terminalStepStatuses: ('completed' | 'failed' | 'cancelled')[] = [
        'completed',
        'failed',
        'cancelled',
      ];

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
        const { deploymentId, workflowName } = runInputData;
        if (deploymentId && workflowName && runInputData.input !== undefined) {
          // Create run + synthetic run_created event atomically so we never
          // leave an orphaned run without its run_created event. The event id
          // is allocated here (before getEventId()) so run_created sorts
          // before the run_started event in ULID order.
          const runValue = await drizzle.transaction(async (tx) => {
            const [inserted] = await tx
              .insert(Schema.runs)
              .values({
                runId: effectiveRunId,
                deploymentId,
                workflowName,
                input: runInputData.input as SerializedContent,
                executionContext: runInputData.executionContext as SerializedContent | undefined,
                status: 'pending',
                specVersion: effectiveSpecVersion,
              })
              .onConflictDoNothing()
              .returning();
            if (inserted) {
              const runCreatedEventId = `wevt_${ulid()}`;
              await tx.insert(events).values({
                runId: effectiveRunId,
                eventId: runCreatedEventId,
                eventType: 'run_created',
                eventData: {
                  deploymentId: runInputData.deploymentId,
                  workflowName: runInputData.workflowName,
                  input: runInputData.input,
                  executionContext: runInputData.executionContext,
                },
                specVersion: effectiveSpecVersion,
              });
            }
            return inserted;
          });
          if (runValue) {
            currentRun = { status: 'pending' };
          } else {
            // Run already exists (concurrent run_created won the race):
            // re-read so downstream logic sees the real state.
            const [existingRun] = await getRunForValidation.execute({ runId: effectiveRunId });
            currentRun = existingRun ?? null;
          }
        }
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
              eventId: getEventId(),
              correlationId: data.correlationId,
              eventType: data.eventType,
              eventData: 'eventData' in data ? data.eventData : undefined,
              occurredAt: params?.occurredAt,
              specVersion: effectiveSpecVersion,
            })
            .returning({
              createdAt: Schema.events.createdAt,
              occurredAt: Schema.events.occurredAt,
            });

          const result = {
            ...data,
            ...compact(value),
            runId: effectiveRunId,
            eventId: getEventId(),
          };
          const parsed = EventSchema.parse(result);
          const resolveData = params?.resolveData ?? 'all';
          return {
            event: stripEventDataRefs(parsed, resolveData),
            run: fullRun
              ? (() => {
                  fullRun.output ||= fullRun.outputJson;
                  fullRun.input ||= fullRun.inputJson;
                  fullRun.executionContext ||= fullRun.executionContextJson;
                  fullRun.error = parseErrorJson(fullRun.error);
                  return deserializeRunError(compact(fullRun));
                })()
              : undefined,
            ...(fullRun ? { maxEvents } : {}),
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

      // Step-related event validation
      let validatedStep: {
        status: string;
        startedAt: Date | null;
        retryAfter: Date | null;
      } | null = null;
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
          throw new EntityConflictError(
            `Cannot modify step in terminal state "${validatedStep.status}"`,
          );
        }

        // On terminal runs: only allow completing/failing in-progress steps
        if (currentRun && isRunTerminal(currentRun.status)) {
          if (validatedStep.status !== 'running') {
            throw new RunExpiredError(
              `Cannot modify non-running step on run in terminal state "${currentRun.status}"`,
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
          throw new HookNotFoundError(data.correlationId);
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
            specVersion: effectiveSpecVersion,
          })
          .onConflictDoNothing()
          .returning();
        if (!runValue) {
          // Duplicate run_created: onConflictDoNothing().returning() yields
          // no row when the run already exists. Reject with the runtime's
          // dedup signal instead of returning the existing run and appending
          // a second run_created row via the shared event insert below. Core
          // treats this 409 as benign ("the run already exists").
          throw new EntityConflictError(`Workflow run "${effectiveRunId}" already exists`);
        }
        runValue.output ||= runValue.outputJson;
        runValue.input ||= runValue.inputJson;
        runValue.executionContext ||= runValue.executionContextJson;
        runValue.error = parseErrorJson(runValue.error);
        run = deserializeRunError(compact(runValue));
      }

      // Handle run_started event: update run status
      if (data.eventType === 'run_started') {
        // Idempotency: if run is already past pending, this is a replay.
        // Return existing run state without creating a duplicate event.
        if (currentRun?.status === 'running') {
          const [existingRun] = await drizzle
            .select()
            .from(Schema.runs)
            .where(eq(Schema.runs.runId, effectiveRunId))
            .limit(1);
          if (existingRun) {
            existingRun.output ||= existingRun.outputJson;
            existingRun.input ||= existingRun.inputJson;
            existingRun.executionContext ||= existingRun.executionContextJson;
            existingRun.error = parseErrorJson(existingRun.error);
            run = deserializeRunError(compact(existingRun));
          }
          const resolveData = params?.resolveData ?? 'all';
          // Core reads maxEvents only off the run_started response, so the
          // idempotent replay path must carry it too or the ceiling silently
          // disappears on every replay after the first.
          return {
            run: run ? (filterRunData(run, resolveData) as WorkflowRun) : undefined,
            ...(run ? { maxEvents } : {}),
          };
        }

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
      // Uses conditional UPDATE to prevent completing an already-terminal run.
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
          .where(
            and(
              eq(Schema.runs.runId, effectiveRunId),
              notInArray(Schema.runs.status, terminalRunStatuses),
            ),
          )
          .returning();
        if (runValue) {
          runValue.output ||= runValue.outputJson;
          runValue.input ||= runValue.inputJson;
          runValue.executionContext ||= runValue.executionContextJson;
          runValue.error = parseErrorJson(runValue.error);
          run = deserializeRunError(compact(runValue));
        } else {
          const [existing] = await getRunForValidation.execute({ runId: effectiveRunId });
          if (!existing) {
            throw new WorkflowRunNotFoundError(effectiveRunId);
          }
          if (isRunTerminal(existing.status)) {
            throw new EntityConflictError(
              `Cannot transition run from terminal state "${existing.status}"`,
            );
          }
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
          .where(
            and(
              eq(Schema.runs.runId, effectiveRunId),
              notInArray(Schema.runs.status, terminalRunStatuses),
            ),
          )
          .returning();
        if (runValue) {
          runValue.output ||= runValue.outputJson;
          runValue.input ||= runValue.inputJson;
          runValue.executionContext ||= runValue.executionContextJson;
          runValue.error = parseErrorJson(runValue.error);
          run = deserializeRunError(compact(runValue));
        } else {
          const [existing] = await getRunForValidation.execute({ runId: effectiveRunId });
          if (!existing) {
            throw new WorkflowRunNotFoundError(effectiveRunId);
          }
          if (isRunTerminal(existing.status)) {
            throw new EntityConflictError(
              `Cannot transition run from terminal state "${existing.status}"`,
            );
          }
        }
        // Delete all hooks for this run to allow token reuse
        await drizzle.delete(Schema.hooks).where(eq(Schema.hooks.runId, effectiveRunId));
      }

      // Handle run_cancelled event: update run status and cleanup hooks.
      // Uses conditional UPDATE to prevent cancelling an already-terminal run
      // (idempotent cancel on an already-cancelled run returns earlier).
      // output/error are explicitly cleared so the WorkflowRunSchema
      // discriminated union ('cancelled' carries neither) always parses,
      // even if a racing terminal write landed first under an older build.
      if (data.eventType === 'run_cancelled') {
        const [runValue] = await drizzle
          .update(Schema.runs)
          .set({
            status: 'cancelled',
            output: null,
            outputJson: null,
            error: null,
            completedAt: now,
            updatedAt: now,
          })
          .where(
            and(
              eq(Schema.runs.runId, effectiveRunId),
              notInArray(Schema.runs.status, terminalRunStatuses),
            ),
          )
          .returning();
        if (runValue) {
          runValue.output ||= runValue.outputJson;
          runValue.input ||= runValue.inputJson;
          runValue.executionContext ||= runValue.executionContextJson;
          runValue.error = parseErrorJson(runValue.error);
          run = deserializeRunError(compact(runValue));
        } else {
          const [existing] = await getRunForValidation.execute({ runId: effectiveRunId });
          if (!existing) {
            throw new WorkflowRunNotFoundError(effectiveRunId);
          }
          if (isRunTerminal(existing.status)) {
            throw new EntityConflictError(
              `Cannot transition run from terminal state "${existing.status}"`,
            );
          }
        }
        // Delete all hooks for this run to allow token reuse
        await drizzle.delete(Schema.hooks).where(eq(Schema.hooks.runId, effectiveRunId));
      }

      // Strip eventData from run_started; it belongs on run_created only.
      const storedEventData =
        data.eventType === 'run_started'
          ? undefined
          : 'eventData' in data
            ? data.eventData
            : undefined;

      // Populated by the step_started transaction below (which writes its own
      // event log entry in the same transaction as the guarded step UPDATE);
      // the shared insert further down is skipped when this is already set.
      let value: { createdAt: Date; occurredAt: Date | null } | undefined;

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
            specVersion: effectiveSpecVersion,
          })
          .onConflictDoNothing()
          .returning();
        if (stepValue) {
          applyCborFallbackStep(stepValue);
          stepValue.error = parseErrorJson(stepValue.error);
          step = deserializeStepError(compact(stepValue));
        } else {
          // Event replay: fetch existing step
          const [existingStep] = await drizzle
            .select()
            .from(Schema.steps)
            .where(
              and(
                eq(Schema.steps.runId, effectiveRunId),
                eq(Schema.steps.stepId, data.correlationId!),
              ),
            )
            .limit(1);
          if (existingStep) {
            applyCborFallbackStep(existingStep);
            existingStep.error = parseErrorJson(existingStep.error);
            step = deserializeStepError(compact(existingStep));
          }
        }
      }

      // Handle step_started event: increment attempt and set the step to
      // running, then write the matching event log entry in the same
      // transaction. The guarded UPDATE takes the step row lock; keeping the
      // event INSERT behind that lock prevents a late step_started from being
      // ordered after a concurrent terminal event that already won the row.
      if (data.eventType === 'step_started') {
        value = await drizzle.transaction(async (tx) => {
          // Guard pass 2 of 2 for this insert path. Taken before the step row lock so
          // every guarded transaction acquires the run row first. step_started is never
          // externally originated, so it never advances the marker.
          await lockRunState(tx, effectiveRunId, data.eventType, params?.stateUpdatedAt);

          // Retried steps may be scheduled for later. Keep this check inside
          // the transaction so the step_started write cannot slip past it.
          if (validatedStep?.retryAfter && validatedStep.retryAfter.getTime() > Date.now()) {
            throw new TooEarlyError(
              `Cannot start step "${data.correlationId}": retryAfter timestamp has not been reached yet`,
              {
                retryAfter: Math.ceil((validatedStep.retryAfter.getTime() - Date.now()) / 1000),
              },
            );
          }

          // The terminal-state guard is part of the UPDATE, not just the
          // earlier validation read. That closes the race where another
          // writer completes/fails the step between validation and start.
          const [stepValue] = await tx
            .update(Schema.steps)
            .set({
              status: 'running',
              attempt: sql`${Schema.steps.attempt} + 1`,
              // Only set startedAt on first start; use COALESCE so concurrent
              // step_started calls can't clobber the original timestamp.
              startedAt: sql`COALESCE(${Schema.steps.startedAt}, ${now.toISOString()})`,
              // Always clear retryAfter now that the step has started
              retryAfter: null,
            })
            .where(
              and(
                eq(Schema.steps.runId, effectiveRunId),
                eq(Schema.steps.stepId, data.correlationId!),
                notInArray(Schema.steps.status, terminalStepStatuses),
              ),
            )
            .returning();
          if (stepValue) {
            applyCborFallbackStep(stepValue);
            stepValue.error = parseErrorJson(stepValue.error);
            step = deserializeStepError(compact(stepValue));
          } else {
            // Step not updated: check if it exists and why
            const [existing] = await tx
              .select({ status: Schema.steps.status })
              .from(Schema.steps)
              .where(
                and(
                  eq(Schema.steps.runId, effectiveRunId),
                  eq(Schema.steps.stepId, data.correlationId!),
                ),
              )
              .limit(1);
            if (!existing) {
              throw new WorkflowWorldError(`Step "${data.correlationId}" not found`, {
                status: 404,
              });
            }
            if (isStepTerminal(existing.status)) {
              throw new EntityConflictError(
                `Cannot modify step in terminal state "${existing.status}"`,
              );
            }
          }

          // Allocate the step_started ULID only after the guarded step UPDATE
          // has acquired and passed the row lock, so a writer blocked on the
          // step row cannot carry an older event id into a later insert.
          const [eventValue] = await tx
            .insert(events)
            .values({
              runId: effectiveRunId,
              eventId: getEventId(),
              correlationId: data.correlationId,
              eventType: data.eventType,
              eventData: storedEventData,
              occurredAt: params?.occurredAt,
              specVersion: effectiveSpecVersion,
            })
            .returning({ createdAt: events.createdAt, occurredAt: events.occurredAt });
          if (!eventValue) {
            throw new EntityConflictError(`Event ${getEventId()} could not be created`);
          }
          return eventValue;
        });
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
              notInArray(Schema.steps.status, terminalStepStatuses),
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
          if (isStepTerminal(existing.status)) {
            throw new EntityConflictError(
              `Cannot modify step in terminal state "${existing.status}"`,
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
              notInArray(Schema.steps.status, terminalStepStatuses),
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
          if (isStepTerminal(existing.status)) {
            throw new EntityConflictError(
              `Cannot modify step in terminal state "${existing.status}"`,
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
              notInArray(Schema.steps.status, terminalStepStatuses),
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
          if (isStepTerminal(existing.status)) {
            throw new EntityConflictError(
              `Cannot modify step in terminal state "${existing.status}"`,
            );
          }
        }
      }

      // Handle hook_created event: create hook entity
      if (data.eventType === 'hook_created') {
        const eventData = (data as any).eventData as {
          token: string;
          metadata?: any;
          isWebhook?: boolean;
        };

        // Emits a hook_conflict event (instead of throwing 409) so the
        // workflow continues and fails gracefully when the hook is awaited.
        const emitHookConflict = async (conflictingRunId: string): Promise<EventResult> => {
          const conflictEventData = { token: eventData.token, conflictingRunId };

          const [conflictValue] = await drizzle
            .insert(events)
            .values({
              runId: effectiveRunId,
              eventId: getEventId(),
              correlationId: data.correlationId,
              eventType: 'hook_conflict',
              eventData: conflictEventData,
              occurredAt: params?.occurredAt,
              specVersion: effectiveSpecVersion,
            })
            .returning({ createdAt: events.createdAt, occurredAt: events.occurredAt });

          if (!conflictValue) {
            throw new EntityConflictError(`Event ${getEventId()} could not be created`);
          }

          const conflictResult = {
            eventType: 'hook_conflict' as const,
            correlationId: data.correlationId,
            eventData: conflictEventData,
            ...compact(conflictValue),
            runId: effectiveRunId,
            eventId: getEventId(),
          };
          const parsedConflict = EventSchema.parse(conflictResult);
          const resolveData = params?.resolveData ?? 'all';
          return {
            event: stripEventDataRefs(parsedConflict, resolveData),
            run,
            step,
            hook: undefined,
            ...(run ? { maxEvents } : {}),
          };
        };

        // Recovers an orphaned hook row (hook INSERT landed but the events
        // INSERT didn't) so the EventResult carries the persisted entity.
        const recoverOrphanedHook = async (): Promise<void> => {
          const [recoveredHookValue] = await drizzle
            .select()
            .from(Schema.hooks)
            .where(eq(Schema.hooks.hookId, data.correlationId!))
            .limit(1);
          if (recoveredHookValue) {
            recoveredHookValue.metadata ||= recoveredHookValue.metadataJson;
            hook = HookSchema.parse(compact(recoveredHookValue));
          }
        };

        // Check for duplicate token
        const [existingHook] = await getHookByToken.execute({ token: eventData.token });

        if (existingHook) {
          // Idempotency: if the existing hook is the *same* (runId, hookId) we
          // are trying to create, this is either a duplicate / replayed
          // delivery of the same hook_created (not a real conflict), or an
          // orphaned hook row from a prior crashed attempt. Distinguish by
          // checking whether the hook_created event exists in the log:
          //   - exists -> real duplicate: throw EntityConflictError so the
          //     runtime's concurrent-replay catch path swallows it, instead of
          //     producing a self-conflict that would later replay as
          //     HookTokenConflictError (vercel/workflow#2283).
          //   - missing -> orphaned hook row: skip the insert and fall through
          //     to the events INSERT below, completing the partial write.
          if (existingHook.runId === effectiveRunId && existingHook.hookId === data.correlationId) {
            const [existingEvent] = await getHookCreatedEvent.execute({
              runId: effectiveRunId,
              correlationId: data.correlationId,
              eventType: 'hook_created',
            });
            if (existingEvent) {
              throw new EntityConflictError(`Hook "${data.correlationId}" already created`);
            }
            await recoverOrphanedHook();
          } else {
            // Cross-run conflict: a different (runId, hookId) holds this token.
            return emitHookConflict(existingHook.runId);
          }
        } else {
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
              specVersion: effectiveSpecVersion,
              isWebhook: eventData.isWebhook,
            })
            .onConflictDoNothing()
            .returning();
          if (hookValue) {
            hookValue.metadata ||= hookValue.metadataJson;
            hook = HookSchema.parse(compact(hookValue));
          } else {
            // Lost a race: a concurrent hook_created inserted between our
            // token check and this INSERT (unique token index or hookId PK).
            // Re-read by token and route to the same paths as above.
            const [racedHook] = await getHookByToken.execute({ token: eventData.token });
            if (
              racedHook &&
              !(racedHook.runId === effectiveRunId && racedHook.hookId === data.correlationId)
            ) {
              return emitHookConflict(racedHook.runId);
            }
            await recoverOrphanedHook();
          }
        }
      }

      // Handle hook_disposed event: delete hook entity atomically.
      // Uses DELETE ... RETURNING so only one concurrent caller succeeds;
      // if no rows are returned, the hook was already disposed.
      if (data.eventType === 'hook_disposed' && data.correlationId) {
        const [deleted] = await drizzle
          .delete(Schema.hooks)
          .where(eq(Schema.hooks.hookId, data.correlationId))
          .returning({ hookId: Schema.hooks.hookId });
        if (!deleted) {
          throw new EntityConflictError(`Hook "${data.correlationId}" already disposed`);
        }
      }

      if (!value) {
        // Guard pass 2 of 2, plus the marker advance for externally-originated
        // events. Both contend on the run row, so check and write are atomic.
        try {
          value = await drizzle.transaction(async (tx) => {
            const advancesStateMarker = await lockRunState(
              tx,
              effectiveRunId,
              data.eventType,
              params?.stateUpdatedAt,
            );

            const [inserted] = await tx
              .insert(events)
              .values({
                runId: effectiveRunId,
                eventId: getEventId(),
                correlationId: data.correlationId,
                eventType: data.eventType,
                eventData: storedEventData,
                occurredAt: params?.occurredAt,
                specVersion: effectiveSpecVersion,
              })
              .returning({ createdAt: events.createdAt, occurredAt: events.occurredAt });

            if (advancesStateMarker) {
              await advanceStateMarker(tx, effectiveRunId, getEventId());
            }

            return inserted;
          });
        } catch (err) {
          // Translate a unique violation on the entity-creation index into
          // EntityConflictError so the runtime's dedup path handles a redelivered
          // create. Gated on the constraint name so other 23505s propagate raw.
          const isEntityCreatingEvent =
            data.eventType === 'step_created' ||
            data.eventType === 'hook_created' ||
            data.eventType === 'wait_created';
          const pgErr = (err as { code?: string }).code
            ? (err as { code?: string; constraint_name?: string })
            : ((err as { cause?: { code?: string; constraint_name?: string } }).cause ?? {});
          const pgConstraint =
            (pgErr as { constraint_name?: string; constraint?: string }).constraint_name ??
            (pgErr as { constraint?: string }).constraint;
          if (
            isEntityCreatingEvent &&
            pgErr.code === '23505' &&
            pgConstraint === 'workflow_events_entity_creation_unique'
          ) {
            throw new EntityConflictError(
              `${data.eventType} for correlationId "${data.correlationId}" already exists in run "${effectiveRunId}"`,
            );
          }
          throw err;
        }
      }
      if (!value) {
        throw new EntityConflictError(`Event ${getEventId()} could not be created`);
      }
      const result = { ...data, ...compact(value), runId: effectiveRunId, eventId: getEventId() };
      if (data.eventType === 'run_started') {
        delete (result as any).eventData;
      }
      const parsed = EventSchema.parse(result);
      const resolveData = params?.resolveData ?? 'all';

      // Preload all events for run_started to reduce TTFB
      let allEvents: Event[] | undefined;
      if (data.eventType === 'run_started' && run) {
        const eventRows = await drizzle
          .select()
          .from(events)
          .where(eq(events.runId, effectiveRunId))
          .orderBy(events.eventId);
        allEvents = eventRows.map((e) => {
          e.eventData ||= e.eventDataJson;
          const p = EventSchema.parse(compact(e));
          return stripEventDataRefs(p, resolveData);
        });
      }

      return {
        event: stripEventDataRefs(parsed, resolveData),
        run,
        step,
        hook,
        events: allEvents,
        ...(run ? { maxEvents } : {}),
      };
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
      return stripEventDataRefs(parsed, resolveData);
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
          return stripEventDataRefs(parsed, resolveData);
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
      // A correlation id is only unique within its run, so an unscoped lookup
      // can return another run's events. Scope to the run when the caller
      // supplies one; older callers omit it and keep the previous behavior.
      // The predicate lives in the WHERE clause so it applies before the
      // limit + 1 window, otherwise the cursor and hasMore would be wrong.
      const all = await drizzle
        .select()
        .from(events)
        .where(
          and(
            eq(events.correlationId, params.correlationId),
            params.runId !== undefined ? eq(events.runId, params.runId) : undefined,
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
          return stripEventDataRefs(parsed, resolveData);
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
      if (!value) {
        throw new WorkflowWorldError(`Hook not found: ${hookId}`, { status: 404 });
      }
      value.metadata ||= value.metadataJson;
      const parsed = HookSchema.parse(compact(value));
      const resolveData = params?.resolveData ?? 'all';
      return filterHookData(parsed, resolveData);
    },
    async getByToken(token, params) {
      const [value] = await getByToken.execute({ token });
      if (!value) {
        throw new HookNotFoundError(token);
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

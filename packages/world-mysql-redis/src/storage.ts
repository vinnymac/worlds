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
import type { MySql2Database } from 'drizzle-orm/mysql2';
import { decodeTime, monotonicFactory } from 'ulid';
import type { SerializedContent } from './schema.js';
import * as schema from './schema.js';
import { compact } from './util.js';

// Type for Drizzle client with our schema
type Drizzle = MySql2Database<typeof schema>;
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
    .select({ stateUpdatedAt: schema.runs.stateUpdatedAt })
    .from(schema.runs)
    .where(eq(schema.runs.runId, runId))
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
    .select({ stateUpdatedAt: schema.runs.stateUpdatedAt })
    .from(schema.runs)
    .where(eq(schema.runs.runId, runId))
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
    .update(schema.runs)
    .set({ stateUpdatedAt: sql`GREATEST(COALESCE(${schema.runs.stateUpdatedAt}, 0), ${marker})` })
    .where(eq(schema.runs.runId, runId));
}

/**
 * Parse error JSON string into a StructuredError object.
 * Used for backwards compatibility when reading from text error column.
 */
/** True when `error` is MySQL ER_DUP_ENTRY on the given key/index name
 * (mysql2 nests the server error under `cause` depending on the call path).
 * Gating on the key name keeps unrelated duplicate-key violations raw. */
function isDuplicateKeyError(error: unknown, keyName: string): boolean {
  const cause = (error as { cause?: unknown })?.cause;
  const errorCode = (error as { code?: string })?.code ?? (cause as { code?: string })?.code;
  const errorMessage = [
    (error as { message?: string })?.message,
    (cause as { message?: string })?.message,
  ].join(' ');
  return errorCode === 'ER_DUP_ENTRY' && errorMessage.includes(keyName);
}

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

export function createRunsStorage(drizzle: Drizzle): Storage['runs'] {
  const runs = schema.runs;

  return {
    get: (async (id: string, params?: any) => {
      const [value] = await drizzle.select().from(runs).where(eq(runs.runId, id)).limit(1);
      if (!value) {
        throw new WorkflowRunNotFoundError(id);
      }
      applyCborFallback(value);
      value.error = parseErrorJson(value.error);
      const deserialized = deserializeRunError(compact(value));
      const parsed = WorkflowRunSchema.parse(deserialized);
      const resolveData = params?.resolveData ?? 'all';
      return filterRunData(parsed, resolveData);
    }) as Storage['runs']['get'],
    list: (async (params?: any) => {
      const limit = params?.pagination?.limit ?? 20;
      const fromCursor = params?.pagination?.cursor;

      const all = await drizzle
        .select()
        .from(runs)
        .where(
          and(
            map(fromCursor, (c: string) => lt(runs.runId, c)),
            map(params?.workflowName, (wf: string) => eq(runs.workflowName, wf)),
            map(params?.status, (s) => eq(runs.status, s as any)),
          ),
        )
        .orderBy(desc(runs.runId))
        .limit(limit + 1);
      const values = all.slice(0, limit);
      const hasMore = all.length > limit;

      const resolveData = params?.resolveData ?? 'all';
      return {
        data: values.map((v) => {
          applyCborFallback(v);
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
  const events = schema.events;
  const maxEvents = resolveMaxEventsPerRun(options.maxEventsPerRun);

  return {
    async create(runId, data, params): Promise<EventResult> {
      // The event id is allocated lazily so events written before it (e.g. the
      // synthetic run_created insert in the resilient-start bootstrap) receive
      // smaller ULIDs; event ordering is by eventId.
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

      // ============================================================
      // VALIDATION: Terminal state checks
      // ============================================================

      // Get current run state for validation (if not creating a new run)
      // Skip run validation for step_completed and step_retrying
      let currentRun: { status: string } | null = null;
      const skipRunValidationEvents = ['step_completed', 'step_retrying'];
      if (data.eventType !== 'run_created' && !skipRunValidationEvents.includes(data.eventType)) {
        const [runValue] = await drizzle
          .select({ status: schema.runs.status })
          .from(schema.runs)
          .where(eq(schema.runs.runId, effectiveRunId))
          .limit(1);
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
        if (
          runInputData.deploymentId &&
          runInputData.workflowName &&
          runInputData.input !== undefined
        ) {
          // A plain INSERT on the runs PK atomically detects whether this
          // writer created the run (an upsert's affectedRows cannot: mysql2
          // connects with CLIENT_FOUND_ROWS, so a lost race also reports 1
          // and would double-append the synthetic event); only the creator
          // writes the synthetic run_created event.
          let bootstrapped = true;
          try {
            await drizzle.insert(schema.runs).values({
              runId: effectiveRunId,
              deploymentId: runInputData.deploymentId,
              workflowName: runInputData.workflowName,
              specVersion: effectiveSpecVersion,
              input: runInputData.input as SerializedContent,
              executionContext: runInputData.executionContext as SerializedContent | undefined,
              status: 'pending',
            });
          } catch (error: unknown) {
            if (!isDuplicateKeyError(error, 'workflow_runs.PRIMARY')) {
              throw error;
            }
            bootstrapped = false;
          }
          if (bootstrapped) {
            // Create synthetic run_created event
            const runCreatedEventId = `wevt_${ulid()}`;
            await drizzle.insert(schema.events).values({
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
            currentRun = { status: 'pending' };
          } else {
            // Run already exists (concurrent run_created won the race).
            // Re-read so downstream logic sees the real state.
            const [existingRun] = await drizzle
              .select({ status: schema.runs.status })
              .from(schema.runs)
              .where(eq(schema.runs.runId, effectiveRunId))
              .limit(1);
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
            .from(schema.runs)
            .where(eq(schema.runs.runId, effectiveRunId))
            .limit(1);

          // Create the event (still record it)
          await drizzle.insert(schema.events).values({
            runId: effectiveRunId,
            eventId: getEventId(),
            correlationId: data.correlationId,
            eventType: data.eventType,
            eventData: 'eventData' in data ? data.eventData : undefined,
            occurredAt: params?.occurredAt,
            specVersion: effectiveSpecVersion,
          });

          // MySQL doesn't support RETURNING, so fetch the event we just created
          const [createdEvent] = await drizzle
            .select({
              createdAt: schema.events.createdAt,
              occurredAt: schema.events.occurredAt,
            })
            .from(schema.events)
            .where(eq(schema.events.eventId, getEventId()))
            .limit(1);

          const result = {
            ...data,
            ...(createdEvent ? compact(createdEvent) : undefined),
            runId: effectiveRunId,
            eventId: getEventId(),
          };
          const parsed = EventSchema.parse(result);
          const resolveData = params?.resolveData ?? 'all';
          return {
            event: stripEventDataRefs(parsed, resolveData),
            run: fullRun
              ? (() => {
                  applyCborFallback(fullRun);
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
        const [existingStep] = await drizzle
          .select({
            status: schema.steps.status,
            startedAt: schema.steps.startedAt,
            retryAfter: schema.steps.retryAfter,
          })
          .from(schema.steps)
          .where(
            and(
              eq(schema.steps.runId, effectiveRunId),
              eq(schema.steps.stepId, data.correlationId),
            ),
          )
          .limit(1);

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
          .select({ hookId: schema.hooks.hookId })
          .from(schema.hooks)
          .where(eq(schema.hooks.hookId, data.correlationId))
          .limit(1);

        if (!existingHook) {
          throw new HookNotFoundError(data.correlationId);
        }
      }

      // ============================================================
      // Entity creation/updates based on event type
      // ============================================================

      // When a guarded terminal-transition UPDATE affects 0 rows, re-read the
      // run to distinguish "missing" from "already terminal" (TOCTOU race with
      // a concurrent terminal event).
      const throwRunUpdateConflict = async (): Promise<never> => {
        const [existing] = await drizzle
          .select({ status: schema.runs.status })
          .from(schema.runs)
          .where(eq(schema.runs.runId, effectiveRunId))
          .limit(1);
        if (!existing) {
          throw new WorkflowRunNotFoundError(effectiveRunId);
        }
        throw new EntityConflictError(
          `Cannot transition run from terminal state "${existing.status}"`,
        );
      };

      // Handle run_created event: create the run entity atomically
      if (data.eventType === 'run_created') {
        const eventData = (data as any).eventData as {
          deploymentId: string;
          workflowName: string;
          input: any[];
          executionContext?: Record<string, any>;
        };
        // Plain INSERT: the runs PK is the duplicate arbiter. An upsert's
        // affectedRows cannot distinguish a fresh insert from a no-op
        // duplicate here, because mysql2 connects with CLIENT_FOUND_ROWS
        // (a duplicate set to its current values also reports 1).
        try {
          await drizzle.insert(schema.runs).values({
            runId: effectiveRunId,
            deploymentId: eventData.deploymentId,
            workflowName: eventData.workflowName,
            // Propagate specVersion from the event to the run entity
            specVersion: effectiveSpecVersion,
            input: eventData.input as SerializedContent,
            executionContext: eventData.executionContext as SerializedContent | undefined,
            status: 'pending',
          });
        } catch (error: unknown) {
          if (isDuplicateKeyError(error, 'workflow_runs.PRIMARY')) {
            // Duplicate run_created: rejecting here, before the shared event
            // insert below, keeps a redelivery from appending a second
            // run_created row. Core treats this 409 as benign ("the run
            // already exists").
            throw new EntityConflictError(`Workflow run "${effectiveRunId}" already exists`);
          }
          throw error;
        }

        const [runValue] = await drizzle
          .select()
          .from(schema.runs)
          .where(eq(schema.runs.runId, effectiveRunId))
          .limit(1);
        if (runValue) {
          applyCborFallback(runValue);
          runValue.error = parseErrorJson(runValue.error);
          run = deserializeRunError(compact(runValue));
        }
      }

      // Handle run_started event: update run status
      if (data.eventType === 'run_started') {
        // Idempotency: if run is already past pending, this is a replay.
        // Return existing run state without creating a duplicate event.
        if (currentRun?.status === 'running') {
          const [existingRun] = await drizzle
            .select()
            .from(schema.runs)
            .where(eq(schema.runs.runId, effectiveRunId))
            .limit(1);
          if (existingRun) {
            applyCborFallback(existingRun);
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

        // The run row must exist by now: either it was created by run_created,
        // or the resilient-start bootstrap above created it from eventData.
        // Throwing here (instead of silently updating 0 rows) lets the queue
        // retry the delivery until the parallel run_created insert lands.
        if (!currentRun) {
          throw new WorkflowRunNotFoundError(effectiveRunId);
        }

        await drizzle
          .update(schema.runs)
          .set({
            status: 'running',
            startedAt: now,
            updatedAt: now,
          })
          .where(eq(schema.runs.runId, effectiveRunId));

        const [runValue] = await drizzle
          .select()
          .from(schema.runs)
          .where(eq(schema.runs.runId, effectiveRunId))
          .limit(1);
        if (runValue) {
          applyCborFallback(runValue);
          runValue.error = parseErrorJson(runValue.error);
          run = deserializeRunError(compact(runValue));
        }
      }

      // Handle run_completed event: update run status and cleanup hooks
      // Uses conditional UPDATE to prevent completing an already-terminal run.
      if (data.eventType === 'run_completed') {
        const eventData = (data as any).eventData as { output?: any };
        const updateResult = await drizzle
          .update(schema.runs)
          .set({
            status: 'completed',
            output: eventData?.output as SerializedContent | undefined,
            completedAt: now,
            updatedAt: now,
          })
          .where(
            and(
              eq(schema.runs.runId, effectiveRunId),
              notInArray(schema.runs.status, ['completed', 'failed', 'cancelled']),
            ),
          );
        if (updateResult[0].affectedRows === 0) {
          await throwRunUpdateConflict();
        }

        const [runValue] = await drizzle
          .select()
          .from(schema.runs)
          .where(eq(schema.runs.runId, effectiveRunId))
          .limit(1);
        if (runValue) {
          applyCborFallback(runValue);
          runValue.error = parseErrorJson(runValue.error);
          run = deserializeRunError(compact(runValue));
        }
        // Delete all hooks for this run to allow token reuse
        await drizzle.delete(schema.hooks).where(eq(schema.hooks.runId, effectiveRunId));
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
        const updateResult = await drizzle
          .update(schema.runs)
          .set({
            status: 'failed',
            error: JSON.stringify(errorObj),
            completedAt: now,
            updatedAt: now,
          })
          .where(
            and(
              eq(schema.runs.runId, effectiveRunId),
              notInArray(schema.runs.status, ['completed', 'failed', 'cancelled']),
            ),
          );
        if (updateResult[0].affectedRows === 0) {
          await throwRunUpdateConflict();
        }

        const [runValue] = await drizzle
          .select()
          .from(schema.runs)
          .where(eq(schema.runs.runId, effectiveRunId))
          .limit(1);
        if (runValue) {
          applyCborFallback(runValue);
          runValue.error = parseErrorJson(runValue.error);
          run = deserializeRunError(compact(runValue));
        }
        // Delete all hooks for this run to allow token reuse
        await drizzle.delete(schema.hooks).where(eq(schema.hooks.runId, effectiveRunId));
      }

      // Handle run_cancelled event: update run status and cleanup hooks
      // Uses conditional UPDATE to prevent cancelling an already-terminal run.
      // Note: idempotent run_cancelled on already-cancelled runs is handled
      // earlier in the pre-validation block (creates event and returns early).
      if (data.eventType === 'run_cancelled') {
        const updateResult = await drizzle
          .update(schema.runs)
          .set({
            status: 'cancelled',
            completedAt: now,
            updatedAt: now,
          })
          .where(
            and(
              eq(schema.runs.runId, effectiveRunId),
              notInArray(schema.runs.status, ['completed', 'failed', 'cancelled']),
            ),
          );
        if (updateResult[0].affectedRows === 0) {
          await throwRunUpdateConflict();
        }

        const [runValue] = await drizzle
          .select()
          .from(schema.runs)
          .where(eq(schema.runs.runId, effectiveRunId))
          .limit(1);
        if (runValue) {
          applyCborFallback(runValue);
          runValue.error = parseErrorJson(runValue.error);
          run = deserializeRunError(compact(runValue));
        }
        // Delete all hooks for this run to allow token reuse
        await drizzle.delete(schema.hooks).where(eq(schema.hooks.runId, effectiveRunId));
      }

      // Handle step_created event: create step entity
      if (data.eventType === 'step_created') {
        const eventData = (data as any).eventData as {
          stepName: string;
          input: any;
        };
        await drizzle
          .insert(schema.steps)
          .values({
            runId: effectiveRunId,
            stepId: data.correlationId!,
            stepName: eventData.stepName,
            input: eventData.input as SerializedContent,
            status: 'pending',
            attempt: 0,
            // Propagate specVersion from the event to the step entity
            specVersion: effectiveSpecVersion,
          })
          .onDuplicateKeyUpdate({ set: { stepId: data.correlationId! } });

        const [stepValue] = await drizzle
          .select()
          .from(schema.steps)
          .where(eq(schema.steps.stepId, data.correlationId!))
          .limit(1);
        if (stepValue) {
          applyCborFallbackStep(stepValue);
          stepValue.error = parseErrorJson(stepValue.error);
          step = deserializeStepError(compact(stepValue));
        }
      }

      // Handle step_started event: increment attempt, set status to 'running'
      if (data.eventType === 'step_started') {
        // Retried steps may be scheduled for later. Reject early redeliveries
        // with TooEarlyError so the queue redelivers after the backoff.
        if (validatedStep?.retryAfter && validatedStep.retryAfter.getTime() > Date.now()) {
          throw new TooEarlyError(
            `Cannot start step "${data.correlationId}": retryAfter timestamp has not been reached yet`,
            {
              retryAfter: Math.ceil((validatedStep.retryAfter.getTime() - Date.now()) / 1000),
            },
          );
        }

        const isFirstStart = !validatedStep?.startedAt;

        // The terminal-state guard is part of the UPDATE, not just the earlier
        // validation read. That closes the race where another writer
        // completes/fails the step between validation and start.
        const updateResult = await drizzle
          .update(schema.steps)
          .set({
            status: 'running',
            attempt: sql`${schema.steps.attempt} + 1`,
            // Always clear retryAfter now that the step has started
            retryAfter: null,
            ...(isFirstStart ? { startedAt: now } : {}),
          })
          .where(
            and(
              eq(schema.steps.runId, effectiveRunId),
              eq(schema.steps.stepId, data.correlationId!),
              notInArray(schema.steps.status, ['completed', 'failed', 'cancelled']),
            ),
          );
        if (updateResult[0].affectedRows === 0) {
          // Step not updated: a concurrent writer finalized it between the
          // validation read and this UPDATE.
          const [existing] = await drizzle
            .select({ status: schema.steps.status })
            .from(schema.steps)
            .where(
              and(
                eq(schema.steps.runId, effectiveRunId),
                eq(schema.steps.stepId, data.correlationId!),
              ),
            )
            .limit(1);
          if (!existing) {
            throw new WorkflowWorldError(`Step "${data.correlationId}" not found`, { status: 404 });
          }
          throw new EntityConflictError(
            `Cannot modify step in terminal state "${existing.status}"`,
          );
        }

        const [stepValue] = await drizzle
          .select()
          .from(schema.steps)
          .where(
            and(
              eq(schema.steps.runId, effectiveRunId),
              eq(schema.steps.stepId, data.correlationId!),
            ),
          )
          .limit(1);
        if (stepValue) {
          applyCborFallbackStep(stepValue);
          stepValue.error = parseErrorJson(stepValue.error);
          step = deserializeStepError(compact(stepValue));
        }
      }

      // Handle step_completed event: update step status
      if (data.eventType === 'step_completed') {
        const eventData = (data as any).eventData as { result?: any };
        const result = await drizzle
          .update(schema.steps)
          .set({
            status: 'completed',
            output: eventData?.result as SerializedContent | undefined,
            completedAt: now,
          })
          .where(
            and(
              eq(schema.steps.runId, effectiveRunId),
              eq(schema.steps.stepId, data.correlationId!),
              notInArray(schema.steps.status, ['completed', 'failed', 'cancelled']),
            ),
          );

        if (result[0].affectedRows > 0) {
          const [stepValue] = await drizzle
            .select()
            .from(schema.steps)
            .where(
              and(
                eq(schema.steps.runId, effectiveRunId),
                eq(schema.steps.stepId, data.correlationId!),
              ),
            )
            .limit(1);
          if (stepValue) {
            applyCborFallbackStep(stepValue);
            stepValue.error = parseErrorJson(stepValue.error);
            step = deserializeStepError(compact(stepValue));
          }
        } else {
          const [existing] = await drizzle
            .select({
              status: schema.steps.status,
              startedAt: schema.steps.startedAt,
            })
            .from(schema.steps)
            .where(
              and(
                eq(schema.steps.runId, effectiveRunId),
                eq(schema.steps.stepId, data.correlationId!),
              ),
            )
            .limit(1);
          if (!existing) {
            throw new WorkflowWorldError(`Step "${data.correlationId}" not found`, { status: 404 });
          }
          if (['completed', 'failed', 'cancelled'].includes(existing.status)) {
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
          typeof eventData?.error === 'string'
            ? eventData.error
            : (eventData?.error?.message ?? 'Unknown error');

        const result = await drizzle
          .update(schema.steps)
          .set({
            status: 'failed',
            error: JSON.stringify({
              message: errorMessage,
              stack: eventData?.stack,
            }),
            completedAt: now,
          })
          .where(
            and(
              eq(schema.steps.runId, effectiveRunId),
              eq(schema.steps.stepId, data.correlationId!),
              notInArray(schema.steps.status, ['completed', 'failed', 'cancelled']),
            ),
          );

        if (result[0].affectedRows > 0) {
          const [stepValue] = await drizzle
            .select()
            .from(schema.steps)
            .where(
              and(
                eq(schema.steps.runId, effectiveRunId),
                eq(schema.steps.stepId, data.correlationId!),
              ),
            )
            .limit(1);
          if (stepValue) {
            applyCborFallbackStep(stepValue);
            stepValue.error = parseErrorJson(stepValue.error);
            step = deserializeStepError(compact(stepValue));
          }
        } else {
          const [existing] = await drizzle
            .select({
              status: schema.steps.status,
              startedAt: schema.steps.startedAt,
            })
            .from(schema.steps)
            .where(
              and(
                eq(schema.steps.runId, effectiveRunId),
                eq(schema.steps.stepId, data.correlationId!),
              ),
            )
            .limit(1);
          if (!existing) {
            throw new WorkflowWorldError(`Step "${data.correlationId}" not found`, { status: 404 });
          }
          if (['completed', 'failed', 'cancelled'].includes(existing.status)) {
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
          typeof eventData?.error === 'string'
            ? eventData.error
            : (eventData?.error?.message ?? 'Unknown error');

        // Uses conditional UPDATE to prevent retrying an already-terminal step.
        const updateResult = await drizzle
          .update(schema.steps)
          .set({
            status: 'pending',
            error: JSON.stringify({
              message: errorMessage,
              stack: eventData?.stack,
            }),
            retryAfter: eventData?.retryAfter,
          })
          .where(
            and(
              eq(schema.steps.runId, effectiveRunId),
              eq(schema.steps.stepId, data.correlationId!),
              notInArray(schema.steps.status, ['completed', 'failed', 'cancelled']),
            ),
          );
        if (updateResult[0].affectedRows === 0) {
          // A concurrent writer finalized the step between the validation
          // read and this UPDATE.
          throw new EntityConflictError(
            `Cannot modify step in terminal state: step "${data.correlationId}" was concurrently finalized`,
          );
        }

        const [stepValue] = await drizzle
          .select()
          .from(schema.steps)
          .where(
            and(
              eq(schema.steps.runId, effectiveRunId),
              eq(schema.steps.stepId, data.correlationId!),
            ),
          )
          .limit(1);
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
          isWebhook?: boolean;
        };

        // Check for duplicate token
        const [existingHook] = await drizzle
          .select({ hookId: schema.hooks.hookId, runId: schema.hooks.runId })
          .from(schema.hooks)
          .where(eq(schema.hooks.token, eventData.token))
          .limit(1);

        if (existingHook) {
          // Idempotency: if the existing hook is the *same* (runId, hookId) we
          // are trying to create, this is either a duplicate / replayed
          // processing of the same hook_created (not a real conflict), or an
          // orphaned hook row from a prior crashed attempt (the hook INSERT
          // below landed but the events INSERT didn't; these writes are not
          // in one transaction). Distinguish by checking whether the
          // hook_created event actually exists in the event log:
          //   - exists -> real duplicate: throw EntityConflictError so the
          //     runtime's concurrent-replay catch path swallows it, instead of
          //     producing a self-conflict in the event log that would later
          //     replay as HookConflictError.
          //   - missing -> orphaned hook row: skip the hook insert and fall
          //     through to the events INSERT below, completing the partial
          //     write.
          if (existingHook.runId === effectiveRunId && existingHook.hookId === data.correlationId) {
            const [existingEvent] = await drizzle
              .select({ eventId: events.eventId })
              .from(events)
              .where(
                and(
                  eq(events.runId, effectiveRunId),
                  eq(events.correlationId, data.correlationId),
                  eq(events.eventType, 'hook_created'),
                ),
              )
              .limit(1);
            if (existingEvent) {
              throw new EntityConflictError(`Hook "${data.correlationId}" already created`);
            }
            // Orphaned hook row: re-fetch it so the EventResult carries the
            // actual persisted entity rather than undefined.
            const [recoveredHookValue] = await drizzle
              .select()
              .from(schema.hooks)
              .where(eq(schema.hooks.hookId, data.correlationId))
              .limit(1);
            if (recoveredHookValue) {
              recoveredHookValue.metadata ||= recoveredHookValue.metadataJson;
              hook = HookSchema.parse(compact(recoveredHookValue));
            }
          } else {
            // Cross-hook / cross-run conflict: a different (runId, hookId)
            // holds this token. Create a hook_conflict event instead of
            // throwing 409; this lets the workflow continue and fail
            // gracefully when the hook is awaited.
            const conflictEventData = {
              token: eventData.token,
              conflictingRunId: existingHook.runId,
            };

            await drizzle.insert(events).values({
              runId: effectiveRunId,
              eventId: getEventId(),
              correlationId: data.correlationId,
              eventType: 'hook_conflict',
              eventData: conflictEventData,
              occurredAt: params?.occurredAt,
              specVersion: effectiveSpecVersion,
            });

            const [conflictValue] = await drizzle
              .select({ createdAt: events.createdAt, occurredAt: events.occurredAt })
              .from(events)
              .where(eq(events.eventId, getEventId()))
              .limit(1);

            if (!conflictValue) {
              throw new WorkflowWorldError(`Event ${getEventId()} could not be created`, {
                status: 409,
              });
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
          }
        } else {
          await drizzle
            .insert(schema.hooks)
            .values({
              runId: effectiveRunId,
              hookId: data.correlationId!,
              token: eventData.token,
              metadata: eventData.metadata as SerializedContent,
              // Multi-tenancy fields - not yet implemented, using empty strings as placeholders
              ownerId: '',
              projectId: '',
              environment: '',
              // Propagate specVersion from the event to the hook entity
              specVersion: effectiveSpecVersion,
              isWebhook: eventData.isWebhook,
            })
            .onDuplicateKeyUpdate({ set: { hookId: data.correlationId! } });

          const [hookValue] = await drizzle
            .select()
            .from(schema.hooks)
            .where(eq(schema.hooks.hookId, data.correlationId!))
            .limit(1);
          if (hookValue) {
            hookValue.metadata ||= hookValue.metadataJson;
            hook = HookSchema.parse(compact(hookValue));
          }
        }
      }

      // Handle hook_disposed event: delete hook entity atomically. If the
      // DELETE affects 0 rows, a concurrent caller already disposed the hook;
      // reject as a conflict instead of silently logging a duplicate disposal.
      if (data.eventType === 'hook_disposed' && data.correlationId) {
        const deleteResult = await drizzle
          .delete(schema.hooks)
          .where(eq(schema.hooks.hookId, data.correlationId));
        if (deleteResult[0].affectedRows === 0) {
          throw new EntityConflictError(`Hook "${data.correlationId}" already disposed`);
        }
      }

      const storedEventData =
        data.eventType === 'run_started'
          ? undefined
          : 'eventData' in data
            ? data.eventData
            : undefined;
      // Guard pass 2 of 2, plus the marker advance for externally-originated
      // events. Both contend on the run row, so check and write are atomic.
      const value = await drizzle.transaction(async (tx) => {
        const advancesStateMarker = await lockRunState(
          tx,
          effectiveRunId,
          data.eventType,
          params?.stateUpdatedAt,
        );

        try {
          await tx.insert(events).values({
            runId: effectiveRunId,
            eventId: getEventId(),
            correlationId: data.correlationId,
            eventType: data.eventType,
            eventData: storedEventData,
            occurredAt: params?.occurredAt,
            specVersion: effectiveSpecVersion,
          });
        } catch (error: unknown) {
          // A duplicate creation row surfaces as EntityConflictError, the dedup
          // signal the runtime expects on redelivered creates. Gated on the index
          // name so other ER_DUP_ENTRY violations still propagate raw.
          if (isDuplicateKeyError(error, 'workflow_events_entity_creation_unique')) {
            throw new EntityConflictError(
              `${data.eventType} for correlationId "${data.correlationId}" already exists in run "${effectiveRunId}"`,
            );
          }
          throw error;
        }

        if (advancesStateMarker) {
          await advanceStateMarker(tx, effectiveRunId, getEventId());
        }

        const [inserted] = await tx
          .select({ createdAt: events.createdAt, occurredAt: events.occurredAt })
          .from(events)
          .where(eq(events.eventId, getEventId()))
          .limit(1);
        return inserted;
      });
      if (!value) {
        throw new WorkflowWorldError(`Event ${getEventId()} could not be created`, {
          status: 409,
        });
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
          applyCborFallbackEvent(e);
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
      applyCborFallbackEvent(value);
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
            map(params.pagination?.cursor, (c: string) => order.compare(events.eventId, c)),
          ),
        )
        .orderBy(order.by)
        .limit(limit + 1);

      const values = all.slice(0, limit);

      const resolveData = params?.resolveData ?? 'all';
      return {
        data: values.map((v) => {
          applyCborFallbackEvent(v);
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
      const all = await drizzle
        .select()
        .from(events)
        .where(
          and(
            eq(events.correlationId, params.correlationId),
            // A correlation id is unique within its run, not across runs, so a
            // caller that supplies a run id gets the lookup scoped to that run.
            // Older cores omit it and keep the previous unscoped behavior. The
            // predicate belongs in the WHERE clause: filtering after the query
            // would break LIMIT and the cursor.
            map(params.runId, (id: string) => eq(events.runId, id)),
            map(params.pagination?.cursor, (c: string) => order.compare(events.eventId, c)),
          ),
        )
        .orderBy(order.by)
        .limit(limit + 1);

      const values = all.slice(0, limit);

      const resolveData = params?.resolveData ?? 'all';
      return {
        data: values.map((v) => {
          applyCborFallbackEvent(v);
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
  const hooks = schema.hooks;

  return {
    async get(hookId, params) {
      const [value] = await drizzle.select().from(hooks).where(eq(hooks.hookId, hookId)).limit(1);
      if (!value) {
        throw new HookNotFoundError(hookId);
      }
      value.metadata ||= value.metadataJson;
      const parsed = HookSchema.parse(compact(value));
      const resolveData = params?.resolveData ?? 'all';
      return filterHookData(parsed, resolveData);
    },
    async getByToken(token, params) {
      const [value] = await drizzle.select().from(hooks).where(eq(hooks.token, token)).limit(1);
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
            map(params.runId, (id: string) => eq(hooks.runId, id)),
            map(fromCursor, (c: string) => lt(hooks.hookId, c)),
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
  const steps = schema.steps;

  return {
    get: (async (runId: string | undefined, stepId: string, params?: any) => {
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
    list: (async (params: any) => {
      const limit = params?.pagination?.limit ?? 20;
      const fromCursor = params?.pagination?.cursor;

      const all = await drizzle
        .select()
        .from(steps)
        .where(
          and(
            eq(steps.runId, params.runId),
            map(fromCursor, (c: string) => lt(steps.stepId, c)),
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

export function createStorage(drizzle: Drizzle, options: EventsStorageOptions = {}): Storage {
  return {
    runs: createRunsStorage(drizzle),
    events: createEventsStorage(drizzle, options),
    hooks: createHooksStorage(drizzle),
    steps: createStepsStorage(drizzle),
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

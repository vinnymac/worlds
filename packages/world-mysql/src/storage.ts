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
import { and, desc, eq, getTableColumns, gt, lt, notInArray, sql } from 'drizzle-orm';
import type { MySql2Database } from 'drizzle-orm/mysql2';
import { decodeTime, monotonicFactory } from 'ulid';
import type { SerializedContent } from './schema.js';
import * as schema from './schema.js';
import { compact } from './util.js';

// Type for Drizzle client with our schema
type Drizzle = MySql2Database<typeof schema>;
// A drizzle client or an open transaction on one; lets helpers run inside
// the events.create() transaction as well as standalone.
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

/** Advance the run's state marker to the ULID time of the event just written.
 * `GREATEST` keeps it monotonic without a read-modify-write. */
async function advanceStateMarker(tx: DrizzleOrTx, runId: string, eventId: string): Promise<void> {
  const marker = eventIdTime(eventId);
  await tx
    .update(schema.runs)
    .set({ stateUpdatedAt: sql`GREATEST(COALESCE(${schema.runs.stateUpdatedAt}, 0), ${marker})` })
    .where(eq(schema.runs.runId, runId));
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

/** Payload columns stripped for `resolveData: 'none'`. */
const DATA_COLUMNS = ['input', 'inputJson', 'output', 'outputJson'];

/** `resolveData: 'none'` callers discard input/output, so these projections
 * keep the payload columns inside MySQL rather than reading them across the
 * wire and stripping them in JS. Derived from the live table definition so a
 * new column cannot silently reintroduce the blob. */
function columnsWithoutData<T extends object>(table: T) {
  const cols: Record<string, unknown> = { ...getTableColumns(table as any) };
  for (const c of DATA_COLUMNS) delete cols[c];
  return cols as any;
}
const runColumnsWithoutData = columnsWithoutData(schema.runs);
const stepColumnsWithoutData = columnsWithoutData(schema.steps);

export function createRunsStorage(drizzle: Drizzle): Storage['runs'] {
  const runs = schema.runs;

  return {
    get: (async (id: string, params?: any) => {
      const [value] = await drizzle
        .select(params?.resolveData === 'none' ? runColumnsWithoutData : undefined)
        .from(runs)
        .where(eq(runs.runId, id))
        .limit(1);
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
        .select(params?.resolveData === 'none' ? runColumnsWithoutData : undefined)
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

/** Server-generated columns of a freshly inserted event row. */
interface InsertedEventRow {
  createdAt: Date;
  occurredAt: Date | null;
}

/** Result of the entity-mutation transaction inside events.create(). */
type MutationOutcome =
  | {
      kind: 'event-created';
      eventRow: InsertedEventRow;
      run?: WorkflowRun;
      step?: Step;
      hook?: Hook;
    }
  | { kind: 'run-started-replay'; run?: WorkflowRun }
  | {
      kind: 'hook-conflict';
      eventRow: InsertedEventRow;
      conflictEventData: { token: string; conflictingRunId: string };
    };

export function createEventsStorage(
  drizzle: Drizzle,
  options: EventsStorageOptions = {},
): Storage['events'] {
  const ulid = monotonicFactory();
  const events = schema.events;
  const maxEvents = resolveMaxEventsPerRun(options.maxEventsPerRun);

  // Terminal statuses, used both for JS checks and as atomic guards in
  // UPDATE ... WHERE clauses (prevents TOCTOU races between validation
  // reads and entity writes).
  const terminalStatuses = ['completed', 'failed', 'cancelled'] as const;
  const isTerminal = (status: string): boolean =>
    (terminalStatuses as readonly string[]).includes(status);

  async function fetchRun(
    db: DrizzleOrTx,
    runId: string,
    resolveData: ResolveData = 'all',
  ): Promise<WorkflowRun | undefined> {
    const [value] = await db
      .select(resolveData === 'none' ? runColumnsWithoutData : undefined)
      .from(schema.runs)
      .where(eq(schema.runs.runId, runId))
      .limit(1);
    if (!value) return undefined;
    applyCborFallback(value);
    value.error = parseErrorJson(value.error);
    return deserializeRunError(compact(value));
  }

  async function fetchStep(
    db: DrizzleOrTx,
    runId: string,
    stepId: string,
    resolveData: ResolveData = 'all',
  ): Promise<Step | undefined> {
    const [value] = await db
      .select(resolveData === 'none' ? stepColumnsWithoutData : undefined)
      .from(schema.steps)
      .where(and(eq(schema.steps.runId, runId), eq(schema.steps.stepId, stepId)))
      .limit(1);
    if (!value) return undefined;
    applyCborFallbackStep(value);
    value.error = parseErrorJson(value.error);
    return deserializeStepError(compact(value));
  }

  interface EventRowInsert {
    runId: string;
    eventId: string;
    correlationId?: string;
    eventType: Event['eventType'];
    eventData?: unknown;
    occurredAt?: Date;
    specVersion: number;
  }

  // MySQL has no INSERT ... RETURNING, so insert then re-read the
  // server-generated timestamps for the event row.
  async function insertEvent(db: DrizzleOrTx, values: EventRowInsert): Promise<InsertedEventRow> {
    try {
      await db.insert(events).values(values);
    } catch (error: unknown) {
      // A duplicate creation row surfaces as EntityConflictError, the dedup
      // signal the runtime expects on redelivered creates. Gated on the index
      // name so other ER_DUP_ENTRY violations still propagate raw.
      if (isDuplicateKeyError(error, 'workflow_events_entity_creation_unique')) {
        throw new EntityConflictError(
          `${values.eventType} for correlationId "${values.correlationId}" already exists in run "${values.runId}"`,
        );
      }
      throw error;
    }
    const [created] = await db
      .select({ createdAt: events.createdAt, occurredAt: events.occurredAt })
      .from(events)
      .where(eq(events.eventId, values.eventId))
      .limit(1);
    if (!created) {
      throw new EntityConflictError(`Event ${values.eventId} could not be created`);
    }
    return created;
  }

  return {
    async create(runId, data, params): Promise<EventResult> {
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
      const effectiveSpecVersion: number = data.specVersion ?? SPEC_VERSION_CURRENT;
      const resolveData = params?.resolveData ?? 'all';
      const now = new Date();

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
            // Create run + run_created event atomically. A plain INSERT on
            // the runs PK arbitrates the race (an upsert's affectedRows
            // cannot: mysql2 connects with CLIENT_FOUND_ROWS, so a lost race
            // also reports 1 and would double-append the synthetic event);
            // only the creator writes the synthetic run_created event.
            currentRun = await drizzle.transaction(async (tx) => {
              try {
                await tx.insert(schema.runs).values({
                  runId: effectiveRunId,
                  deploymentId: runInputData.deploymentId!,
                  workflowName: runInputData.workflowName!,
                  input: runInputData.input as SerializedContent,
                  executionContext: runInputData.executionContext as SerializedContent | undefined,
                  status: 'pending',
                  specVersion: effectiveSpecVersion,
                });
              } catch (error: unknown) {
                if (!isDuplicateKeyError(error, 'workflow_runs.PRIMARY')) {
                  throw error;
                }
                // Run already exists (concurrent run_created won the race).
                // Re-read so downstream logic sees the real state.
                const [existing] = await tx
                  .select({ status: schema.runs.status })
                  .from(schema.runs)
                  .where(eq(schema.runs.runId, effectiveRunId))
                  .limit(1);
                return existing ?? null;
              }
              await tx.insert(events).values({
                runId: effectiveRunId,
                eventId: `wevt_${ulid()}`,
                eventType: 'run_created',
                eventData: {
                  deploymentId: runInputData.deploymentId,
                  workflowName: runInputData.workflowName,
                  input: runInputData.input,
                  executionContext: runInputData.executionContext,
                },
                specVersion: effectiveSpecVersion,
              });
              return { status: 'pending' };
            });
          }
        }
      }

      // Run terminal state validation
      if (currentRun && isTerminal(currentRun.status)) {
        const runTerminalEvents = ['run_started', 'run_completed', 'run_failed'];

        // Idempotent operation: run_cancelled on already cancelled run is allowed
        if (data.eventType === 'run_cancelled' && currentRun.status === 'cancelled') {
          // Get full run for return value
          const fullRun = await fetchRun(drizzle, effectiveRunId);

          // Create the event (still record it)
          const eventRow = await insertEvent(drizzle, {
            runId: effectiveRunId,
            eventId: getEventId(),
            correlationId: data.correlationId,
            eventType: data.eventType,
            eventData: 'eventData' in data ? data.eventData : undefined,
            occurredAt: params?.occurredAt,
            specVersion: effectiveSpecVersion,
          });

          const result = {
            ...data,
            ...compact(eventRow),
            runId: effectiveRunId,
            eventId: getEventId(),
          };
          const parsed = EventSchema.parse(result);
          return {
            event: stripEventDataRefs(parsed, resolveData),
            run: fullRun,
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

        if (isTerminal(validatedStep.status)) {
          throw new EntityConflictError(
            `Cannot modify step in terminal state "${validatedStep.status}"`,
          );
        }

        // On terminal runs: only allow completing/failing in-progress steps
        if (currentRun && isTerminal(currentRun.status)) {
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
      // Entity creation/updates based on event type. Each entity write
      // commits atomically with its event log entry; a crash cannot
      // leave a mutated entity without the corresponding event.
      // ============================================================
      const outcome = await drizzle.transaction(async (tx): Promise<MutationOutcome> => {
        let run: WorkflowRun | undefined;
        let step: Step | undefined;
        let hook: Hook | undefined;

        // Taking the run row lock here, before any entity write and before the event
        // ULID is allocated, makes the marker check and this insert one serializable
        // unit; a rejection rolls the whole create back.
        const advancesStateMarker = await lockRunState(
          tx,
          effectiveRunId,
          data.eventType,
          params?.stateUpdatedAt,
        );

        // Handle run_created event: create the run entity
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
            await tx.insert(schema.runs).values({
              runId: effectiveRunId,
              deploymentId: eventData.deploymentId,
              workflowName: eventData.workflowName,
              input: eventData.input as SerializedContent,
              executionContext: eventData.executionContext as SerializedContent | undefined,
              status: 'pending',
              specVersion: effectiveSpecVersion,
            });
          } catch (error: unknown) {
            if (isDuplicateKeyError(error, 'workflow_runs.PRIMARY')) {
              // Duplicate run_created: rejecting inside the transaction
              // aborts before the event insert below, so a redelivery cannot
              // append a second run_created row. Core treats this 409 as
              // benign ("the run already exists").
              throw new EntityConflictError(`Workflow run "${effectiveRunId}" already exists`);
            }
            throw error;
          }
          run = await fetchRun(tx, effectiveRunId, resolveData);
        }

        // Handle run_started event: update run status
        if (data.eventType === 'run_started') {
          // Idempotency: if run is already past pending, this is a replay.
          // Return existing run state without creating a duplicate event.
          if (currentRun?.status === 'running') {
            run = await fetchRun(tx, effectiveRunId, resolveData);
            return { kind: 'run-started-replay', run };
          }

          const [updated] = await tx
            .update(schema.runs)
            .set({
              status: 'running',
              startedAt: now,
              updatedAt: now,
            })
            .where(
              and(
                eq(schema.runs.runId, effectiveRunId),
                notInArray(schema.runs.status, ['completed', 'failed', 'cancelled']),
              ),
            );
          if (updated.affectedRows === 0) {
            const [existing] = await tx
              .select({ status: schema.runs.status })
              .from(schema.runs)
              .where(eq(schema.runs.runId, effectiveRunId))
              .limit(1);
            if (!existing) {
              throw new WorkflowRunNotFoundError(effectiveRunId);
            }
            if (isTerminal(existing.status)) {
              throw new RunExpiredError(
                `Workflow run "${effectiveRunId}" is already in terminal state "${existing.status}"`,
              );
            }
          }
          run = await fetchRun(tx, effectiveRunId, resolveData);
        }

        // Handle run_completed event: update run status and cleanup hooks.
        // Uses conditional UPDATE to prevent completing an already-terminal run.
        if (data.eventType === 'run_completed') {
          const eventData = (data as any).eventData as { output?: any };
          const [updated] = await tx
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
          if (updated.affectedRows === 0) {
            const [existing] = await tx
              .select({ status: schema.runs.status })
              .from(schema.runs)
              .where(eq(schema.runs.runId, effectiveRunId))
              .limit(1);
            if (!existing) {
              throw new WorkflowRunNotFoundError(effectiveRunId);
            }
            if (isTerminal(existing.status)) {
              throw new EntityConflictError(
                `Cannot transition run from terminal state "${existing.status}"`,
              );
            }
          }
          run = await fetchRun(tx, effectiveRunId, resolveData);
          // Delete all hooks for this run to allow token reuse
          await tx.delete(schema.hooks).where(eq(schema.hooks.runId, effectiveRunId));
        }

        // Handle run_failed event: update run status and cleanup hooks.
        // Uses conditional UPDATE to prevent failing an already-terminal run.
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
          const [updated] = await tx
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
          if (updated.affectedRows === 0) {
            const [existing] = await tx
              .select({ status: schema.runs.status })
              .from(schema.runs)
              .where(eq(schema.runs.runId, effectiveRunId))
              .limit(1);
            if (!existing) {
              throw new WorkflowRunNotFoundError(effectiveRunId);
            }
            if (isTerminal(existing.status)) {
              throw new EntityConflictError(
                `Cannot transition run from terminal state "${existing.status}"`,
              );
            }
          }
          run = await fetchRun(tx, effectiveRunId, resolveData);
          // Delete all hooks for this run to allow token reuse
          await tx.delete(schema.hooks).where(eq(schema.hooks.runId, effectiveRunId));
        }

        // Handle run_cancelled event: update run status and cleanup hooks.
        // Uses conditional UPDATE to prevent cancelling an already-terminal run.
        // Note: idempotent run_cancelled on already-cancelled runs is handled
        // earlier in the pre-validation block (creates event and returns early).
        if (data.eventType === 'run_cancelled') {
          const [updated] = await tx
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
          if (updated.affectedRows === 0) {
            const [existing] = await tx
              .select({ status: schema.runs.status })
              .from(schema.runs)
              .where(eq(schema.runs.runId, effectiveRunId))
              .limit(1);
            if (!existing) {
              throw new WorkflowRunNotFoundError(effectiveRunId);
            }
            if (isTerminal(existing.status)) {
              throw new EntityConflictError(
                `Cannot transition run from terminal state "${existing.status}"`,
              );
            }
          }
          run = await fetchRun(tx, effectiveRunId, resolveData);
          // Delete all hooks for this run to allow token reuse
          await tx.delete(schema.hooks).where(eq(schema.hooks.runId, effectiveRunId));
        }

        // Handle step_created event: create step entity
        if (data.eventType === 'step_created') {
          const eventData = (data as any).eventData as {
            stepName: string;
            input: any;
          };
          await tx
            .insert(schema.steps)
            .values({
              runId: effectiveRunId,
              stepId: data.correlationId!,
              stepName: eventData.stepName,
              input: eventData.input as SerializedContent,
              status: 'pending',
              attempt: 0,
              specVersion: effectiveSpecVersion,
            })
            .onDuplicateKeyUpdate({ set: { stepId: data.correlationId! } });
          step = await fetchStep(tx, effectiveRunId, data.correlationId!, resolveData);
        }

        // Handle step_started event: increment attempt, set status to 'running'.
        // The terminal-state guard is part of the UPDATE, not just the earlier
        // validation read; that closes the race where another writer
        // completes/fails the step between validation and start.
        if (data.eventType === 'step_started') {
          // Retried steps may be scheduled for later. Enforce the backoff
          // recorded by step_retrying; the runtime converts TooEarlyError
          // into a delayed re-enqueue.
          if (validatedStep?.retryAfter && validatedStep.retryAfter.getTime() > Date.now()) {
            throw new TooEarlyError(
              `Cannot start step "${data.correlationId}": retryAfter timestamp has not been reached yet`,
              {
                retryAfter: Math.ceil((validatedStep.retryAfter.getTime() - Date.now()) / 1000),
              },
            );
          }

          const [updated] = await tx
            .update(schema.steps)
            .set({
              status: 'running',
              attempt: sql`${schema.steps.attempt} + 1`,
              // Only set startedAt on first start; COALESCE so concurrent
              // step_started calls can't clobber the original timestamp.
              startedAt: sql`COALESCE(${schema.steps.startedAt}, ${now})`,
              // Always clear retryAfter now that the step has started
              retryAfter: null,
            })
            .where(
              and(
                eq(schema.steps.runId, effectiveRunId),
                eq(schema.steps.stepId, data.correlationId!),
                notInArray(schema.steps.status, ['completed', 'failed', 'cancelled']),
              ),
            );
          if (updated.affectedRows === 0) {
            const [existing] = await tx
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
              throw new WorkflowWorldError(`Step "${data.correlationId}" not found`, {
                status: 404,
              });
            }
            throw new EntityConflictError(
              `Cannot modify step in terminal state "${existing.status}"`,
            );
          }
          step = await fetchStep(tx, effectiveRunId, data.correlationId!, resolveData);
        }

        // Handle step_completed event: update step status.
        // Uses conditional UPDATE to prevent completing an already-terminal step.
        if (data.eventType === 'step_completed') {
          const eventData = (data as any).eventData as { result?: any };
          const [updated] = await tx
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
          if (updated.affectedRows === 0) {
            const [existing] = await tx
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
              throw new WorkflowWorldError(`Step "${data.correlationId}" not found`, {
                status: 404,
              });
            }
            if (isTerminal(existing.status)) {
              throw new EntityConflictError(
                `Cannot modify step in terminal state "${existing.status}"`,
              );
            }
          } else {
            step = await fetchStep(tx, effectiveRunId, data.correlationId!, resolveData);
          }
        }

        // Handle step_failed event: terminal state with error.
        // Uses conditional UPDATE to prevent failing an already-terminal step.
        if (data.eventType === 'step_failed') {
          const eventData = (data as any).eventData as {
            error?: any;
            stack?: string;
          };
          const errorMessage =
            typeof eventData?.error === 'string'
              ? eventData.error
              : (eventData?.error?.message ?? 'Unknown error');

          const [updated] = await tx
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
          if (updated.affectedRows === 0) {
            const [existing] = await tx
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
              throw new WorkflowWorldError(`Step "${data.correlationId}" not found`, {
                status: 404,
              });
            }
            if (isTerminal(existing.status)) {
              throw new EntityConflictError(
                `Cannot modify step in terminal state "${existing.status}"`,
              );
            }
          } else {
            step = await fetchStep(tx, effectiveRunId, data.correlationId!, resolveData);
          }
        }

        // Handle step_retrying event: sets status back to 'pending', records error.
        // Uses conditional UPDATE to prevent retrying an already-terminal step.
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

          const [updated] = await tx
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
          if (updated.affectedRows === 0) {
            const [existing] = await tx
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
              throw new WorkflowWorldError(`Step "${data.correlationId}" not found`, {
                status: 404,
              });
            }
            if (isTerminal(existing.status)) {
              throw new EntityConflictError(
                `Cannot modify step in terminal state "${existing.status}"`,
              );
            }
          } else {
            step = await fetchStep(tx, effectiveRunId, data.correlationId!, resolveData);
          }
        }

        // Handle hook_created event: create hook entity
        if (data.eventType === 'hook_created') {
          const eventData = (data as any).eventData as {
            token: string;
            metadata?: any;
            isWebhook?: boolean;
          };

          // Check whether any hook already holds this token
          const [existingHook] = await tx
            .select({ hookId: schema.hooks.hookId, runId: schema.hooks.runId })
            .from(schema.hooks)
            .where(eq(schema.hooks.token, eventData.token))
            .limit(1);

          if (existingHook) {
            if (
              existingHook.runId === effectiveRunId &&
              existingHook.hookId === data.correlationId
            ) {
              // Same (runId, hookId): either a replayed/duplicate hook_created
              // or an orphaned hook row from a crash between the hook INSERT
              // and the event INSERT. Distinguish by whether the hook_created
              // event exists in the log (see vercel/workflow#2283).
              const [existingEvent] = await tx
                .select({ eventId: events.eventId })
                .from(events)
                .where(
                  and(
                    eq(events.runId, effectiveRunId),
                    eq(events.correlationId, data.correlationId!),
                    eq(events.eventType, 'hook_created'),
                  ),
                )
                .limit(1);
              if (existingEvent) {
                // Real duplicate: the runtime's dedup catch path swallows this.
                throw new EntityConflictError(`Hook "${data.correlationId}" already created`);
              }
              // Orphaned hook row: complete the partial write by falling
              // through to the event INSERT below, returning the persisted
              // entity rather than undefined.
              const [recovered] = await tx
                .select()
                .from(schema.hooks)
                .where(eq(schema.hooks.hookId, data.correlationId!))
                .limit(1);
              if (recovered) {
                recovered.metadata ||= recovered.metadataJson;
                hook = HookSchema.parse(compact(recovered));
              }
            } else {
              // A different (runId, hookId) holds this token. Create a
              // hook_conflict event instead of throwing 409; this lets the
              // workflow continue and fail gracefully when the hook is awaited.
              const conflictEventData = {
                token: eventData.token,
                conflictingRunId: existingHook.runId,
              };
              const eventRow = await insertEvent(tx, {
                runId: effectiveRunId,
                eventId: getEventId(),
                correlationId: data.correlationId,
                eventType: 'hook_conflict',
                eventData: conflictEventData,
                occurredAt: params?.occurredAt,
                specVersion: effectiveSpecVersion,
              });
              return { kind: 'hook-conflict', eventRow, conflictEventData };
            }
          } else {
            await tx
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
                specVersion: effectiveSpecVersion,
                isWebhook: eventData.isWebhook,
              })
              .onDuplicateKeyUpdate({ set: { hookId: data.correlationId! } });

            const [hookValue] = await tx
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

        // Handle hook_disposed event: delete hook entity atomically. If no
        // row was deleted, a concurrent caller already disposed the hook.
        if (data.eventType === 'hook_disposed' && data.correlationId) {
          const [deleted] = await tx
            .delete(schema.hooks)
            .where(eq(schema.hooks.hookId, data.correlationId));
          if (deleted.affectedRows === 0) {
            throw new EntityConflictError(`Hook "${data.correlationId}" already disposed`);
          }
        }

        // Strip eventData from run_started; it belongs on run_created only.
        const storedEventData =
          data.eventType === 'run_started'
            ? undefined
            : 'eventData' in data
              ? data.eventData
              : undefined;

        const eventRow = await insertEvent(tx, {
          runId: effectiveRunId,
          eventId: getEventId(),
          correlationId: data.correlationId,
          eventType: data.eventType,
          eventData: storedEventData,
          occurredAt: params?.occurredAt,
          specVersion: effectiveSpecVersion,
        });

        if (advancesStateMarker) {
          await advanceStateMarker(tx, effectiveRunId, getEventId());
        }

        return { kind: 'event-created', eventRow, run, step, hook };
      });

      if (outcome.kind === 'run-started-replay') {
        // Core reads maxEvents only off the run_started response, so the
        // idempotent replay path must carry it too or the ceiling silently
        // disappears on every replay after the first.
        return {
          run: outcome.run ? (filterRunData(outcome.run, resolveData) as WorkflowRun) : undefined,
          ...(outcome.run ? { maxEvents } : {}),
        };
      }

      if (outcome.kind === 'hook-conflict') {
        const conflictResult = {
          eventType: 'hook_conflict' as const,
          correlationId: data.correlationId,
          eventData: outcome.conflictEventData,
          ...compact(outcome.eventRow),
          runId: effectiveRunId,
          eventId: getEventId(),
        };
        const parsedConflict = EventSchema.parse(conflictResult);
        return {
          event: stripEventDataRefs(parsedConflict, resolveData),
          run: undefined,
          step: undefined,
          hook: undefined,
        };
      }

      const result = {
        ...data,
        ...compact(outcome.eventRow),
        runId: effectiveRunId,
        eventId: getEventId(),
      };
      if (data.eventType === 'run_started') {
        delete (result as any).eventData;
      }
      const parsed = EventSchema.parse(result);

      // Preload all events for run_started to reduce TTFB
      let allEvents: Event[] | undefined;
      if (data.eventType === 'run_started' && outcome.run) {
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
        run: outcome.run,
        step: outcome.step,
        hook: outcome.hook,
        events: allEvents,
        ...(outcome.run ? { maxEvents } : {}),
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

      const [value] = await drizzle
        .select(params?.resolveData === 'none' ? stepColumnsWithoutData : undefined)
        .from(steps)
        .where(whereClause)
        .limit(1);

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
        .select(params?.resolveData === 'none' ? stepColumnsWithoutData : undefined)
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

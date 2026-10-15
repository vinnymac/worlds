import {
  EntityConflictError,
  HookNotFoundError,
  RunExpiredError,
  TooEarlyError,
  WorkflowRunNotFoundError,
  WorkflowWorldError,
} from '@workflow/errors';
import type {
  AnyEventRequest,
  CreateEventParams,
  Event,
  EventResult,
  EventsResolveData,
  Hook,
  ListEventsParams,
  ListHooksParams,
  PaginatedResponse,
  ResolveData,
  Step,
  StepWithoutData,
  Storage,
  WorkflowRun,
  WorkflowRunWithoutData,
} from '@workflow/world';
import {
  applyAttributeChanges,
  entityResolveData,
  EventSchema,
  eventIdToSlot,
  HookSchema,
  isChildEntityCreationEvent,
  SPEC_VERSION_CURRENT,
  slotToEventId,
  StepSchema,
  stripEventDataRefs,
  validateAttributeChanges,
  WorkflowRunSchema,
} from '@workflow/world';
import { and, desc, eq, gt, inArray, lt, notInArray, sql } from 'drizzle-orm';
import { monotonicFactory } from 'ulid';
import { type Drizzle, Schema } from './drizzle/index.js';
import type { SerializedContent } from './drizzle/schema.js';
import { compact } from './util.js';

/** An open transaction on the drizzle client. */
type Tx = Parameters<Parameters<Drizzle['transaction']>[0]>[0];

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

/**
 * Puts the stored error back on `error`: the serialized payload when there is
 * one, else the legacy JSON text written before v5. Drops the legacy column
 * either way, since it is not part of the entity contract.
 */
function restoreError(value: { error?: unknown; errorJson?: string | null }): void {
  value.error = value.error ?? parseErrorJson(value.errorJson ?? null);
  delete value.errorJson;
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
  // eventCount is the run's slot counter, not a WorkflowRun field; drop it
  // here so it never leaks onto a returned entity. errorCode is a column of
  // its own and the error is the runtime's serialized payload, so neither is
  // rebuilt into a legacy `{ message, stack, code }` object.
  const { eventCount: _eventCount, ...rest } = run;
  return rest as WorkflowRun;
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
      restoreError(value);
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
            statusFilter(params?.status),
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
          restoreError(v);
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

/**
 * `runs.list` takes one status or several. An empty array matches nothing,
 * like SQL `IN ()`, which is distinct from omitting the filter.
 */
function statusFilter(status: WorkflowRun['status'] | WorkflowRun['status'][] | undefined) {
  if (status === undefined) return undefined;
  if (!Array.isArray(status)) return eq(Schema.runs.status, status);
  return status.length === 0 ? sql`false` : inArray(Schema.runs.status, status);
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

  interface EventRowInsert {
    runId: string;
    correlationId?: string;
    eventType: Event['eventType'];
    eventData?: unknown;
    occurredAt?: Date;
    specVersion: number;
  }

  /** Postgres unique-violation on the entity-creation index, as EntityConflictError. */
  function entityCreationConflict(err: unknown, values: EventRowInsert): Error | undefined {
    const pgErr = (err as { code?: string }).code
      ? (err as { code?: string; constraint_name?: string })
      : ((err as { cause?: { code?: string; constraint_name?: string } }).cause ?? {});
    const pgConstraint =
      (pgErr as { constraint_name?: string; constraint?: string }).constraint_name ??
      (pgErr as { constraint?: string }).constraint;
    if (pgErr.code === '23505' && pgConstraint === 'workflow_events_entity_creation_unique') {
      return new EntityConflictError(
        `${values.eventType} for correlationId "${values.correlationId}" already exists in run "${values.runId}"`,
      );
    }
    return undefined;
  }

  /**
   * Appends one event to its run's log at the next free slot, inside `tx`.
   *
   * The slot comes from the run row's `event_count`, advanced by an `UPDATE`
   * in the same transaction as the insert: it commits or rolls back with the
   * event, so a write that does not land leaves no hole, and the row lock the
   * UPDATE takes keeps a second writer from taking the next slot until this
   * one commits. Any failure aborts the transaction, so the caller rethrows
   * and the counter rolls back with it.
   */
  async function insertEvent(
    tx: Tx,
    values: EventRowInsert,
  ): Promise<{ eventId: string; createdAt: Date; occurredAt: Date | null }> {
    const [advanced] = await tx
      .update(Schema.runs)
      .set({ eventCount: sql`${Schema.runs.eventCount} + 1` })
      .where(eq(Schema.runs.runId, values.runId))
      .returning({ eventCount: Schema.runs.eventCount });
    if (!advanced) {
      throw new WorkflowRunNotFoundError(values.runId);
    }
    const eventId = slotToEventId(advanced.eventCount);
    // A wait completes once. Its creation is deduplicated by the entity
    // creation index; its completion is checked here, under the run row lock
    // the slot UPDATE just took, so two completions cannot both pass.
    if (values.eventType === 'wait_completed' && values.correlationId) {
      const [completed] = await tx
        .select({ eventId: events.eventId })
        .from(events)
        .where(
          and(
            eq(events.runId, values.runId),
            eq(events.correlationId, values.correlationId),
            eq(events.eventType, 'wait_completed'),
          ),
        )
        .limit(1);
      if (completed) {
        throw new EntityConflictError(`Wait "${values.correlationId}" already completed`);
      }
    }
    try {
      const [inserted] = await tx
        .insert(events)
        .values({ ...values, eventId })
        .returning({ createdAt: events.createdAt, occurredAt: events.occurredAt });
      return { eventId, ...inserted! };
    } catch (err) {
      throw entityCreationConflict(err, values) ?? err;
    }
  }

  /** {@link insertEvent} in a transaction of its own. */
  function appendEvent(values: EventRowInsert) {
    return drizzle.transaction((tx) => insertEvent(tx, values));
  }

  /**
   * The report half of bump-and-report: the events on the slots between the
   * one the writer expected (`eventCount + 1`) and the one its write landed on.
   * Undefined when the write took the slot it asked for, or the caller sent no
   * count. Slots commit in order under the run row lock, so the span is
   * complete by the time the write that skipped it has committed.
   */
  async function reportSkippedSlots(
    runId: string,
    committedEventId: string,
    eventCount: number | undefined,
    resolveData: EventsResolveData,
  ): Promise<{ events: Event[]; cursor: string | null; hasMore: boolean } | undefined> {
    const committedSlot = eventIdToSlot(committedEventId);
    if (eventCount === undefined || committedSlot === null || committedSlot <= eventCount + 1) {
      return undefined;
    }
    const rows = await drizzle
      .select()
      .from(events)
      .where(
        and(
          eq(events.runId, runId),
          gt(events.eventId, slotToEventId(Math.max(eventCount, 0))),
          lt(events.eventId, committedEventId),
        ),
      )
      .orderBy(events.eventId);
    if (rows.length === 0) return undefined;
    return {
      events: rows.map((row) => {
        row.eventData ||= row.eventDataJson;
        return stripEventDataRefs(EventSchema.parse(compact(row)), resolveData);
      }),
      cursor: rows.at(-1)!.eventId,
      hasMore: false,
    };
  }

  /** Attaches the {@link reportSkippedSlots} span, if any, to a create's result. */
  async function withSkippedSlots(
    result: EventResult,
    runId: string,
    committedEventId: string,
    eventCount: number | undefined,
    resolveData: EventsResolveData,
  ): Promise<EventResult> {
    const skipped = await reportSkippedSlots(runId, committedEventId, eventCount, resolveData);
    return skipped ? { ...result, ...skipped } : result;
  }

  return {
    async create(
      runId: string | null,
      data: AnyEventRequest,
      params?: CreateEventParams,
    ): Promise<EventResult> {
      // Event pages may skip step inputs; entity reads take the plain form.
      const eventsResolveData: EventsResolveData = params?.resolveData ?? 'all';
      const resolveData = entityResolveData(eventsResolveData);

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
          attributes?: Record<string, string>;
        };
        const { deploymentId, workflowName } = runInputData;
        if (deploymentId && workflowName && runInputData.input !== undefined) {
          // Create run + synthetic run_created event atomically so we never
          // leave an orphaned run without its run_created event; it takes the
          // run's first slot.
          const runValue = await drizzle.transaction(async (tx) => {
            const [inserted] = await tx
              .insert(Schema.runs)
              .values({
                runId: effectiveRunId,
                deploymentId,
                workflowName,
                input: runInputData.input as SerializedContent,
                executionContext: runInputData.executionContext as SerializedContent | undefined,
                attributes: runInputData.attributes,
                status: 'pending',
                specVersion: effectiveSpecVersion,
              })
              .onConflictDoNothing()
              .returning();
            if (inserted) {
              await insertEvent(tx, {
                runId: effectiveRunId,
                eventType: 'run_created',
                eventData: {
                  deploymentId: runInputData.deploymentId,
                  workflowName: runInputData.workflowName,
                  input: runInputData.input,
                  executionContext: runInputData.executionContext,
                  attributes: runInputData.attributes,
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

      // Lazy step start: a step_started carrying step-creation data (stepName
      // + input) may arrive with no prior step_created. It creates the step
      // and a synthetic step_created event in the same transaction as the
      // start, and the step INSERT is the ownership claim: a caller that finds
      // the step already created lost, and must not run the body.
      const createsChildEntity = isChildEntityCreationEvent(data);
      const lazyStepStart = createsChildEntity && data.eventType === 'step_started';

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
          const value = await appendEvent({
            runId: effectiveRunId,
            correlationId: data.correlationId,
            eventType: data.eventType,
            eventData: 'eventData' in data ? data.eventData : undefined,
            occurredAt: params?.occurredAt,
            specVersion: effectiveSpecVersion,
          });

          const result = {
            ...data,
            ...compact(value),
            runId: effectiveRunId,
          };
          const parsed = EventSchema.parse(result);
          return withSkippedSlots(
            {
              event: stripEventDataRefs(parsed, resolveData),
              run: fullRun
                ? (() => {
                    fullRun.output ||= fullRun.outputJson;
                    fullRun.input ||= fullRun.inputJson;
                    fullRun.executionContext ||= fullRun.executionContextJson;
                    restoreError(fullRun);
                    return deserializeRunError(compact(fullRun));
                  })()
                : undefined,
              ...(fullRun ? { maxEvents } : {}),
            },
            effectiveRunId,
            value.eventId,
            params?.eventCount,
            eventsResolveData,
          );
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

        // Creating new entities on terminal runs is not allowed, and a lazy
        // step_started creates one.
        if (createsChildEntity) {
          throw new EntityConflictError(
            `Cannot create new entities on run in terminal state "${currentRun.status}"`,
          );
        }

        if (data.eventType === 'attr_set') {
          throw new EntityConflictError(
            `Cannot set attributes on run in terminal state "${currentRun.status}"`,
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

        if (!validatedStep && !lazyStepStart) {
          throw new WorkflowWorldError(`Step "${data.correlationId}" not found`, { status: 404 });
        }
        if (lazyStepStart && validatedStep) {
          throw new EntityConflictError(`Step "${data.correlationId}" already created`);
        }
      }
      if (validatedStep) {
        if (isStepTerminal(validatedStep.status)) {
          throw new EntityConflictError(
            `Cannot modify step in terminal state "${validatedStep.status}"`,
          );
        }

        // On terminal runs: only allow completing/failing in-progress steps.
        // A step_started is refused even when the step still reads `running`:
        // that is a redelivery of a start an earlier delivery already
        // claimed, and nothing would ever read the outcome of running the
        // body again.
        if (currentRun && isRunTerminal(currentRun.status)) {
          if (data.eventType === 'step_started' || validatedStep.status !== 'running') {
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
          attributes?: Record<string, string>;
        };
        const [runValue] = await drizzle
          .insert(Schema.runs)
          .values({
            runId: effectiveRunId,
            deploymentId: eventData.deploymentId,
            workflowName: eventData.workflowName,
            input: eventData.input as SerializedContent,
            executionContext: eventData.executionContext as SerializedContent | undefined,
            attributes: eventData.attributes,
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
        restoreError(runValue);
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
            restoreError(existingRun);
            run = deserializeRunError(compact(existingRun));
          }
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
          restoreError(runValue);
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
          restoreError(runValue);
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
        // The error is the thrown value as the runtime serialized it;
        // consumers hydrate it, so it is stored verbatim.
        const eventData = data.eventData as { error: unknown; errorCode?: string };
        const [runValue] = await drizzle
          .update(Schema.runs)
          .set({
            status: 'failed',
            error: eventData.error,
            errorCode: eventData.errorCode,
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
          restoreError(runValue);
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
          restoreError(runValue);
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

      // Strip eventData from run_started; it belongs on run_created only. A
      // lazy step_started keeps its stepName (replay checks it) but drops the
      // input, which lives on the synthetic step_created.
      let storedEventData: unknown =
        data.eventType === 'run_started'
          ? undefined
          : 'eventData' in data
            ? data.eventData
            : undefined;
      if (lazyStepStart) {
        const { input: _input, ...rest } = data.eventData as Record<string, unknown>;
        storedEventData = rest;
      }

      // Populated by the step_started transaction below (which writes its own
      // event log entry in the same transaction as the guarded step UPDATE);
      // the shared insert further down is skipped when this is already set.
      let value: { eventId: string; createdAt: Date; occurredAt: Date | null } | undefined;

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
          restoreError(stepValue);
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
            restoreError(existingStep);
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
          if (lazyStepStart) {
            const lazyData = data.eventData as { stepName: string; input: unknown };
            const [claimed] = await tx
              .insert(Schema.steps)
              .values({
                runId: effectiveRunId,
                stepId: data.correlationId!,
                stepName: lazyData.stepName,
                input: lazyData.input as SerializedContent,
                status: 'pending',
                attempt: 0,
                specVersion: effectiveSpecVersion,
              })
              .onConflictDoNothing()
              .returning({ stepId: Schema.steps.stepId });
            if (!claimed) {
              throw new EntityConflictError(`Step "${data.correlationId}" already created`);
            }
            // Replay still needs to see step_created before step_started; it
            // commits with the step row and the start, or not at all.
            await insertEvent(tx, {
              runId: effectiveRunId,
              correlationId: data.correlationId,
              eventType: 'step_created',
              eventData: { stepName: lazyData.stepName, input: lazyData.input },
              specVersion: effectiveSpecVersion,
            });
          }

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
            restoreError(stepValue);
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

          // Take the step_started slot only after the guarded step UPDATE has
          // acquired and passed the row lock, so a writer blocked on the step
          // row cannot carry an earlier position into a later insert.
          return insertEvent(tx, {
            runId: effectiveRunId,
            correlationId: data.correlationId,
            eventType: data.eventType,
            eventData: storedEventData,
            occurredAt: params?.occurredAt,
            specVersion: effectiveSpecVersion,
          });
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
          restoreError(stepValue);
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
          error?: unknown;
        };

        const [stepValue] = await drizzle
          .update(Schema.steps)
          .set({
            status: 'failed',
            error: eventData?.error,
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
          restoreError(stepValue);
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
          error?: unknown;
          retryAfter?: Date;
        };

        const [stepValue] = await drizzle
          .update(Schema.steps)
          .set({
            status: 'pending',
            error: eventData?.error,
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
          restoreError(stepValue);
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

          const conflictValue = await appendEvent({
            runId: effectiveRunId,
            correlationId: data.correlationId,
            eventType: 'hook_conflict',
            eventData: conflictEventData,
            occurredAt: params?.occurredAt,
            specVersion: effectiveSpecVersion,
          });

          const conflictResult = {
            eventType: 'hook_conflict' as const,
            correlationId: data.correlationId,
            eventData: conflictEventData,
            ...compact(conflictValue),
            runId: effectiveRunId,
          };
          const parsedConflict = EventSchema.parse(conflictResult);
          return withSkippedSlots(
            {
              event: stripEventDataRefs(parsedConflict, resolveData),
              run,
              step,
              hook: undefined,
              ...(run ? { maxEvents } : {}),
            },
            effectiveRunId,
            conflictValue.eventId,
            params?.eventCount,
            eventsResolveData,
          );
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

      // Handle attr_set event: apply the changes to the run's attributes under
      // the run row lock, so concurrent attribute writes cannot lose one
      // another's changes.
      if (data.eventType === 'attr_set') {
        const { changes, allowReservedAttributes } = data.eventData;
        const [runValue] = await drizzle.transaction(async (tx) => {
          const [existing] = await tx
            .select({ attributes: Schema.runs.attributes })
            .from(Schema.runs)
            .where(eq(Schema.runs.runId, effectiveRunId))
            .limit(1)
            .for('update');
          if (!existing) {
            throw new WorkflowRunNotFoundError(effectiveRunId);
          }
          validateAttributeChanges(changes, {
            existingKeys: Object.keys(existing.attributes ?? {}),
            allowReservedAttributes: allowReservedAttributes === true,
          });
          return tx
            .update(Schema.runs)
            .set({
              attributes: applyAttributeChanges(existing.attributes ?? undefined, changes),
              updatedAt: now,
            })
            .where(eq(Schema.runs.runId, effectiveRunId))
            .returning();
        });
        if (runValue) {
          runValue.output ||= runValue.outputJson;
          runValue.input ||= runValue.inputJson;
          runValue.executionContext ||= runValue.executionContextJson;
          restoreError(runValue);
          run = deserializeRunError(compact(runValue));
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
        value = await appendEvent({
          runId: effectiveRunId,
          correlationId: data.correlationId,
          eventType: data.eventType,
          eventData: storedEventData,
          occurredAt: params?.occurredAt,
          specVersion: effectiveSpecVersion,
        });
      }
      const result = { ...data, ...compact(value), runId: effectiveRunId };
      if (data.eventType === 'run_started') {
        delete (result as any).eventData;
      }
      const parsed = EventSchema.parse(result);

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
          return stripEventDataRefs(p, eventsResolveData);
        });
      }

      const created: EventResult = {
        event: stripEventDataRefs(parsed, resolveData),
        // The lazy start that created the step owns it; losers got
        // EntityConflictError above.
        ...(lazyStepStart ? { stepCreated: true as const } : {}),
        run,
        step,
        hook,
        ...(run ? { maxEvents } : {}),
      };
      // The run_started preload already carries the whole log, which covers
      // any span this write skipped.
      if (allEvents) {
        return {
          ...created,
          events: allEvents,
          cursor: allEvents.at(-1)?.eventId ?? null,
          hasMore: false,
        };
      }
      return withSkippedSlots(
        created,
        effectiveRunId,
        value.eventId,
        params?.eventCount,
        eventsResolveData,
      );
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
  } as Storage['events'];
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
      restoreError(value);
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
          restoreError(v);
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

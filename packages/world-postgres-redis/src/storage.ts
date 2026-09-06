import {
  EntityConflictError,
  HookNotFoundError,
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
  Hook,
  ListEventsParams,
  ListHooksParams,
  PaginatedResponse,
  ResolveData,
  RunCreatedEventRequest,
  Step,
  StepWithoutData,
  Storage,
  Wait,
  WorkflowRun,
  WorkflowRunWithoutData,
} from '@workflow/world';
import {
  ATTRIBUTE_MAX_PER_RUN,
  AttributeValidationError,
  EVENT_ID_BODY_LENGTH,
  EVENT_ID_PREFIX,
  EventSchema,
  eventIdToSlot,
  FIRST_EVENT_SLOT,
  HookSchema,
  isChildEntityCreationEvent,
  isChildEntityCreationEventType,
  isHookEventRequiringExistence,
  isLegacySpecVersion,
  isTerminalRunEventType,
  isTerminalStepStatus,
  isTerminalWorkflowRunStatus,
  requiresNewerWorld,
  SPEC_VERSION_CURRENT,
  slotToEventId,
  StepSchema,
  stripEventDataRefs,
  TERMINAL_STEP_STATUSES,
  TERMINAL_WORKFLOW_RUN_STATUSES,
  validateAttributeChanges,
  validateUlidTimestamp,
  WaitSchema,
  WorkflowRunSchema,
} from '@workflow/world';
import { and, desc, eq, gt, lt, notInArray, type SQL, sql } from 'drizzle-orm';
import { monotonicFactory } from 'ulid';
import { type Drizzle, Schema } from './drizzle/index.js';
import type { SerializedContent } from './drizzle/schema.js';
import { compact } from './util.js';

// A drizzle client or an open transaction on one; lets the slot-allocating
// event insert run inside entity-guarding transactions as well as standalone.
type DrizzleOrTx = Drizzle | Parameters<Parameters<Drizzle['transaction']>[0]>[0];

/** Per-run event ceiling reported on `run_started`. The runtime fails the run
 * with `MAX_EVENTS_EXCEEDED` once the replay log reaches it. */
const DEFAULT_MAX_EVENTS_PER_RUN = 25_000;

/** Only for legacy (pre-slot) runs; see {@link allocateEventId}. */
const legacyEventUlid = monotonicFactory();

/** How many positions one insert tries before giving up. Reached only when a
 * run takes concurrent writes faster than any of them can commit. */
const SLOT_INSERT_MAX_ATTEMPTS = 40;
/**
 * Collisions that retry the instant the conflicting writer settles.
 * `ON CONFLICT DO NOTHING` waits on the conflicting writer's transaction
 * before reporting the conflict, so a lost race has already waited for the
 * thing the next position depends on; sleeping on top adds nothing. The
 * backoff below covers writers that keep arriving while the loop spins.
 */
const SLOT_INSERT_IMMEDIATE_ATTEMPTS = 8;
const SLOT_INSERT_BASE_DELAY_MS = 2;
const SLOT_INSERT_MAX_DELAY_MS = 40;

/**
 * Isolation for every transaction an event insert can run inside. A collision
 * retry only terminates if it can see rows committed since the transaction
 * began; REPEATABLE READ and above re-read the original snapshot and loop to
 * the limit. READ COMMITTED is Postgres' default, so this pins the requirement
 * against databases whose default_transaction_isolation was raised.
 */
const SLOT_INSERT_TRANSACTION = { isolationLevel: 'read committed' } as const;

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

/** The pg error behind a drizzle wrapper, or an empty shape if there is none. */
function pgErrorOf(err: unknown): { code?: string; constraint?: string; constraint_name?: string } {
  const direct = err as { code?: string };
  if (direct?.code) {
    return direct;
  }
  return ((err as { cause?: { code?: string } })?.cause ?? {}) as {
    code?: string;
    constraint?: string;
  };
}

function pgConstraintOf(err: unknown): string | undefined {
  const pgErr = pgErrorOf(err);
  return pgErr.constraint_name ?? pgErr.constraint;
}

/**
 * The position a slot-numbered insert takes: one above the highest the run
 * already holds, read inside the INSERT that takes it. Nothing hands out a
 * position ahead of the write that fills it, so a rolled-back writer leaves
 * the numbering untouched and the log stays dense.
 *
 * The subquery is an index-only read of the composite primary key's last row
 * for the run. Ordering is lexicographic, which equals positional order
 * because every body is zero-padded to a fixed width.
 *
 * The substring start is cast via sql.raw of a constant: an untyped parameter
 * would resolve `substring(text from $n)` to the regex overload, which
 * silently returns NULL and hands every writer the first slot.
 */
function nextSlotId(runId: string): SQL<string> {
  const bodyFrom = sql.raw(String(EVENT_ID_PREFIX.length + 1));
  const width = sql.raw(String(EVENT_ID_BODY_LENGTH));
  const noEvents = sql.raw(String(FIRST_EVENT_SLOT - 1));
  return sql<string>`${EVENT_ID_PREFIX} || lpad((coalesce((select cast(substring(prev.id from ${bodyFrom}) as bigint) from ${Schema.events} prev where prev.run_id = ${runId} order by prev.id desc limit 1), ${noEvents}) + 1)::text, ${width}, '0')`;
}

/**
 * The id an insert for `runId` should allocate with: a slot expression for a
 * slot-numbered run, a fresh ULID for one that predates slots. A row in
 * `workflow_event_slots` is the marker for the first case. A legacy run keeps
 * the original `wevt_` prefix: a mid-life change would sort every new event
 * before every old one, since `evnt_` < `wevt_`.
 */
async function allocateEventId(db: DrizzleOrTx, runId: string): Promise<string | SQL<string>> {
  const [row] = await db
    .select({ runId: Schema.eventSlots.runId })
    .from(Schema.eventSlots)
    .where(eq(Schema.eventSlots.runId, runId))
    .limit(1);
  return row ? nextSlotId(runId) : `wevt_${legacyEventUlid()}`;
}

interface EventInsertValues {
  runId: string;
  eventId: string | SQL<string>;
  eventType: Event['eventType'];
  correlationId?: string | null;
  eventData?: unknown;
  occurredAt?: Date;
  specVersion?: number;
}

interface InsertedEventRow {
  eventId: string;
  createdAt: Date;
  occurredAt: Date | null;
}

/**
 * Inserts one event row, retrying while the position it computed is taken.
 * The primary-key conflict is absorbed by `ON CONFLICT DO NOTHING` rather
 * than raised, so a lost race costs a retry instead of poisoning the
 * enclosing transaction. Every other unique violation still raises, which is
 * what lets callers translate a dedup conflict on
 * `workflow_events_entity_creation_unique`.
 *
 * Returns `undefined` only for a fixed string id (a legacy ULID, or the
 * reserved first slot), where a conflict is the caller's answer.
 */
async function insertEventRow(
  db: DrizzleOrTx,
  values: EventInsertValues,
): Promise<InsertedEventRow | undefined> {
  const allocates = typeof values.eventId !== 'string';
  for (let attempt = 0; ; attempt++) {
    const [row] = await db
      .insert(Schema.events)
      .values(values)
      .onConflictDoNothing({ target: [Schema.events.runId, Schema.events.eventId] })
      .returning({
        eventId: Schema.events.eventId,
        createdAt: Schema.events.createdAt,
        occurredAt: Schema.events.occurredAt,
      });
    if (row) {
      return row;
    }
    if (!allocates || attempt >= SLOT_INSERT_MAX_ATTEMPTS) {
      if (!allocates) {
        return undefined;
      }
      throw new WorkflowWorldError(
        `Could not allocate an event slot for run "${values.runId}" after ${SLOT_INSERT_MAX_ATTEMPTS} attempts`,
        { status: 503 },
      );
    }
    if (attempt >= SLOT_INSERT_IMMEDIATE_ATTEMPTS) {
      const delay = Math.min(
        SLOT_INSERT_MAX_DELAY_MS,
        SLOT_INSERT_BASE_DELAY_MS * 2 ** (attempt - SLOT_INSERT_IMMEDIATE_ATTEMPTS),
      );
      await new Promise((resolve) => setTimeout(resolve, Math.random() * delay));
    }
  }
}

/**
 * Marks a run being created as slot-numbered and returns its first event id.
 * `DO NOTHING` on conflict because the arbitration that matters is the event
 * insert: two writers racing one run_created both take the first slot, and
 * the composite events primary key rejects the loser.
 */
async function openEventSlots(db: DrizzleOrTx, runId: string): Promise<string> {
  await db.insert(Schema.eventSlots).values({ runId }).onConflictDoNothing();
  return slotToEventId(FIRST_EVENT_SLOT);
}

/**
 * The report half of bump-and-report: the events sitting on the slots between
 * the one the writer asked for and the one its write landed on. Returns
 * `undefined` when there is nothing to report. The set can be short of the
 * span it covers when a concurrent lower-slot writer has not committed yet;
 * `hasMore` marks the report as a lower bound, and it is advisory either way.
 */
async function reportSkippedSlots(
  db: Drizzle,
  runId: string,
  committedEventId: string,
  askedFor: number,
  resolveData: ResolveData,
): Promise<{ events: Event[]; hasMore: boolean } | undefined> {
  const committedSlot = eventIdToSlot(committedEventId);
  if (committedSlot === null || askedFor < FIRST_EVENT_SLOT || committedSlot <= askedFor + 1) {
    return undefined;
  }
  const rows = await db
    .select()
    .from(Schema.events)
    .where(
      and(
        eq(Schema.events.runId, runId),
        gt(Schema.events.eventId, slotToEventId(askedFor)),
        lt(Schema.events.eventId, committedEventId),
      ),
    )
    .orderBy(Schema.events.eventId);
  const events = rows.map((row) => {
    row.eventData ||= row.eventDataJson;
    return stripEventDataRefs(EventSchema.parse(compact(row)), resolveData);
  });
  return {
    events,
    hasMore: events.length < committedSlot - askedFor - 1,
  };
}

type RunRow = typeof Schema.runs.$inferSelect;
type StepRow = typeof Schema.steps.$inferSelect;
type HookRow = typeof Schema.hooks.$inferSelect;
type WaitRow = typeof Schema.waits.$inferSelect;

function rowToRun(value: RunRow): WorkflowRun {
  // Widened copy: CBOR columns fall back to the deprecated JSON columns for
  // rows written before the CBOR migration.
  const raw: Record<string, unknown> = { ...value };
  raw.output ||= value.outputJson;
  raw.input ||= value.inputJson;
  raw.executionContext ||= value.executionContextJson;
  return WorkflowRunSchema.parse(compact(raw));
}

function rowToStep(value: StepRow): Step {
  const raw: Record<string, unknown> = { ...value };
  raw.output ||= value.outputJson;
  raw.input ||= value.inputJson;
  return StepSchema.parse(compact(raw));
}

function rowToHook(value: HookRow): Hook {
  const raw: Record<string, unknown> = { ...value };
  raw.metadata ||= value.metadataJson;
  return HookSchema.parse(compact(raw));
}

function rowToWait(value: WaitRow): Wait {
  return WaitSchema.parse(compact(value));
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
      const parsed = rowToRun(value);
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
        data: values.map((v) => filterRunData(rowToRun(v), resolveData)),
        hasMore,
        cursor: values.at(-1)?.runId ?? null,
      };
    }) as Storage['runs']['list'],
    experimentalSetAttributes: async (runId, changes, options) => {
      // The read exists so the validator can produce a precise error (cap,
      // duplicate keys, reserved prefix). The authoritative cap enforcement
      // is the guarded UPDATE below, so the read-update race cannot push the
      // row past the per-run cap.
      const [existing] = await drizzle
        .select({ attributes: runs.attributes })
        .from(runs)
        .where(eq(runs.runId, runId))
        .limit(1);
      if (!existing) {
        throw new WorkflowRunNotFoundError(runId);
      }
      validateAttributeChanges(changes, {
        existingKeys: Object.keys(existing.attributes ?? {}),
        allowReservedAttributes: options?.allowReservedAttributes,
      });
      const expr = attributeMergeExpr(changes);
      const [updated] = await drizzle
        .update(runs)
        .set({ attributes: expr, updatedAt: new Date() })
        .where(
          and(
            eq(runs.runId, runId),
            sql`(SELECT COUNT(*) FROM jsonb_object_keys(${expr})) <= ${ATTRIBUTE_MAX_PER_RUN}`,
          ),
        )
        .returning({ attributes: runs.attributes });
      if (!updated) {
        const [stillExists] = await drizzle
          .select({ runId: runs.runId })
          .from(runs)
          .where(eq(runs.runId, runId))
          .limit(1);
        if (!stillExists) {
          throw new WorkflowRunNotFoundError(runId);
        }
        throw new AttributeValidationError(
          `Run attribute count would exceed limit ${ATTRIBUTE_MAX_PER_RUN} after concurrent write`,
        );
      }
      return { attributes: updated.attributes ?? {} };
    },
  };
}

/** Folds attribute changes into one SQL expression: sets nest `jsonb_set`
 * calls, removes chain the jsonb `-` delete operator. */
function attributeMergeExpr(changes: { key: string; value: string | null }[]): SQL {
  let expr = sql`COALESCE(${Schema.runs.attributes}, '{}'::jsonb)`;
  for (const { key, value } of changes) {
    if (value === null) {
      expr = sql`${expr} - ${key}`;
    } else {
      expr = sql`jsonb_set(${expr}, ARRAY[${key}]::text[], to_jsonb(${value}::text), true)`;
    }
  }
  return expr;
}

function map<T, R>(obj: T | null | undefined, fn: (v: T) => R): undefined | R {
  return obj ? fn(obj) : undefined;
}

/**
 * Handle events for legacy runs (pre-event-sourcing, specVersion < 2), which
 * are ULID-numbered by definition and keep that scheme:
 * - run_cancelled: skip event storage, directly update the run
 * - wait_completed / hook_received: store event only (no entity mutation)
 * - other events: not supported
 */
async function handleLegacyEvent(
  drizzle: Drizzle,
  runId: string,
  eventId: string,
  data: CreateEventRequest,
  params: CreateEventParams | undefined,
): Promise<EventResult> {
  const resolveData = params?.resolveData ?? 'all';
  switch (data.eventType) {
    case 'run_cancelled': {
      const now = new Date();
      await drizzle
        .update(Schema.runs)
        .set({ status: 'cancelled', completedAt: now, updatedAt: now })
        .where(eq(Schema.runs.runId, runId));
      await Promise.all([
        drizzle.delete(Schema.hooks).where(eq(Schema.hooks.runId, runId)),
        drizzle.delete(Schema.waits).where(eq(Schema.waits.runId, runId)),
      ]);
      const [updatedRun] = await drizzle
        .select()
        .from(Schema.runs)
        .where(eq(Schema.runs.runId, runId))
        .limit(1);
      // Legacy behavior skips event storage and returns without an event.
      return {
        run: updatedRun
          ? (filterRunData(rowToRun(updatedRun), resolveData) as WorkflowRun)
          : undefined,
      };
    }
    case 'wait_completed':
    case 'hook_received': {
      const insertLegacyEvent = (tx: DrizzleOrTx) =>
        tx
          .insert(Schema.events)
          .values({
            runId,
            eventId,
            correlationId: data.correlationId,
            eventType: data.eventType,
            eventData: 'eventData' in data ? data.eventData : undefined,
            specVersion: SPEC_VERSION_CURRENT,
          })
          .returning({ createdAt: Schema.events.createdAt });

      // hook_received guards against a concurrent terminal transition:
      // FOR UPDATE takes the run row lock, blocking until any in-flight
      // terminal UPDATE commits, then observes the post-commit status.
      const [insertedEvent] =
        data.eventType === 'hook_received'
          ? await drizzle.transaction(async (tx) => {
              const [runRow] = await tx
                .select({ status: Schema.runs.status })
                .from(Schema.runs)
                .where(eq(Schema.runs.runId, runId))
                .for('update')
                .limit(1);
              if (!runRow) {
                throw new WorkflowRunNotFoundError(runId);
              }
              if (isTerminalWorkflowRunStatus(runRow.status)) {
                throw new RunExpiredError(
                  `Workflow run "${runId}" is already in terminal state "${runRow.status}"`,
                );
              }
              return insertLegacyEvent(tx);
            }, SLOT_INSERT_TRANSACTION)
          : await insertLegacyEvent(drizzle);

      const result = { ...data, ...compact(insertedEvent), runId, eventId };
      const parsed = EventSchema.parse(result);
      return { event: stripEventDataRefs(parsed, resolveData) };
    }
    default:
      throw new WorkflowWorldError(
        `Event type "${data.eventType}" is not supported for legacy workflow runs`,
        { status: 400 },
      );
  }
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
      specVersion: Schema.runs.specVersion,
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

  const getWaitForValidation = drizzle
    .select({ status: Schema.waits.status })
    .from(Schema.waits)
    .where(eq(Schema.waits.waitId, sql.placeholder('waitId')))
    .limit(1)
    .prepare('events_get_wait_for_validation');

  const create = (async (
    runId: string | null,
    data: RunCreatedEventRequest | CreateEventRequest,
    params?: CreateEventParams,
  ): Promise<EventResult> => {
    // The id this call's event took, known only once its insert has
    // committed: on a slot-numbered run the position is chosen inside the
    // INSERT, so there is nothing to read before it.
    let eventId: string | undefined;
    // Lazy: on a legacy run this mints a ULID, on a slot run it reads which
    // scheme applies. run_created fixes the id up front (first slot).
    const getEventId = async (db: DrizzleOrTx = drizzle) =>
      eventId ?? (await allocateEventId(db, effectiveRunId));

    // For run_created events, generate runId server-side if null or empty
    let effectiveRunId: string;
    if (data.eventType === 'run_created' && (!runId || runId === '')) {
      effectiveRunId = `wrun_${ulid()}`;
    } else if (!runId) {
      throw new Error('runId is required for non-run_created events');
    } else {
      effectiveRunId = runId;
    }

    // Validate a client-provided runId's timestamp is within threshold
    if (data.eventType === 'run_created' && runId && runId !== '') {
      const validationError = validateUlidTimestamp(effectiveRunId, 'wrun_');
      if (validationError) {
        throw new WorkflowWorldError(validationError);
      }
    }

    // specVersion is always sent by the runtime, but we provide a fallback for safety
    const effectiveSpecVersion = data.specVersion ?? SPEC_VERSION_CURRENT;

    // Track entity created/updated for EventResult
    let run: WorkflowRun | undefined;
    let step: Step | undefined;
    let hook: Hook | undefined;
    let wait: Wait | undefined;
    // Lazy step start: true when this step_started atomically created the
    // step. Surfaced as the runtime's exactly-once inline-ownership signal.
    let stepCreatedLazily = false;
    const now = new Date();

    const terminalStepStatuses = [...TERMINAL_STEP_STATUSES];

    // ============================================================
    // VALIDATION: Terminal state and event ordering checks
    // ============================================================

    // Skip run validation for step_completed and step_retrying: they only
    // operate on running steps, which stay writable regardless of run state.
    let currentRun: { status: string; specVersion: number | null } | null = null;
    const skipRunValidationEvents = ['step_completed', 'step_retrying'];
    if (data.eventType !== 'run_created' && !skipRunValidationEvents.includes(data.eventType)) {
      const [runValue] = await getRunForValidation.execute({ runId: effectiveRunId });
      currentRun = runValue ?? null;

      // Resilient start: run_started on a non-existent run with eventData
      // bootstraps the run, so the queue can recover a run whose creation
      // failed transiently during start().
      if (
        data.eventType === 'run_started' &&
        !currentRun &&
        'eventData' in data &&
        data.eventData
      ) {
        const runInputData = data.eventData;
        if (
          runInputData.deploymentId &&
          runInputData.workflowName &&
          runInputData.input !== undefined
        ) {
          validateAttributeChanges(
            Object.entries(runInputData.attributes ?? {}).map(([key, value]) => ({ key, value })),
            { allowReservedAttributes: runInputData.allowReservedAttributes === true },
          );
          const [inserted] = await drizzle
            .insert(Schema.runs)
            .values({
              runId: effectiveRunId,
              deploymentId: runInputData.deploymentId,
              workflowName: runInputData.workflowName,
              specVersion: effectiveSpecVersion,
              input: runInputData.input as SerializedContent,
              executionContext: runInputData.executionContext,
              attributes: runInputData.attributes,
              encryptionPublicKey: runInputData.encryptionPublicKey,
              status: 'pending',
            })
            .onConflictDoNothing()
            .returning({ runId: Schema.runs.runId });
          if (inserted) {
            // The synthetic run_created is the run's first event, so it opens
            // the slot marker the rest of the run allocates from.
            const runCreatedEventId = await openEventSlots(drizzle, effectiveRunId);
            await drizzle.insert(events).values({
              runId: effectiveRunId,
              eventId: runCreatedEventId,
              eventType: 'run_created',
              eventData: {
                deploymentId: runInputData.deploymentId,
                workflowName: runInputData.workflowName,
                input: runInputData.input,
                executionContext: runInputData.executionContext,
                attributes: runInputData.attributes,
                allowReservedAttributes: runInputData.allowReservedAttributes,
                encryptionPublicKey: runInputData.encryptionPublicKey,
              },
              specVersion: effectiveSpecVersion,
            });
            currentRun = { status: 'pending', specVersion: effectiveSpecVersion };
          } else {
            // Run already exists (concurrent run_created won the race):
            // re-read so downstream logic sees the real state.
            const [existingRun] = await getRunForValidation.execute({ runId: effectiveRunId });
            currentRun = existingRun ?? null;
          }
        }
      }
    }

    // ============================================================
    // VERSION COMPATIBILITY: Check run spec version
    // ============================================================
    if (currentRun) {
      const runSpecVersion = currentRun.specVersion;
      if (typeof runSpecVersion === 'number' && requiresNewerWorld(runSpecVersion)) {
        throw new RunNotSupportedError(runSpecVersion, SPEC_VERSION_CURRENT);
      }
      // Legacy (pre-event-sourcing) runs are ULID-numbered by definition, so
      // the id is minted here rather than read out of a slot marker.
      if (isLegacySpecVersion(currentRun.specVersion ?? undefined)) {
        return handleLegacyEvent(
          drizzle,
          effectiveRunId,
          `wevt_${legacyEventUlid()}`,
          data as CreateEventRequest,
          params,
        );
      }
    }

    if (!currentRun && (data.eventType === 'attr_set' || data.eventType === 'run_started')) {
      throw new WorkflowRunNotFoundError(effectiveRunId);
    }

    // Lazy step start: a step_started carrying step-creation data (stepName +
    // input) may arrive with no prior step_created and creates the step on
    // the fly, mirroring the resilient run_started path.
    const createsChildEntity = isChildEntityCreationEvent(data);
    const lazyStepStart = createsChildEntity && data.eventType === 'step_started';

    // Run terminal state validation
    if (currentRun && isTerminalWorkflowRunStatus(currentRun.status)) {
      // Idempotent operation: run_cancelled on already cancelled run is allowed
      if (data.eventType === 'run_cancelled' && currentRun.status === 'cancelled') {
        const [fullRun] = await drizzle
          .select()
          .from(Schema.runs)
          .where(eq(Schema.runs.runId, effectiveRunId))
          .limit(1);

        const value = await insertEventRow(drizzle, {
          runId: effectiveRunId,
          eventId: await getEventId(),
          correlationId: data.correlationId,
          eventType: data.eventType,
          eventData: 'eventData' in data ? data.eventData : undefined,
          occurredAt: params?.occurredAt,
          specVersion: effectiveSpecVersion,
        });
        if (!value) {
          throw new EntityConflictError(
            `run_cancelled for run "${effectiveRunId}" could not be created`,
          );
        }

        const result = { ...data, ...compact(value), runId: effectiveRunId };
        const parsed = EventSchema.parse(result);
        const resolveData = params?.resolveData ?? 'all';
        return {
          event: stripEventDataRefs(parsed, resolveData),
          run: fullRun ? rowToRun(fullRun) : undefined,
        };
      }

      // For run_started on terminal runs, use RunExpiredError so the
      // runtime knows to exit without retrying.
      if (data.eventType === 'run_started') {
        throw new RunExpiredError(
          `Workflow run "${effectiveRunId}" is already in terminal state "${currentRun.status}"`,
        );
      }

      if (isTerminalRunEventType(data.eventType)) {
        throw new EntityConflictError(
          `Cannot transition run from terminal state "${currentRun.status}"`,
        );
      }

      // Creating new entities on terminal runs is not allowed. A lazy
      // step_started creates a step, so it is rejected here too.
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

    // Step-related event validation (ordering and terminal state)
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

      // Event ordering: step must exist before these events, except on the
      // lazy-start path, where step_started creates the step itself.
      if (!validatedStep && !lazyStepStart) {
        throw new WorkflowWorldError(`Step "${data.correlationId}" not found`, { status: 404 });
      }

      // Lazy start exactly-once gate: if the step already exists, a
      // concurrent handler won the create. This caller must not start or run
      // the step; executeStep maps EntityConflictError to `skipped`.
      if (lazyStepStart && validatedStep) {
        throw new EntityConflictError(`Step "${data.correlationId}" already created`);
      }

      if (validatedStep) {
        if (isTerminalStepStatus(validatedStep.status)) {
          throw new EntityConflictError(
            `Cannot modify step in terminal state "${validatedStep.status}"`,
          );
        }
        // On terminal runs: only allow completing/failing in-progress steps
        if (currentRun && isTerminalWorkflowRunStatus(currentRun.status)) {
          if (validatedStep.status !== 'running') {
            throw new RunExpiredError(
              `Cannot modify non-running step on run in terminal state "${currentRun.status}"`,
            );
          }
        }
      }
    }

    // Hook-related event validation (existence). An unlocked read, so it only
    // settles the case where the hook was already gone when the request
    // arrived; the hook_disposed and hook_received branches below take the
    // hook's row lock for the ordering that matters.
    if (isHookEventRequiringExistence(data.eventType) && data.correlationId) {
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
      const eventData = data.eventData;
      validateAttributeChanges(
        Object.entries(eventData.attributes ?? {}).map(([key, value]) => ({ key, value })),
        { allowReservedAttributes: eventData.allowReservedAttributes === true },
      );
      const [runValue] = await drizzle
        .insert(Schema.runs)
        .values({
          runId: effectiveRunId,
          deploymentId: eventData.deploymentId,
          workflowName: eventData.workflowName,
          input: eventData.input as SerializedContent,
          executionContext: eventData.executionContext,
          attributes: eventData.attributes,
          encryptionPublicKey: eventData.encryptionPublicKey,
          status: 'pending',
          specVersion: effectiveSpecVersion,
        })
        .onConflictDoNothing()
        .returning();
      if (!runValue) {
        // Duplicate run_created: reject with the runtime's dedup signal
        // instead of appending a second run_created row. Core treats this
        // 409 as benign ("the run already exists").
        throw new EntityConflictError(`Workflow run "${effectiveRunId}" already exists`);
      }
      // Open the run's slot marker. Doing it here, rather than lazily on
      // first allocation, is what makes "no row" mean "created before slots
      // existed" for the rest of the run's life.
      eventId = await openEventSlots(drizzle, effectiveRunId);
      run = rowToRun(runValue);
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
          run = rowToRun(existingRun);
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
        .set({ status: 'running', startedAt: now, updatedAt: now })
        .where(eq(Schema.runs.runId, effectiveRunId))
        .returning();
      if (runValue) {
        run = rowToRun(runValue);
      }
    }

    // Handle run_completed event: update run status.
    // Uses conditional UPDATE to prevent completing an already-terminal run.
    if (data.eventType === 'run_completed') {
      const eventData = data.eventData;
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
            notInArray(Schema.runs.status, [...TERMINAL_WORKFLOW_RUN_STATUSES]),
          ),
        )
        .returning();
      if (runValue) {
        run = rowToRun(runValue);
      } else {
        await throwTerminalRunConflict(effectiveRunId);
      }
    }

    // Handle run_failed event: update run status. The error field is the
    // serialized payload from the runtime, stored verbatim in error_cbor.
    if (data.eventType === 'run_failed') {
      const eventData = data.eventData;
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
            notInArray(Schema.runs.status, [...TERMINAL_WORKFLOW_RUN_STATUSES]),
          ),
        )
        .returning();
      if (runValue) {
        run = rowToRun(runValue);
      } else {
        await throwTerminalRunConflict(effectiveRunId);
      }
    }

    // Handle run_cancelled event: update run status (idempotent cancel on an
    // already-cancelled run returned earlier).
    if (data.eventType === 'run_cancelled') {
      const [runValue] = await drizzle
        .update(Schema.runs)
        .set({ status: 'cancelled', completedAt: now, updatedAt: now })
        .where(
          and(
            eq(Schema.runs.runId, effectiveRunId),
            notInArray(Schema.runs.status, [...TERMINAL_WORKFLOW_RUN_STATUSES]),
          ),
        )
        .returning();
      if (runValue) {
        run = rowToRun(runValue);
      } else {
        await throwTerminalRunConflict(effectiveRunId);
      }
    }

    // Terminal transition committed: hooks and waits are removed so tokens
    // become reusable. (Hook token retention is not implemented; the
    // hookRetention capability is deliberately not advertised.)
    if (isTerminalRunEventType(data.eventType)) {
      await Promise.all([
        drizzle.delete(Schema.hooks).where(eq(Schema.hooks.runId, effectiveRunId)),
        drizzle.delete(Schema.waits).where(eq(Schema.waits.runId, effectiveRunId)),
      ]);
    }

    // Handle attr_set event: merge the changes onto the run entity.
    if (data.eventType === 'attr_set') {
      const { changes, allowReservedAttributes } = data.eventData;
      // Dedup pre-check for correlated workflow writes: a redelivered
      // duplicate must be rejected BEFORE materializing onto the run, or the
      // snapshot would advance while the event insert fails. The unique
      // index still guards the truly-concurrent race, whose writers carry
      // identical changes (deterministic replay).
      if (data.correlationId && data.eventData.writer.type === 'workflow') {
        const [duplicate] = await drizzle
          .select({ eventId: events.eventId })
          .from(events)
          .where(
            and(
              eq(events.runId, effectiveRunId),
              eq(events.correlationId, data.correlationId),
              eq(events.eventType, 'attr_set'),
            ),
          )
          .limit(1);
        if (duplicate) {
          throw new EntityConflictError(
            `attr_set for correlationId "${data.correlationId}" already exists in run "${effectiveRunId}"`,
          );
        }
      }
      const [existing] = await drizzle
        .select({ attributes: Schema.runs.attributes })
        .from(Schema.runs)
        .where(eq(Schema.runs.runId, effectiveRunId))
        .limit(1);
      if (!existing) {
        throw new WorkflowRunNotFoundError(effectiveRunId);
      }
      validateAttributeChanges(changes, {
        existingKeys: Object.keys(existing.attributes ?? {}),
        allowReservedAttributes: allowReservedAttributes === true,
      });
      const expr = attributeMergeExpr(changes);
      const [runValue] = await drizzle
        .update(Schema.runs)
        .set({ attributes: expr, updatedAt: now })
        .where(
          and(
            eq(Schema.runs.runId, effectiveRunId),
            sql`(SELECT COUNT(*) FROM jsonb_object_keys(${expr})) <= ${ATTRIBUTE_MAX_PER_RUN}`,
          ),
        )
        .returning();
      if (!runValue) {
        const [stillExists] = await drizzle
          .select({ runId: Schema.runs.runId })
          .from(Schema.runs)
          .where(eq(Schema.runs.runId, effectiveRunId))
          .limit(1);
        if (!stillExists) {
          throw new WorkflowRunNotFoundError(effectiveRunId);
        }
        throw new AttributeValidationError(
          `Run attribute count would exceed limit ${ATTRIBUTE_MAX_PER_RUN}`,
        );
      }
      run = rowToRun(runValue);
    }

    // Strip eventData from run_started (it belongs on run_created only). For
    // a lazy step_started, strip only the step input (it rides the synthetic
    // step_created); stepName stays for the replay divergence check.
    let storedEventData: unknown;
    if (data.eventType === 'run_started') {
      storedEventData = undefined;
    } else if ('eventData' in data && data.eventData) {
      if (data.eventType === 'step_started' && 'input' in data.eventData) {
        const { input: _strippedInput, ...rest } = data.eventData;
        storedEventData = rest;
      } else {
        storedEventData = data.eventData;
      }
    } else {
      storedEventData = undefined;
    }

    // Set by branches that write their own event row inside an entity-guard
    // transaction; the shared insert below is skipped when already set.
    let value: { createdAt: Date; occurredAt?: Date | null } | undefined;

    // Handle step_started event: increment attempt and set the step to
    // running, then write the matching event log entry in the same
    // transaction. The guarded UPDATE takes the step row lock; keeping the
    // event INSERT behind that lock prevents a late step_started from being
    // ordered after a concurrent terminal event that already won the row.
    if (data.eventType === 'step_started') {
      const stepStartedData = data;
      const stepId = stepStartedData.correlationId;
      if (!stepId) {
        throw new WorkflowWorldError('step_started requires a correlationId', { status: 400 });
      }
      value = await drizzle.transaction(async (tx) => {
        // Lazy step start: the step INSERT is the ownership claim. Only the
        // caller that inserts the row gets to run the step body inline.
        if (lazyStepStart && !validatedStep) {
          const lazyData = stepStartedData.eventData as { stepName: string; input: unknown };
          const [inserted] = await tx
            .insert(Schema.steps)
            .values({
              runId: effectiveRunId,
              stepId,
              stepName: lazyData.stepName,
              input: lazyData.input as SerializedContent,
              status: 'pending',
              attempt: 0,
              specVersion: effectiveSpecVersion,
            })
            .onConflictDoNothing()
            .returning({ stepId: Schema.steps.stepId });
          if (!inserted) {
            throw new EntityConflictError(
              `Step "${stepStartedData.correlationId}" already created`,
            );
          }
          // Replay must observe step_created before step_started, and both
          // sides of the materialization must land or neither.
          try {
            await insertEventRow(tx, {
              runId: effectiveRunId,
              eventId: await allocateEventId(tx, effectiveRunId),
              correlationId: stepStartedData.correlationId,
              eventType: 'step_created',
              eventData: { stepName: lazyData.stepName, input: lazyData.input },
              specVersion: effectiveSpecVersion,
            });
          } catch (err) {
            // A concurrent writer already published this run's step_created
            // for the same step, which is all this synthetic write was for.
            if (pgConstraintOf(err) !== 'workflow_events_entity_creation_unique') {
              throw err;
            }
          }
          stepCreatedLazily = true;
        }

        // Retried steps may be scheduled for later. Keep this check inside
        // the transaction so the step_started write cannot slip past it.
        if (validatedStep?.retryAfter && validatedStep.retryAfter.getTime() > Date.now()) {
          throw new TooEarlyError(
            `Cannot start step "${stepStartedData.correlationId}": retryAfter timestamp has not been reached yet`,
            {
              retryAfter: Math.ceil((validatedStep.retryAfter.getTime() - Date.now()) / 1000),
            },
          );
        }

        // The terminal-state guard is part of the UPDATE, not just the
        // earlier validation read, closing the race where another writer
        // completes/fails the step between validation and start.
        const [stepValue] = await tx
          .update(Schema.steps)
          .set({
            status: 'running',
            attempt: sql`${Schema.steps.attempt} + 1`,
            // Preserve the original first-start timestamp across retries.
            startedAt: sql`COALESCE(${Schema.steps.startedAt}, ${now.toISOString()})`,
            retryAfter: null,
          })
          .where(
            and(
              eq(Schema.steps.runId, effectiveRunId),
              eq(Schema.steps.stepId, stepStartedData.correlationId),
              notInArray(Schema.steps.status, terminalStepStatuses),
            ),
          )
          .returning();
        if (stepValue) {
          step = rowToStep(stepValue);
        } else {
          const [existing] = await tx
            .select({ status: Schema.steps.status })
            .from(Schema.steps)
            .where(
              and(
                eq(Schema.steps.runId, effectiveRunId),
                eq(Schema.steps.stepId, stepStartedData.correlationId),
              ),
            )
            .limit(1);
          if (!existing) {
            throw new WorkflowWorldError(`Step "${stepStartedData.correlationId}" not found`, {
              status: 404,
            });
          }
          if (isTerminalStepStatus(existing.status)) {
            throw new EntityConflictError(
              `Cannot modify step in terminal state "${existing.status}"`,
            );
          }
        }

        // Allocate the position only after the guarded step UPDATE has
        // acquired and passed the row lock, so a writer blocked on the step
        // row cannot carry an earlier position into a later insert.
        const eventValue = await insertEventRow(tx, {
          runId: effectiveRunId,
          eventId: await allocateEventId(tx, effectiveRunId),
          correlationId: stepStartedData.correlationId,
          eventType: stepStartedData.eventType,
          eventData: storedEventData,
          occurredAt: params?.occurredAt,
          specVersion: effectiveSpecVersion,
        });
        if (!eventValue) {
          throw new EntityConflictError(
            `Event for step "${stepStartedData.correlationId}" could not be created`,
          );
        }
        eventId = eventValue.eventId;
        return { createdAt: eventValue.createdAt, occurredAt: eventValue.occurredAt };
      }, SLOT_INSERT_TRANSACTION);
    }

    // Handle step_completed event: update step status
    if (data.eventType === 'step_completed') {
      const eventData = data.eventData;
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
            eq(Schema.steps.stepId, data.correlationId),
            notInArray(Schema.steps.status, terminalStepStatuses),
          ),
        )
        .returning();
      if (stepValue) {
        step = rowToStep(stepValue);
      } else {
        await throwTerminalStepConflict(effectiveRunId, data.correlationId);
      }
    }

    // Handle step_failed event: terminal state with the serialized error
    // stored verbatim in error_cbor.
    if (data.eventType === 'step_failed') {
      const eventData = data.eventData;
      const [stepValue] = await drizzle
        .update(Schema.steps)
        .set({ status: 'failed', error: eventData.error, completedAt: now })
        .where(
          and(
            eq(Schema.steps.runId, effectiveRunId),
            eq(Schema.steps.stepId, data.correlationId),
            notInArray(Schema.steps.status, terminalStepStatuses),
          ),
        )
        .returning();
      if (stepValue) {
        step = rowToStep(stepValue);
      } else {
        await throwTerminalStepConflict(effectiveRunId, data.correlationId);
      }
    }

    // Handle step_retrying event: sets status back to 'pending', records error
    if (data.eventType === 'step_retrying') {
      const eventData = data.eventData;
      const [stepValue] = await drizzle
        .update(Schema.steps)
        .set({ status: 'pending', error: eventData.error, retryAfter: eventData.retryAfter })
        .where(
          and(
            eq(Schema.steps.runId, effectiveRunId),
            eq(Schema.steps.stepId, data.correlationId),
            notInArray(Schema.steps.status, terminalStepStatuses),
          ),
        )
        .returning();
      if (stepValue) {
        step = rowToStep(stepValue);
      } else {
        await throwTerminalStepConflict(effectiveRunId, data.correlationId);
      }
    }

    // Handle hook_created event: create hook entity
    if (data.eventType === 'hook_created') {
      const eventData = data.eventData;

      // Emits a hook_conflict event (instead of throwing 409) so the
      // workflow continues and fails gracefully when the hook is awaited.
      const emitHookConflict = async (conflictingRunId: string): Promise<EventResult> => {
        const conflictEventData = { token: eventData.token, conflictingRunId };
        const conflictValue = await insertEventRow(drizzle, {
          runId: effectiveRunId,
          eventId: await getEventId(),
          correlationId: data.correlationId,
          eventType: 'hook_conflict',
          eventData: conflictEventData,
          occurredAt: params?.occurredAt,
          specVersion: effectiveSpecVersion,
        });
        if (!conflictValue) {
          throw new EntityConflictError(
            `hook_conflict for run "${effectiveRunId}" could not be created`,
          );
        }
        const conflictResult = {
          eventType: 'hook_conflict' as const,
          correlationId: data.correlationId,
          eventData: conflictEventData,
          ...compact(conflictValue),
          runId: effectiveRunId,
        };
        const parsedConflict = EventSchema.parse(conflictResult);
        const resolveData = params?.resolveData ?? 'all';
        return {
          event: stripEventDataRefs(parsedConflict, resolveData),
          run,
          step,
          hook: undefined,
        };
      };

      // Recovers an orphaned hook row (hook INSERT landed but the events
      // INSERT didn't) so the EventResult carries the persisted entity.
      const recoverOrphanedHook = async (): Promise<void> => {
        const [recoveredHookValue] = await drizzle
          .select()
          .from(Schema.hooks)
          .where(eq(Schema.hooks.hookId, data.correlationId))
          .limit(1);
        if (recoveredHookValue) {
          hook = rowToHook(recoveredHookValue);
        }
      };

      // Check for duplicate token
      const [existingHook] = await getHookByToken.execute({ token: eventData.token });

      if (existingHook) {
        // Idempotency: if the existing hook is the *same* (runId, hookId) we
        // are trying to create, this is either a duplicate / replayed
        // delivery of the same hook_created, or an orphaned hook row from a
        // prior crashed attempt. Distinguish by checking whether the
        // hook_created event exists in the log (vercel/workflow#2283).
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
            hookId: data.correlationId,
            token: eventData.token,
            metadata: eventData.metadata,
            // Multi-tenancy fields - not yet implemented, using empty strings as placeholders
            ownerId: '',
            projectId: '',
            environment: '',
            tokenRetentionUntil: eventData.tokenRetentionUntil,
            specVersion: effectiveSpecVersion,
            isWebhook: eventData.isWebhook,
            isSystem: eventData.isSystem ?? false,
          })
          .onConflictDoNothing()
          .returning();
        if (hookValue) {
          hook = rowToHook(hookValue);
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

    // Handle hook_disposed event: delete the hook entity and append the
    // disposal in ONE transaction. DELETE ... RETURNING ensures only one
    // concurrent caller succeeds, and the transaction holds the hook row
    // lock until the hook_disposed row exists, so a racing resume cannot
    // land its hook_received behind the disposal (vercel/workflow#2781).
    if (data.eventType === 'hook_disposed' && data.correlationId) {
      const disposedHookId = data.correlationId;
      value = await drizzle.transaction(async (tx) => {
        const [deleted] = await tx
          .delete(Schema.hooks)
          .where(eq(Schema.hooks.hookId, disposedHookId))
          .returning({ hookId: Schema.hooks.hookId });
        if (!deleted) {
          throw new EntityConflictError(`Hook "${disposedHookId}" already disposed`);
        }
        // Allocated only after the lock is held: a writer that had to wait
        // must not carry an earlier position into a later insert.
        const eventValue = await insertEventRow(tx, {
          runId: effectiveRunId,
          eventId: await getEventId(tx),
          correlationId: disposedHookId,
          eventType: data.eventType,
          eventData: storedEventData,
          occurredAt: params?.occurredAt,
          specVersion: effectiveSpecVersion,
        });
        if (!eventValue) {
          throw new EntityConflictError(`Event for hook "${disposedHookId}" could not be created`);
        }
        eventId = eventValue.eventId;
        return { createdAt: eventValue.createdAt, occurredAt: eventValue.occurredAt };
      }, SLOT_INSERT_TRANSACTION);
    }

    // Handle hook_received event: append the event only if the run has not
    // reached a terminal state. FOR UPDATE takes the run row lock, then the
    // hook row lock, linearizing this insert against a concurrent terminal
    // transition and against a concurrent disposal.
    if (data.eventType === 'hook_received') {
      value = await drizzle.transaction(async (tx) => {
        const [runRow] = await tx
          .select({ status: Schema.runs.status })
          .from(Schema.runs)
          .where(eq(Schema.runs.runId, effectiveRunId))
          .for('update')
          .limit(1);
        if (!runRow) {
          throw new WorkflowRunNotFoundError(effectiveRunId);
        }
        if (isTerminalWorkflowRunStatus(runRow.status)) {
          throw new RunExpiredError(
            `Workflow run "${effectiveRunId}" is already in terminal state "${runRow.status}"`,
          );
        }
        // Re-check the hook under its own row lock: either this delivery got
        // the lock first and its hook_received is ordered BEFORE a racing
        // disposal, or the disposer got it and the row is gone and this
        // delivery is refused. Under READ COMMITTED a locked read of a row
        // deleted by the transaction it waited on returns no row.
        if (data.correlationId) {
          const [liveHook] = await tx
            .select({ hookId: Schema.hooks.hookId })
            .from(Schema.hooks)
            .where(eq(Schema.hooks.hookId, data.correlationId))
            .for('update')
            .limit(1);
          if (!liveHook) {
            throw new HookNotFoundError(data.correlationId);
          }
        }
        const eventValue = await insertEventRow(tx, {
          runId: effectiveRunId,
          eventId: await allocateEventId(tx, effectiveRunId),
          correlationId: data.correlationId,
          eventType: data.eventType,
          eventData: storedEventData,
          occurredAt: params?.occurredAt,
          specVersion: effectiveSpecVersion,
        });
        if (!eventValue) {
          throw new EntityConflictError(
            `Event for hook "${data.correlationId}" could not be created`,
          );
        }
        eventId = eventValue.eventId;
        return { createdAt: eventValue.createdAt, occurredAt: eventValue.occurredAt };
      }, SLOT_INSERT_TRANSACTION);
    }

    // Handle wait_created event: create wait entity
    if (data.eventType === 'wait_created') {
      const eventData = data.eventData;
      const waitId = `${effectiveRunId}-${data.correlationId}`;
      const [waitValue] = await drizzle
        .insert(Schema.waits)
        .values({
          waitId,
          runId: effectiveRunId,
          status: 'waiting',
          resumeAt: eventData.resumeAt,
          specVersion: effectiveSpecVersion,
        })
        .onConflictDoNothing()
        .returning();
      if (!waitValue) {
        throw new EntityConflictError(`Wait "${data.correlationId}" already exists`);
      }
      wait = rowToWait(waitValue);
    }

    // Handle wait_completed event: transition wait to 'completed'.
    // Conditional UPDATE rejects duplicate completions.
    if (data.eventType === 'wait_completed') {
      const waitId = `${effectiveRunId}-${data.correlationId}`;
      const [waitValue] = await drizzle
        .update(Schema.waits)
        .set({ status: 'completed', completedAt: now })
        .where(and(eq(Schema.waits.waitId, waitId), eq(Schema.waits.status, 'waiting')))
        .returning();
      if (waitValue) {
        wait = rowToWait(waitValue);
      } else {
        const [existing] = await getWaitForValidation.execute({ waitId });
        if (!existing) {
          throw new WorkflowWorldError(`Wait "${data.correlationId}" not found`, { status: 404 });
        }
        if (existing.status === 'completed') {
          throw new EntityConflictError(`Wait "${data.correlationId}" already completed`);
        }
      }
    }

    try {
      if (!value) {
        let inserted: InsertedEventRow | undefined;
        if (data.eventType === 'step_created') {
          const eventData = data.eventData;
          // Step row and step_created event land in one transaction so a
          // crash cannot leave a step without its event.
          const created = await drizzle.transaction(async (tx) => {
            let [stepValue] = await tx
              .insert(Schema.steps)
              .values({
                runId: effectiveRunId,
                stepId: data.correlationId,
                stepName: eventData.stepName,
                input: eventData.input as SerializedContent,
                status: 'pending',
                attempt: 0,
                specVersion: effectiveSpecVersion,
              })
              .onConflictDoNothing()
              .returning();
            if (!stepValue) {
              const [existingEvent] = await tx
                .select({ eventId: events.eventId })
                .from(events)
                .where(
                  and(
                    eq(events.runId, effectiveRunId),
                    eq(events.correlationId, data.correlationId),
                    eq(events.eventType, 'step_created'),
                  ),
                )
                .limit(1);
              if (existingEvent) {
                throw new EntityConflictError(
                  `step_created for correlationId "${data.correlationId}" already exists in run "${effectiveRunId}"`,
                );
              }
              // A row without its matching event was left by the old
              // non-transactional path: keep the row and complete the
              // missing event inside this transaction.
              [stepValue] = await tx
                .select()
                .from(Schema.steps)
                .where(
                  and(
                    eq(Schema.steps.runId, effectiveRunId),
                    eq(Schema.steps.stepId, data.correlationId),
                  ),
                )
                .limit(1);
              if (!stepValue) {
                throw new EntityConflictError(
                  `step_created for correlationId "${data.correlationId}" already exists in run "${effectiveRunId}"`,
                );
              }
            }
            const eventValue = await insertEventRow(tx, {
              runId: effectiveRunId,
              eventId: await getEventId(tx),
              correlationId: data.correlationId,
              eventType: data.eventType,
              eventData: storedEventData,
              occurredAt: params?.occurredAt,
              specVersion: effectiveSpecVersion,
            });
            if (!eventValue) {
              throw new EntityConflictError(
                `step_created for run "${effectiveRunId}" could not be created`,
              );
            }
            return { eventValue, stepValue };
          }, SLOT_INSERT_TRANSACTION);
          step = rowToStep(created.stepValue);
          inserted = created.eventValue;
        } else {
          inserted = await insertEventRow(drizzle, {
            runId: effectiveRunId,
            eventId: await getEventId(),
            correlationId: data.correlationId,
            eventType: data.eventType,
            eventData: storedEventData,
            occurredAt: params?.occurredAt,
            specVersion: effectiveSpecVersion,
          });
        }
        if (inserted) {
          eventId = inserted.eventId;
          value = { createdAt: inserted.createdAt, occurredAt: inserted.occurredAt };
        }
      }
    } catch (err) {
      // Translate a unique violation on the entity-creation index into
      // EntityConflictError so the runtime's dedup path handles a redelivered
      // create. Gated on the constraint name so other 23505s propagate raw.
      const isDeduplicatedCorrelatedEvent =
        isChildEntityCreationEventType(data.eventType) ||
        (data.eventType === 'attr_set' && data.eventData.writer.type === 'workflow');
      if (
        isDeduplicatedCorrelatedEvent &&
        pgErrorOf(err).code === '23505' &&
        pgConstraintOf(err) === 'workflow_events_entity_creation_unique'
      ) {
        throw new EntityConflictError(
          `${data.eventType} for correlationId "${data.correlationId}" already exists in run "${effectiveRunId}"`,
        );
      }
      throw err;
    }

    if (!value || !eventId) {
      throw new EntityConflictError(
        `${data.eventType} for run "${effectiveRunId}" could not be created`,
      );
    }
    const result = { ...data, ...compact(value), runId: effectiveRunId, eventId };
    if (storedEventData !== undefined) {
      (result as { eventData?: unknown }).eventData = storedEventData;
    }
    // Strip eventData leaked by the ...data spread for run_started: the run
    // input belongs on run_created only.
    if (data.eventType === 'run_started') {
      delete (result as { eventData?: unknown }).eventData;
    }
    const parsed = EventSchema.parse(result);
    const resolveData = params?.resolveData ?? 'all';

    // The skipped-slot report and the inline delta share
    // events/cursor/hasMore; the delta wins because the skipped slots all sit
    // above the cursor, so it is a strict superset.
    let eventPage: { data: Event[]; cursor: string | null; hasMore: boolean } | undefined;
    if (params?.eventCount !== undefined && typeof params.sinceCursor !== 'string') {
      const report = await reportSkippedSlots(
        drizzle,
        effectiveRunId,
        parsed.eventId,
        params.eventCount,
        resolveData,
      );
      if (report) {
        // Deliberately no cursor: the report is a lower bound on what this
        // write skipped over, not a page the caller has read to the end of,
        // so it must not advance the caller's read position.
        eventPage = { data: report.events, cursor: null, hasMore: report.hasMore };
      }
    }

    // Preload all events for run_started to reduce TTFB
    if (data.eventType === 'run_started' && run && !params?.skipPreload) {
      const eventRows = await drizzle
        .select()
        .from(events)
        .where(eq(events.runId, effectiveRunId))
        .orderBy(events.eventId);
      const preload = eventRows.map((e) => {
        e.eventData ||= e.eventDataJson;
        return stripEventDataRefs(EventSchema.parse(compact(e)), resolveData);
      });
      eventPage = { data: preload, cursor: preload.at(-1)?.eventId ?? null, hasMore: false };
    }

    // Inline delta: return the page events.list({ cursor: sinceCursor })
    // would return right now, saving the caller the round trip. Single page
    // or fall back; a delta with hasMore: true is ignored by the caller.
    if (typeof params?.sinceCursor === 'string') {
      const limit = 100;
      const deltaRows = await drizzle
        .select()
        .from(events)
        .where(and(eq(events.runId, effectiveRunId), gt(events.eventId, params.sinceCursor)))
        .orderBy(events.eventId)
        .limit(limit + 1);
      const page = deltaRows.slice(0, limit);
      const delta = page.map((e) => {
        e.eventData ||= e.eventDataJson;
        return stripEventDataRefs(EventSchema.parse(compact(e)), resolveData);
      });
      eventPage = {
        data: delta,
        cursor: delta.at(-1)?.eventId ?? null,
        hasMore: deltaRows.length > limit,
      };
    }

    const eventResult: EventResult = {
      event: stripEventDataRefs(parsed, resolveData),
      run,
      step,
      hook,
      wait,
      ...(stepCreatedLazily ? { stepCreated: true as const } : {}),
      ...(run && data.eventType === 'run_started' ? { maxEvents } : {}),
    };
    if (!eventPage) {
      return eventResult;
    }
    return {
      ...eventResult,
      events: eventPage.data,
      cursor: eventPage.cursor,
      hasMore: eventPage.hasMore,
    };
  }) as Storage['events']['create'];

  async function throwTerminalRunConflict(runId: string): Promise<never> {
    const [existing] = await getRunForValidation.execute({ runId });
    if (!existing) {
      throw new WorkflowRunNotFoundError(runId);
    }
    if (isTerminalWorkflowRunStatus(existing.status)) {
      throw new EntityConflictError(
        `Cannot transition run from terminal state "${existing.status}"`,
      );
    }
    throw new EntityConflictError(`Run "${runId}" could not be updated`);
  }

  async function throwTerminalStepConflict(runId: string, stepId: string): Promise<never> {
    const [existing] = await getStepForValidation.execute({ runId, stepId });
    if (!existing) {
      throw new WorkflowWorldError(`Step "${stepId}" not found`, { status: 404 });
    }
    if (isTerminalStepStatus(existing.status)) {
      throw new EntityConflictError(`Cannot modify step in terminal state "${existing.status}"`);
    }
    throw new EntityConflictError(`Step "${stepId}" could not be updated`);
  }

  return {
    create,
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
      // No limit means "every remaining event", capped at the run ceiling and
      // read in bounded pages.
      const limit = params.pagination?.limit ?? maxEvents;
      const sortOrder = params.pagination?.sortOrder || 'asc';
      const order =
        sortOrder === 'desc'
          ? { by: desc(events.eventId), compare: lt }
          : { by: events.eventId, compare: gt };
      const resolveData = params?.resolveData ?? 'all';

      const data: Event[] = [];
      let cursor = params.pagination?.cursor;
      let hasMore = false;
      do {
        const pageLimit =
          params.pagination?.limit === undefined ? Math.min(500, limit - data.length) : limit;
        const rows = await drizzle
          .select()
          .from(events)
          .where(
            and(
              eq(events.runId, params.runId),
              map(cursor, (c) => order.compare(events.eventId, c)),
            ),
          )
          .orderBy(order.by)
          .limit(pageLimit + 1);
        const page = rows.slice(0, pageLimit);
        for (const row of page) {
          row.eventData ||= row.eventDataJson;
          data.push(stripEventDataRefs(EventSchema.parse(compact(row)), resolveData));
        }
        cursor = page.at(-1)?.eventId;
        hasMore = rows.length > pageLimit;
      } while (params.pagination?.limit === undefined && hasMore && data.length < limit);

      return {
        data,
        cursor: data.at(-1)?.eventId ?? null,
        hasMore,
      };
    },
    async listByCorrelationId(params) {
      const limit = params?.pagination?.limit ?? 100;
      const sortOrder = params.pagination?.sortOrder || 'asc';
      const order =
        sortOrder === 'desc'
          ? { by: desc(events.eventId), compare: lt }
          : { by: events.eventId, compare: gt };
      // A correlation id names a step, hook or wait within its run, so the
      // lookup is scoped to one run. Scoped, (run_id, id) is the primary
      // key, so the event-id cursor can tell rows apart.
      const all = await drizzle
        .select()
        .from(events)
        .where(
          and(
            eq(events.correlationId, params.correlationId),
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
        throw new HookNotFoundError(hookId);
      }
      const parsed = rowToHook(value);
      const resolveData = params?.resolveData ?? 'all';
      return filterHookData(parsed, resolveData);
    },
    async getByToken(token, params) {
      const [value] = await getByToken.execute({ token });
      if (!value) {
        throw new HookNotFoundError(token);
      }
      const parsed = rowToHook(value);
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
        data: values.map((v) => filterHookData(rowToHook(v), resolveData)),
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
      const [value] = await drizzle
        .select()
        .from(steps)
        .where(and(eq(steps.runId, runId), eq(steps.stepId, stepId)))
        .limit(1);

      if (!value) {
        throw new WorkflowWorldError(`Step not found: ${stepId}`, {
          status: 404,
        });
      }
      const parsed = rowToStep(value);
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
        data: values.map((v) => filterStepData(rowToStep(v), resolveData)),
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

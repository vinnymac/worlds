import { setTimeout as sleep } from 'node:timers/promises';
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
  GetWorkflowRunParams,
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
  getMaxEventsPerRun,
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
  WorkflowRunSchema,
} from '@workflow/world';
import { encode } from 'cbor-x';
import {
  and,
  desc,
  eq,
  exists,
  getTableColumns,
  gt,
  inArray,
  isNull,
  lt,
  lte,
  notExists,
  notInArray,
  or,
  type SQL,
  sql,
} from 'drizzle-orm';
import type { MySqlUpdateSetSource } from 'drizzle-orm/mysql-core';
import type { MySql2Database } from 'drizzle-orm/mysql2';
import { monotonicFactory } from 'ulid';
import type { SerializedContent } from './schema.js';
import * as schema from './schema.js';
import { compact } from './util.js';

// Type for Drizzle client with our schema
type Drizzle = MySql2Database<typeof schema>;
// A drizzle client or an open transaction on one; lets helpers run inside
// the events.create() transactions as well as standalone.
type DrizzleOrTx = Drizzle | Parameters<Parameters<Drizzle['transaction']>[0]>[0];

const DAY_MS = 24 * 60 * 60 * 1000;

/** Only for legacy (pre-slot) runs; see `allocateEventId`. */
const legacyEventUlid = monotonicFactory();

/** Per-run event ceiling reported on `run_started`. The runtime fails the run
 * with `MAX_EVENTS_EXCEEDED` once the replay log reaches it. */
const DEFAULT_MAX_EVENTS_PER_RUN = 25_000;

/** Positions one insert tries before giving up (concurrent-write storm only). */
const SLOT_INSERT_MAX_ATTEMPTS = 40;
/** Collisions that retry immediately: the duplicate-key check already waited
 * on the conflicting writer's commit, so an extra sleep buys nothing. */
const SLOT_INSERT_IMMEDIATE_ATTEMPTS = 8;
const SLOT_INSERT_BASE_DELAY_MS = 2;
const SLOT_INSERT_MAX_DELAY_MS = 40;

/**
 * Isolation for every transaction an event insert can run inside. A lost
 * slot race retries inside the same transaction, which only terminates if
 * the retry can see rows committed since the transaction began. MySQL's
 * default REPEATABLE READ pins the first statement's snapshot; READ
 * COMMITTED takes a fresh one per statement.
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

function getHookRetentionLimitMs(): number {
  const days = Number(process.env.WORKFLOW_MYSQL_HOOK_RETENTION_LIMIT_DAYS ?? 30);
  if (!Number.isFinite(days) || days <= 0) {
    throw new WorkflowWorldError(
      'WORKFLOW_MYSQL_HOOK_RETENTION_LIMIT_DAYS must be a positive number',
      { status: 400 },
    );
  }
  return days * DAY_MS;
}

function getRunStatusPollIntervalMs(): number {
  const raw = Number(process.env.WORKFLOW_MYSQL_RUN_STATUS_POLL_INTERVAL_MS ?? 250);
  return Number.isFinite(raw) && raw > 0 ? raw : 250;
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

/**
 * The position a slot-numbered insert takes: one above the highest the run
 * already holds, read inside the INSERT that takes it. Nothing hands out a
 * position ahead of the write that fills it, so a log missing a position is
 * missing an event rather than merely a number. Ordering is lexicographic,
 * which equals positional order because every body is zero-padded.
 */
function nextSlotId(runId: string): SQL {
  const bodyFrom = sql.raw(String(EVENT_ID_PREFIX.length + 1));
  const width = sql.raw(String(EVENT_ID_BODY_LENGTH));
  const noEvents = sql.raw(String(FIRST_EVENT_SLOT - 1));
  // The derived table materializes the self-read, which is what MySQL
  // requires of a subquery reading the table an INSERT is writing (1093).
  return sql`CONCAT(${EVENT_ID_PREFIX}, LPAD(COALESCE((SELECT \`slot\` FROM (SELECT CAST(SUBSTRING(prev.\`id\`, ${bodyFrom}) AS UNSIGNED) AS \`slot\` FROM ${schema.events} prev WHERE prev.\`run_id\` = ${runId} ORDER BY prev.\`id\` DESC LIMIT 1) AS \`prev_slot\`), ${noEvents}) + 1, ${width}, '0'))`;
}

/**
 * The id an insert for `runId` should allocate with: a slot expression for a
 * slot-numbered run, a fresh ULID for one that predates slots. A row in
 * `workflow_event_slots` is the marker for the first case. A legacy run keeps
 * the original `wevt_` prefix: a mid-life change would sort every new event
 * before every old one, since `evnt_` < `wevt_`.
 */
async function allocateEventId(db: DrizzleOrTx, runId: string): Promise<string | SQL> {
  const [row] = await db
    .select({ runId: schema.eventSlots.runId })
    .from(schema.eventSlots)
    .where(eq(schema.eventSlots.runId, runId))
    .limit(1);
  return row ? nextSlotId(runId) : `wevt_${legacyEventUlid()}`;
}

/**
 * Marks a run being created as slot-numbered and returns its first event id.
 * The row records the scheme and nothing else; positions come from the log
 * itself. The duplicate no-op mirrors ON CONFLICT DO NOTHING: the
 * arbitration that matters is the event insert.
 */
async function openEventSlots(db: DrizzleOrTx, runId: string): Promise<string> {
  await db.insert(schema.eventSlots).values({ runId }).onDuplicateKeyUpdate({ set: { runId } });
  return slotToEventId(FIRST_EVENT_SLOT);
}

/** UTC 'YYYY-MM-DD HH:MM:SS.mmm', matching drizzle-written timestamp values;
 * binding a raw JS Date would go through the driver's local timezone. */
function toUtcSqlTimestamp(date: Date): string {
  return date.toISOString().slice(0, 23).replace('T', ' ');
}

interface EventRowInsert {
  runId: string;
  /** A fixed id (legacy ULID or the reserved first slot) or a slot expression. */
  eventId: string | SQL;
  correlationId?: string;
  eventType: Event['eventType'];
  eventData?: unknown;
  occurredAt?: Date;
  specVersion: number;
}

/** Server-decided columns of a freshly inserted event row. */
interface InsertedEventRow {
  eventId: string;
  createdAt: Date;
  occurredAt: Date | null;
}

/**
 * Inserts one event row, retrying while the position it computed is taken.
 * The slot is computed inside the INSERT (see {@link nextSlotId}) and the
 * composite primary key on (run_id, id) arbitrates the race: a loser's
 * duplicate-key check has already waited on the winner's commit, so the
 * retry re-reads a store that has advanced. MySQL statements do not poison
 * their transaction on error, so the loop can live inside one; that
 * transaction must be READ COMMITTED (see {@link SLOT_INSERT_TRANSACTION}).
 *
 * `db` must be a transaction: it pins the connection, and the read-back
 * below relies on read-own-writes. While our slot is uncommitted, no other
 * writer can commit anything at or above it for this run (density: they
 * must pass through our slot first and block on the duplicate check), so
 * the run's max id inside this transaction is exactly the row we inserted.
 *
 * Returns `undefined` only for a fixed-id insert that lost, where the
 * conflict is the caller's answer rather than something to retry.
 */
async function insertEventRow(
  db: DrizzleOrTx,
  values: EventRowInsert,
): Promise<InsertedEventRow | undefined> {
  const events = schema.events;
  const allocates = typeof values.eventId !== 'string';
  for (let attempt = 0; ; attempt++) {
    try {
      if (typeof values.eventId === 'string') {
        await db.insert(events).values({
          runId: values.runId,
          eventId: values.eventId,
          correlationId: values.correlationId,
          eventType: values.eventType,
          eventData: values.eventData,
          occurredAt: values.occurredAt,
          specVersion: values.specVersion,
        });
      } else {
        const payload =
          values.eventData !== undefined ? Buffer.from(encode(values.eventData)) : null;
        const occurredAt = values.occurredAt ? toUtcSqlTimestamp(values.occurredAt) : null;
        await db.execute(
          sql`INSERT INTO ${events} (\`id\`, \`run_id\`, \`type\`, \`correlation_id\`, \`payload_cbor\`, \`occurred_at\`, \`spec_version\`) SELECT ${values.eventId}, ${values.runId}, ${values.eventType}, ${values.correlationId ?? null}, ${payload}, ${occurredAt}, ${values.specVersion}`,
        );
      }
    } catch (error: unknown) {
      if (isDuplicateKeyError(error, 'workflow_events.PRIMARY')) {
        if (!allocates) {
          return undefined;
        }
        if (attempt >= SLOT_INSERT_MAX_ATTEMPTS) {
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
          await sleep(Math.random() * delay);
        }
        continue;
      }
      // Every other unique violation raises, which is what lets callers
      // translate a dedup conflict on workflow_events_entity_creation_unique.
      throw error;
    }
    // MySQL has no INSERT ... RETURNING; re-read the committed row. For an
    // allocated slot the run's max id inside this transaction is our row
    // (see the density argument above); for a fixed id, read it directly.
    const where =
      typeof values.eventId === 'string'
        ? and(eq(events.runId, values.runId), eq(events.eventId, values.eventId))
        : eq(events.runId, values.runId);
    const [row] = await db
      .select({
        eventId: events.eventId,
        createdAt: events.createdAt,
        occurredAt: events.occurredAt,
      })
      .from(events)
      .where(where)
      .orderBy(desc(events.eventId))
      .limit(1);
    if (!row) {
      throw new EntityConflictError(`Event for run "${values.runId}" could not be created`);
    }
    return row;
  }
}

/**
 * The report half of bump-and-report: the events sitting on the slots between
 * the one the writer asked for and the one its write actually landed on.
 * Returns `undefined` when there is nothing to report. The set can be short
 * of the span it covers (a lower-slot writer may not have committed yet), so
 * `hasMore` marks the report as a lower bound; it is advisory either way.
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
    .from(schema.events)
    .where(
      and(
        eq(schema.events.runId, runId),
        gt(schema.events.eventId, slotToEventId(askedFor)),
        lt(schema.events.eventId, committedEventId),
      ),
    )
    .orderBy(schema.events.eventId);
  const events = rows.map((row) => {
    applyCborFallbackEvent(row);
    return stripEventDataRefs(EventSchema.parse(compact(row)), resolveData);
  });
  return {
    events,
    hasMore: events.length < committedSlot - askedFor - 1,
  };
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

/** Payload columns stripped for `resolveData: 'none'`. Legacy `errorJson` is
 * projected out everywhere: v5 entity errors live in the CBOR column. */
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

/** Rows whose owning run is terminal (correlated subquery for hook queries). */
function ownerRunIsTerminalSubquery(drizzle: Drizzle) {
  return drizzle
    .select({ runId: schema.runs.runId })
    .from(schema.runs)
    .where(
      and(
        eq(schema.runs.runId, schema.hooks.runId),
        inArray(schema.runs.status, [...TERMINAL_WORKFLOW_RUN_STATUSES]),
      ),
    );
}

export function createRunsStorage(drizzle: Drizzle): Storage['runs'] {
  const runs = schema.runs;

  const getRun = (async (id: string, params?: GetWorkflowRunParams) => {
    const [value] = await drizzle
      .select(params?.resolveData === 'none' ? runColumnsWithoutData : undefined)
      .from(runs)
      .where(eq(runs.runId, id))
      .limit(1);
    if (!value) {
      throw new WorkflowRunNotFoundError(id);
    }
    applyCborFallback(value);
    const parsed = WorkflowRunSchema.parse(compact(value));
    const resolveData = params?.resolveData ?? 'all';
    return filterRunData(parsed, resolveData);
  }) as Storage['runs']['get'];

  return {
    get: getRun,
    /** Long poll for a terminal run status via bounded re-reads. MySQL has no
     * push channel, so the backstop poll interval IS the mechanism. */
    waitForTerminalStatus: (async (id: string, params?: any) => {
      const deadline = Date.now() + (params?.timeoutMs ?? 0);
      while (true) {
        const run = await getRun(id, params);
        if (isTerminalWorkflowRunStatus(run.status)) return run;
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0 || params?.signal?.aborted) return run;
        await sleep(Math.min(remainingMs, getRunStatusPollIntervalMs()));
      }
    }) as NonNullable<Storage['runs']['waitForTerminalStatus']>,
    getMany: (async (ids: readonly string[], params?: GetWorkflowRunParams) => {
      const uniqueIds = [...new Set(ids)];
      if (uniqueIds.length === 0) {
        return [];
      }
      const values = await drizzle
        .select(params?.resolveData === 'none' ? runColumnsWithoutData : undefined)
        .from(runs)
        .where(inArray(runs.runId, uniqueIds));
      const resolveData = params?.resolveData ?? 'all';
      const runsById = new Map(
        values.map((value) => {
          applyCborFallback(value);
          const parsed = WorkflowRunSchema.parse(compact(value));
          return [parsed.runId, filterRunData(parsed, resolveData)];
        }),
      );
      return ids.map((id) => runsById.get(id) ?? null);
    }) as NonNullable<Storage['runs']['getMany']>,
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
          const parsed = WorkflowRunSchema.parse(compact(v));
          return filterRunData(parsed, resolveData);
        }),
        hasMore,
        cursor: values.at(-1)?.runId ?? null,
      };
    }) as Storage['runs']['list'],
    experimentalSetAttributes: async (runId, changes, options) => {
      // Load existing keys so the shared validator produces precise errors;
      // the authoritative cap enforcement is the guarded UPDATE below.
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
      const expr = attributesMergeExpr(changes);
      // Cap check folded into WHERE so two writers at the boundary cannot
      // both slip past; JSON_LENGTH of an object is its key count.
      const [updated] = await drizzle
        .update(runs)
        .set({ attributes: expr, updatedAt: new Date() })
        .where(and(eq(runs.runId, runId), sql`JSON_LENGTH(${expr}) <= ${ATTRIBUTE_MAX_PER_RUN}`));
      if (updated.affectedRows === 0) {
        const [stillThere] = await drizzle
          .select({ runId: runs.runId })
          .from(runs)
          .where(eq(runs.runId, runId))
          .limit(1);
        if (!stillThere) {
          throw new WorkflowRunNotFoundError(runId);
        }
        throw new AttributeValidationError(
          `Run attribute count would exceed limit ${ATTRIBUTE_MAX_PER_RUN} after concurrent write`,
        );
      }
      const [after] = await drizzle
        .select({ attributes: runs.attributes })
        .from(runs)
        .where(eq(runs.runId, runId))
        .limit(1);
      if (!after) {
        throw new WorkflowRunNotFoundError(runId);
      }
      return { attributes: after.attributes ?? {} };
    },
  };
}

/** Folds attribute changes into one SQL expression: sets nest into JSON_SET,
 * removes into JSON_REMOVE. JSON_QUOTE keys the path safely. */
function attributesMergeExpr(changes: readonly { key: string; value: string | null }[]): SQL {
  let expr = sql`COALESCE(${schema.runs.attributes}, JSON_OBJECT())`;
  for (const { key, value } of changes) {
    expr =
      value === null
        ? sql`JSON_REMOVE(${expr}, CONCAT('$.', JSON_QUOTE(${key})))`
        : sql`JSON_SET(${expr}, CONCAT('$.', JSON_QUOTE(${key})), ${value})`;
  }
  return expr;
}

function map<T, R>(obj: T | null | undefined, fn: (v: T) => R): undefined | R {
  return obj ? fn(obj) : undefined;
}

/**
 * Handle events for legacy runs (pre-event-sourcing, specVersion <= 1):
 * run_cancelled skips event storage and updates the run directly;
 * wait_completed / hook_received store the event only; everything else is
 * unsupported. A run this old is ULID-numbered by definition, so the id is
 * minted rather than read from a slot marker the run cannot have.
 */
async function handleLegacyEvent(
  drizzle: Drizzle,
  runId: string,
  eventId: string,
  data: CreateEventRequest,
  currentRun: { specVersion: number | null },
  params: CreateEventParams | undefined,
): Promise<EventResult> {
  const resolveData = params?.resolveData ?? 'all';
  switch (data.eventType) {
    case 'run_cancelled': {
      const now = new Date();
      await drizzle
        .update(schema.runs)
        .set({ status: 'cancelled', completedAt: now, updatedAt: now })
        .where(eq(schema.runs.runId, runId));
      await Promise.all([
        drizzle.delete(schema.hooks).where(eq(schema.hooks.runId, runId)),
        drizzle.delete(schema.waits).where(eq(schema.waits.runId, runId)),
      ]);
      const [updatedRun] = await drizzle
        .select()
        .from(schema.runs)
        .where(eq(schema.runs.runId, runId))
        .limit(1);
      return {
        run: updatedRun ? (compact(applyCborFallback(updatedRun)) as WorkflowRun) : undefined,
      };
    }
    case 'wait_completed':
    case 'hook_received': {
      // hook_received guards against a concurrent terminal transition by
      // taking the run row lock, mirroring the current-spec path below.
      const insertLegacyEvent = async (tx: DrizzleOrTx): Promise<InsertedEventRow> => {
        const inserted = await insertEventRow(tx, {
          runId,
          eventId,
          correlationId: data.correlationId,
          eventType: data.eventType,
          eventData: 'eventData' in data ? data.eventData : undefined,
          specVersion: SPEC_VERSION_CURRENT,
        });
        if (!inserted) {
          throw new EntityConflictError(`Event ${eventId} could not be created`);
        }
        return inserted;
      };
      const inserted =
        data.eventType === 'hook_received'
          ? await drizzle.transaction(async (tx) => {
              const [runRow] = await tx
                .select({ status: schema.runs.status })
                .from(schema.runs)
                .where(eq(schema.runs.runId, runId))
                .limit(1)
                .for('update');
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
          : await drizzle.transaction(insertLegacyEvent, SLOT_INSERT_TRANSACTION);
      const event = EventSchema.parse({ ...data, ...compact(inserted), runId, eventId });
      return { event: stripEventDataRefs(event, resolveData) };
    }
    default:
      throw new Error(
        `Event type '${data.eventType}' not supported for legacy runs ` +
          `(specVersion: ${currentRun.specVersion || 'undefined'}). ` +
          `Please upgrade @workflow packages.`,
      );
  }
}

export function createEventsStorage(
  drizzle: Drizzle,
  options: EventsStorageOptions = {},
): Storage['events'] {
  const hookRetentionLimitMs = getHookRetentionLimitMs();
  const ulid = monotonicFactory();
  const events = schema.events;
  const maxEvents = resolveMaxEventsPerRun(options.maxEventsPerRun);

  const terminalStepStatuses = [...TERMINAL_STEP_STATUSES];
  const ownerRunIsTerminal = ownerRunIsTerminalSubquery(drizzle);
  const hookRetentionEnded = or(
    isNull(schema.hooks.tokenRetentionUntil),
    lte(schema.hooks.tokenRetentionUntil, sql`NOW(3)`),
  );
  const hookAvailable = or(
    gt(schema.hooks.tokenRetentionUntil, sql`NOW(3)`),
    notExists(ownerRunIsTerminal),
  );

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
    return compact(value) as WorkflowRun;
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
    return compact(value) as Step;
  }

  /** Root-level event append: opens its own READ COMMITTED transaction so the
   * allocation loop and its read-back share one pinned connection. */
  function appendEvent(values: EventRowInsert): Promise<InsertedEventRow | undefined> {
    return drizzle.transaction((tx) => insertEventRow(tx, values), SLOT_INSERT_TRANSACTION);
  }

  const create = async (
    runId: string | null,
    data: RunCreatedEventRequest | CreateEventRequest,
    params?: CreateEventParams,
  ): Promise<EventResult> => {
    if (
      data.eventType === 'hook_created' &&
      data.eventData.tokenRetentionUntil !== undefined &&
      data.eventData.tokenRetentionUntil.getTime() > Date.now() + hookRetentionLimitMs
    ) {
      throw new WorkflowWorldError(
        `Hook minimum retention cannot exceed ${hookRetentionLimitMs / DAY_MS} days in the MySQL World.`,
        { status: 400 },
      );
    }

    // The id this call's event took, known only once its insert committed:
    // on a slot-numbered run the position is chosen inside the INSERT.
    let eventId: string | undefined;

    // For run_created events, generate runId server-side if null or empty
    let effectiveRunId: string;
    if (data.eventType === 'run_created' && (!runId || runId === '')) {
      effectiveRunId = `wrun_${ulid()}`;
    } else if (!runId) {
      throw new Error('runId is required for non-run_created events');
    } else {
      effectiveRunId = runId;
    }

    // Lazy: a legacy run mints a ULID, a slot run gets the slot expression.
    const getEventId = async (db: DrizzleOrTx = drizzle): Promise<string | SQL> =>
      eventId ?? (await allocateEventId(db, effectiveRunId));

    if (data.eventType === 'run_created' && runId && runId !== '') {
      const validationError = validateUlidTimestamp(effectiveRunId, 'wrun_');
      if (validationError) {
        throw new WorkflowWorldError(validationError);
      }
    }

    // specVersion is always sent by the runtime, but we provide a fallback for safety
    const effectiveSpecVersion: number = data.specVersion ?? SPEC_VERSION_CURRENT;
    const resolveData = params?.resolveData ?? 'all';
    const now = new Date();

    let run: WorkflowRun | undefined;
    let step: Step | undefined;
    let hook: Hook | undefined;
    let wait: Wait | undefined;
    // Lazy step start: true when this step_started atomically created the
    // step. Surfaced as EventResult.stepCreated, the runtime's exactly-once
    // inline-ownership signal.
    let stepCreatedLazily = false;

    // ============================================================
    // VALIDATION: Terminal state and event ordering checks
    // ============================================================

    // Skip run validation for step_completed and step_retrying: they only
    // operate on running steps regardless of run state.
    let currentRun: { status: string; specVersion: number | null } | null = null;
    const skipRunValidationEvents = ['step_completed', 'step_retrying'];
    if (data.eventType !== 'run_created' && !skipRunValidationEvents.includes(data.eventType)) {
      const [runValue] = await drizzle
        .select({ status: schema.runs.status, specVersion: schema.runs.specVersion })
        .from(schema.runs)
        .where(eq(schema.runs.runId, effectiveRunId))
        .limit(1);
      currentRun = runValue ?? null;

      // Resilient start: run_started on a non-existent run with eventData
      // creates the run, so the queue can bootstrap a run whose creation
      // failed during start().
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
          // Create run + run_created event atomically. A plain INSERT on the
          // runs PK arbitrates the race (an upsert's affectedRows cannot:
          // mysql2 connects with CLIENT_FOUND_ROWS, so a lost race also
          // reports 1); only the creator writes the synthetic run_created.
          currentRun = await drizzle.transaction(async (tx) => {
            try {
              await tx.insert(schema.runs).values({
                runId: effectiveRunId,
                deploymentId: runInputData.deploymentId!,
                workflowName: runInputData.workflowName!,
                input: runInputData.input as SerializedContent,
                executionContext: runInputData.executionContext as SerializedContent | undefined,
                attributes: runInputData.attributes ?? {},
                // Mirrored here too: this path recreates a run from the
                // queued message, exactly when the key would otherwise be
                // lost for the rest of the run's life.
                encryptionPublicKey: runInputData.encryptionPublicKey,
                status: 'pending',
                specVersion: effectiveSpecVersion,
              });
            } catch (error: unknown) {
              if (!isDuplicateKeyError(error, 'workflow_runs.PRIMARY')) {
                throw error;
              }
              // Run already exists (concurrent run_created won the race).
              const [existing] = await tx
                .select({ status: schema.runs.status, specVersion: schema.runs.specVersion })
                .from(schema.runs)
                .where(eq(schema.runs.runId, effectiveRunId))
                .limit(1);
              return existing ?? null;
            }
            // This synthetic run_created is the run's first event, so it
            // opens the slot counter the rest of the run allocates from.
            const runCreatedEventId = await openEventSlots(tx, effectiveRunId);
            await tx.insert(events).values({
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
            return { status: 'pending', specVersion: effectiveSpecVersion };
          }, SLOT_INSERT_TRANSACTION);
        }
      }
    }

    // ============================================================
    // VERSION COMPATIBILITY
    // ============================================================
    if (currentRun) {
      const runSpecVersion = currentRun.specVersion;
      if (runSpecVersion !== null && requiresNewerWorld(runSpecVersion)) {
        throw new RunNotSupportedError(runSpecVersion, SPEC_VERSION_CURRENT);
      }
      if (isLegacySpecVersion(currentRun.specVersion ?? undefined)) {
        return handleLegacyEvent(
          drizzle,
          effectiveRunId,
          `wevt_${legacyEventUlid()}`,
          data as CreateEventRequest,
          currentRun,
          params,
        );
      }
    }

    if (!currentRun && (data.eventType === 'attr_set' || data.eventType === 'run_started')) {
      throw new WorkflowRunNotFoundError(effectiveRunId);
    }

    // Lazy step start: a step_started carrying step-creation data may arrive
    // with no prior step_created; it creates the step on the fly.
    const createsChildEntity = isChildEntityCreationEvent(data);
    const lazyStepStart = createsChildEntity && data.eventType === 'step_started';

    // Run terminal state validation
    if (currentRun && isTerminalWorkflowRunStatus(currentRun.status)) {
      // Idempotent operation: run_cancelled on already cancelled run is allowed
      if (data.eventType === 'run_cancelled' && currentRun.status === 'cancelled') {
        const fullRun = await fetchRun(drizzle, effectiveRunId, resolveData);
        const inserted = await appendEvent({
          runId: effectiveRunId,
          eventId: await getEventId(),
          correlationId: data.correlationId,
          eventType: data.eventType,
          eventData: 'eventData' in data ? data.eventData : undefined,
          occurredAt: params?.occurredAt,
          specVersion: effectiveSpecVersion,
        });
        if (!inserted) {
          throw new EntityConflictError(
            `run_cancelled for run "${effectiveRunId}" could not be created`,
          );
        }
        const parsed = EventSchema.parse({
          ...data,
          ...compact(inserted),
          runId: effectiveRunId,
        });
        return {
          event: stripEventDataRefs(parsed, resolveData),
          run: fullRun,
          ...(fullRun ? { maxEvents } : {}),
        };
      }

      // For run_started on terminal runs, RunExpiredError tells the runtime
      // to exit without retrying.
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
      // step_started creates a step, so it is rejected here too; a bare
      // step_started falls through to the step-validation block below.
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
      const [existingStep] = await drizzle
        .select({
          status: schema.steps.status,
          startedAt: schema.steps.startedAt,
          retryAfter: schema.steps.retryAfter,
        })
        .from(schema.steps)
        .where(
          and(eq(schema.steps.runId, effectiveRunId), eq(schema.steps.stepId, data.correlationId)),
        )
        .limit(1);

      validatedStep = existingStep ?? null;

      if (!validatedStep && !lazyStepStart) {
        throw new WorkflowWorldError(`Step "${data.correlationId}" not found`, { status: 404 });
      }
      // Lazy start exactly-once gate: a lazy step_started always CREATES the
      // step. If it already exists, a concurrent handler won the create; the
      // loser must not start or run the step (the start UPDATE below permits
      // re-starting a non-terminal step, which retries rely on).
      if (lazyStepStart && validatedStep) {
        throw new EntityConflictError(`Step "${data.correlationId}" already created`);
      }
      if (validatedStep) {
        if (isTerminalStepStatus(validatedStep.status as Step['status'])) {
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

    // Hook existence pre-check. Unlocked, so it settles only the case where
    // the hook was already gone; ordering against a concurrent disposal is
    // the row locks' job in the hook_disposed / hook_received branches.
    if (isHookEventRequiringExistence(data.eventType) && data.correlationId) {
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

    /** Guarded run transition + zero-row diagnosis shared by run terminals. */
    async function transitionRun(set: MySqlUpdateSetSource<typeof schema.runs>): Promise<void> {
      const [updated] = await drizzle
        .update(schema.runs)
        .set(set)
        .where(
          and(
            eq(schema.runs.runId, effectiveRunId),
            notInArray(schema.runs.status, [...TERMINAL_WORKFLOW_RUN_STATUSES]),
          ),
        );
      if (updated.affectedRows === 0) {
        const [existing] = await drizzle
          .select({ status: schema.runs.status })
          .from(schema.runs)
          .where(eq(schema.runs.runId, effectiveRunId))
          .limit(1);
        if (!existing) {
          throw new WorkflowRunNotFoundError(effectiveRunId);
        }
        if (isTerminalWorkflowRunStatus(existing.status)) {
          throw new EntityConflictError(
            `Cannot transition run from terminal state "${existing.status}"`,
          );
        }
      }
      run = await fetchRun(drizzle, effectiveRunId, resolveData);
    }

    /** Guarded step transition + zero-row diagnosis, from the root client. */
    async function transitionStep(set: MySqlUpdateSetSource<typeof schema.steps>): Promise<void> {
      const [updated] = await drizzle
        .update(schema.steps)
        .set(set)
        .where(
          and(
            eq(schema.steps.runId, effectiveRunId),
            eq(schema.steps.stepId, data.correlationId!),
            notInArray(schema.steps.status, terminalStepStatuses),
          ),
        );
      if (updated.affectedRows === 0) {
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
        if (isTerminalStepStatus(existing.status)) {
          throw new EntityConflictError(
            `Cannot modify step in terminal state "${existing.status}"`,
          );
        }
      } else {
        step = await fetchStep(drizzle, effectiveRunId, data.correlationId!, resolveData);
      }
    }

    let value: { createdAt: Date; occurredAt?: Date | null } | undefined;

    // Handle run_created: create the run entity, open the slot counter and
    // append the first event in ONE transaction, so a crash cannot leave a
    // run without its run_created event or slot marker.
    if (data.eventType === 'run_created') {
      const eventData = data.eventData;
      validateAttributeChanges(
        Object.entries(eventData.attributes ?? {}).map(([key, value]) => ({ key, value })),
        { allowReservedAttributes: eventData.allowReservedAttributes === true },
      );
      value = await drizzle.transaction(async (tx) => {
        try {
          await tx.insert(schema.runs).values({
            runId: effectiveRunId,
            deploymentId: eventData.deploymentId,
            workflowName: eventData.workflowName,
            input: eventData.input as SerializedContent,
            executionContext: eventData.executionContext as SerializedContent | undefined,
            attributes: eventData.attributes ?? {},
            encryptionPublicKey: eventData.encryptionPublicKey,
            status: 'pending',
            specVersion: effectiveSpecVersion,
          });
        } catch (error: unknown) {
          if (isDuplicateKeyError(error, 'workflow_runs.PRIMARY')) {
            // The resilient start path may have won a TOCTOU race. Surface
            // the conflict: start() treats EntityConflictError as benign,
            // and falling through would append a duplicate run_created.
            throw new EntityConflictError(`Workflow run "${effectiveRunId}" already exists`);
          }
          throw error;
        }
        // Opening the counter here, not lazily, is what makes "no marker"
        // mean "created before slots existed" for the run's whole life.
        eventId = await openEventSlots(tx, effectiveRunId);
        const inserted = await insertEventRow(tx, {
          runId: effectiveRunId,
          eventId,
          correlationId: data.correlationId,
          eventType: data.eventType,
          eventData: data.eventData,
          occurredAt: params?.occurredAt,
          specVersion: effectiveSpecVersion,
        });
        if (!inserted) {
          throw new EntityConflictError(
            `run_created for run "${effectiveRunId}" could not be created`,
          );
        }
        run = await fetchRun(tx, effectiveRunId, resolveData);
        return compact(inserted);
      }, SLOT_INSERT_TRANSACTION);
    }

    // Handle run_started event: update run status
    if (data.eventType === 'run_started') {
      // Idempotency: if the run is already running this is a replay. Return
      // the run without a duplicate event; the runtime falls back to
      // events.list for the log.
      if (currentRun?.status === 'running') {
        const fullRun = await fetchRun(drizzle, effectiveRunId, resolveData);
        return {
          run: fullRun,
          ...(fullRun ? { maxEvents } : {}),
        };
      }
      await transitionRun({ status: 'running', startedAt: now, updatedAt: now });
    }

    // Handle run terminal events: guarded UPDATE prevents transitioning an
    // already-terminal run.
    if (data.eventType === 'run_completed') {
      await transitionRun({
        status: 'completed',
        output: data.eventData?.output as SerializedContent | undefined,
        completedAt: now,
        updatedAt: now,
      });
    }
    if (data.eventType === 'run_failed') {
      // error is SerializedData from the serialization pipeline; stored
      // verbatim in the error_cbor column. errorCode is plaintext routing
      // metadata.
      await transitionRun({
        status: 'failed',
        error: data.eventData.error,
        errorCode: data.eventData.errorCode,
        completedAt: now,
        updatedAt: now,
      });
    }
    if (data.eventType === 'run_cancelled') {
      await transitionRun({ status: 'cancelled', completedAt: now, updatedAt: now });
    }

    if (isTerminalRunEventType(data.eventType)) {
      // Retained hooks stay visible after the run ends; other hooks and all
      // waits are removed immediately, releasing their tokens for reuse.
      await Promise.all([
        drizzle
          .delete(schema.hooks)
          .where(and(eq(schema.hooks.runId, effectiveRunId), hookRetentionEnded)),
        drizzle.delete(schema.waits).where(eq(schema.waits.runId, effectiveRunId)),
      ]);
    }

    if (data.eventType === 'attr_set') {
      const { changes, allowReservedAttributes } = data.eventData;
      // Dedup pre-check for correlated workflow writes: a redelivered
      // duplicate must be rejected BEFORE materializing onto the run, or a
      // pathological duplicate would mutate attributes and then fail the
      // event insert, desyncing snapshot and log.
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
        .select({ attributes: schema.runs.attributes })
        .from(schema.runs)
        .where(eq(schema.runs.runId, effectiveRunId))
        .limit(1);
      if (!existing) {
        throw new WorkflowRunNotFoundError(effectiveRunId);
      }
      validateAttributeChanges(changes, {
        existingKeys: Object.keys(existing.attributes ?? {}),
        allowReservedAttributes: allowReservedAttributes === true,
      });
      const expr = attributesMergeExpr(changes);
      const [updated] = await drizzle
        .update(schema.runs)
        .set({ attributes: expr, updatedAt: now })
        .where(
          and(
            eq(schema.runs.runId, effectiveRunId),
            sql`JSON_LENGTH(${expr}) <= ${ATTRIBUTE_MAX_PER_RUN}`,
          ),
        );
      if (updated.affectedRows === 0) {
        const [stillExists] = await drizzle
          .select({ runId: schema.runs.runId })
          .from(schema.runs)
          .where(eq(schema.runs.runId, effectiveRunId))
          .limit(1);
        if (!stillExists) {
          throw new WorkflowRunNotFoundError(effectiveRunId);
        }
        throw new AttributeValidationError(
          `Run attribute count would exceed limit ${ATTRIBUTE_MAX_PER_RUN}`,
        );
      }
      run = await fetchRun(drizzle, effectiveRunId, resolveData);
    }

    // Strip eventData from run_started (belongs on run_created only). For a
    // lazy step_started, strip only the step input: it belongs on the
    // synthetic step_created; stepName stays for the replay consumer's
    // divergence check.
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

    // Handle step_started: increment attempt and set the step running, then
    // write the matching event in the SAME transaction. The guarded UPDATE
    // takes the step row lock; keeping the event INSERT behind it prevents a
    // late step_started from being ordered after a concurrent terminal event.
    if (data.eventType === 'step_started') {
      value = await drizzle.transaction(async (tx) => {
        if (lazyStepStart && !validatedStep) {
          // The step INSERT is the ownership claim: only the caller that
          // inserts the row gets to run the step body inline.
          const lazyData = data.eventData as { stepName: string; input?: unknown };
          try {
            await tx.insert(schema.steps).values({
              runId: effectiveRunId,
              stepId: data.correlationId!,
              stepName: lazyData.stepName,
              input: lazyData.input as SerializedContent,
              status: 'pending',
              attempt: 0,
              specVersion: effectiveSpecVersion,
            });
          } catch (error: unknown) {
            if (isDuplicateKeyError(error, 'workflow_steps.PRIMARY')) {
              throw new EntityConflictError(`Step "${data.correlationId}" already created`);
            }
            throw error;
          }
          // Replay must observe step_created before step_started; both ride
          // this transaction so neither side of the materialization can be
          // left behind alone.
          try {
            await insertEventRow(tx, {
              runId: effectiveRunId,
              eventId: await allocateEventId(tx, effectiveRunId),
              correlationId: data.correlationId,
              eventType: 'step_created',
              eventData: { stepName: lazyData.stepName, input: lazyData.input },
              specVersion: effectiveSpecVersion,
            });
          } catch (error: unknown) {
            // A concurrent writer already published this step_created. The
            // event exists either way, which is all this write was for.
            if (!isDuplicateKeyError(error, 'workflow_events_entity_creation_unique')) {
              throw error;
            }
          }
          stepCreatedLazily = true;
        }

        // Retried steps may be scheduled for later; the runtime converts
        // TooEarlyError into a delayed re-enqueue.
        if (validatedStep?.retryAfter && validatedStep.retryAfter.getTime() > Date.now()) {
          throw new TooEarlyError(
            `Cannot start step "${data.correlationId}": retryAfter timestamp has not been reached yet`,
            { retryAfter: Math.ceil((validatedStep.retryAfter.getTime() - Date.now()) / 1000) },
          );
        }

        // The UPDATE repeats the terminal-state guard; that closes the race
        // where another writer completes/fails the step between validation
        // and start.
        const [updated] = await tx
          .update(schema.steps)
          .set({
            status: 'running',
            attempt: sql`${schema.steps.attempt} + 1`,
            // COALESCE preserves the first-start timestamp across retries.
            startedAt: sql`COALESCE(${schema.steps.startedAt}, ${toUtcSqlTimestamp(now)})`,
            retryAfter: null,
          })
          .where(
            and(
              eq(schema.steps.runId, effectiveRunId),
              eq(schema.steps.stepId, data.correlationId!),
              notInArray(schema.steps.status, terminalStepStatuses),
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

        // Allocate the step_started position only after the guarded UPDATE
        // holds the row lock, so a blocked writer cannot carry an earlier
        // position into a later insert.
        const inserted = await insertEventRow(tx, {
          runId: effectiveRunId,
          eventId: await allocateEventId(tx, effectiveRunId),
          correlationId: data.correlationId,
          eventType: data.eventType,
          eventData: storedEventData,
          occurredAt: params?.occurredAt,
          specVersion: effectiveSpecVersion,
        });
        if (!inserted) {
          throw new EntityConflictError(
            `Event for step "${data.correlationId}" could not be created`,
          );
        }
        eventId = inserted.eventId;
        return compact(inserted);
      }, SLOT_INSERT_TRANSACTION);
    }

    // Step terminal / retrying transitions: guarded UPDATEs from the root.
    if (data.eventType === 'step_completed') {
      await transitionStep({
        status: 'completed',
        output: data.eventData?.result as SerializedContent | undefined,
        completedAt: now,
      });
    }
    if (data.eventType === 'step_failed') {
      await transitionStep({
        status: 'failed',
        error: data.eventData?.error,
        completedAt: now,
      });
    }
    if (data.eventType === 'step_retrying') {
      await transitionStep({
        status: 'pending',
        error: data.eventData?.error,
        retryAfter: data.eventData?.retryAfter,
      });
    }

    // Handle hook_created event: create hook entity
    if (data.eventType === 'hook_created') {
      const eventData = data.eventData;

      // Check whether any live hook (retained, or on a non-terminal run)
      // already holds this token.
      const [existingHook] = await drizzle
        .select({ hookId: schema.hooks.hookId, runId: schema.hooks.runId })
        .from(schema.hooks)
        .where(and(eq(schema.hooks.token, eventData.token), hookAvailable))
        .limit(1);

      if (existingHook) {
        if (existingHook.runId === effectiveRunId && existingHook.hookId === data.correlationId) {
          // Same (runId, hookId): either a replayed/duplicate hook_created
          // or an orphaned hook row from a crash between the hook INSERT
          // and the event INSERT. Distinguish by whether the hook_created
          // event exists in the log (see vercel/workflow#2283).
          const [existingEvent] = await drizzle
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
          // Orphaned hook row: complete the partial write by falling through
          // to the event INSERT below, returning the persisted entity.
          const [recovered] = await drizzle
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
          const inserted = await appendEvent({
            runId: effectiveRunId,
            eventId: await getEventId(),
            correlationId: data.correlationId,
            eventType: 'hook_conflict',
            eventData: conflictEventData,
            occurredAt: params?.occurredAt,
            specVersion: effectiveSpecVersion,
          });
          if (!inserted) {
            throw new EntityConflictError(
              `hook_conflict for run "${effectiveRunId}" could not be created`,
            );
          }
          eventId = inserted.eventId;
          const parsedConflict = EventSchema.parse({
            eventType: 'hook_conflict' as const,
            correlationId: data.correlationId,
            eventData: conflictEventData,
            ...compact(inserted),
            runId: effectiveRunId,
            eventId,
          });
          const conflictResult: EventResult = {
            event: stripEventDataRefs(parsedConflict, resolveData),
            run,
            step,
            hook: undefined,
          };
          // Answering sinceCursor on hook_conflict is required whenever it
          // is answered on hook_created: both settle the same awaiter.
          if (typeof params?.sinceCursor === 'string') {
            const delta = await readEventsAfterCursor(
              effectiveRunId,
              params.sinceCursor,
              resolveData,
            );
            return { ...conflictResult, ...delta };
          }
          return conflictResult;
        }
      } else {
        // Clear token rows whose owning run is terminal and whose retention
        // has ended, then claim the token for this hook.
        await drizzle
          .delete(schema.hooks)
          .where(
            and(
              eq(schema.hooks.token, eventData.token),
              exists(ownerRunIsTerminal),
              hookRetentionEnded,
            ),
          );
        await drizzle
          .insert(schema.hooks)
          .values({
            runId: effectiveRunId,
            hookId: data.correlationId!,
            token: eventData.token,
            metadata: eventData.metadata as SerializedContent,
            // Multi-tenancy fields - not yet implemented, empty placeholders
            ownerId: '',
            projectId: '',
            environment: '',
            tokenRetentionUntil: eventData.tokenRetentionUntil,
            specVersion: effectiveSpecVersion,
            isWebhook: eventData.isWebhook,
            isSystem: eventData.isSystem ?? false,
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

    // Handle hook_disposed: delete the hook and append the disposal in ONE
    // transaction. The delete takes the hook row's lock and the transaction
    // holds it until the hook_disposed row exists, so a concurrent resume
    // cannot land its hook_received AFTER the disposal (vercel/workflow#2781).
    if (data.eventType === 'hook_disposed' && data.correlationId) {
      const disposedHookId = data.correlationId;
      value = await drizzle.transaction(async (tx) => {
        const [deleted] = await tx
          .delete(schema.hooks)
          .where(eq(schema.hooks.hookId, disposedHookId));
        if (deleted.affectedRows === 0) {
          throw new EntityConflictError(`Hook "${disposedHookId}" already disposed`);
        }
        // Allocated only after the lock is held: a writer that had to wait
        // must not carry an earlier position into a later insert.
        const inserted = await insertEventRow(tx, {
          runId: effectiveRunId,
          eventId: await allocateEventId(tx, effectiveRunId),
          correlationId: disposedHookId,
          eventType: data.eventType,
          eventData: storedEventData,
          occurredAt: params?.occurredAt,
          specVersion: effectiveSpecVersion,
        });
        if (!inserted) {
          throw new EntityConflictError(`Event for hook "${disposedHookId}" could not be created`);
        }
        eventId = inserted.eventId;
        return compact(inserted);
      }, SLOT_INSERT_TRANSACTION);
    }

    // Handle hook_received: append only if the run is not terminal. The run
    // row lock linearizes this insert against a concurrent terminal
    // transition; the hook row lock linearizes it against a disposal.
    if (data.eventType === 'hook_received') {
      value = await drizzle.transaction(async (tx) => {
        const [runRow] = await tx
          .select({ status: schema.runs.status })
          .from(schema.runs)
          .where(eq(schema.runs.runId, effectiveRunId))
          .limit(1)
          .for('update');
        if (!runRow) {
          throw new WorkflowRunNotFoundError(effectiveRunId);
        }
        if (isTerminalWorkflowRunStatus(runRow.status)) {
          throw new RunExpiredError(
            `Workflow run "${effectiveRunId}" is already in terminal state "${runRow.status}"`,
          );
        }
        // Re-check the hook under its own row lock: blocks on a disposer's
        // DELETE until its hook_disposed commit, then re-evaluates. The one
        // unreachable order is the corrupting one: a hook_received
        // journaled behind its hook's hook_disposed.
        if (data.correlationId) {
          const [liveHook] = await tx
            .select({ hookId: schema.hooks.hookId })
            .from(schema.hooks)
            .where(eq(schema.hooks.hookId, data.correlationId))
            .limit(1)
            .for('update');
          if (!liveHook) {
            throw new HookNotFoundError(data.correlationId);
          }
        }
        const inserted = await insertEventRow(tx, {
          runId: effectiveRunId,
          eventId: await allocateEventId(tx, effectiveRunId),
          correlationId: data.correlationId,
          eventType: data.eventType,
          eventData: storedEventData,
          occurredAt: params?.occurredAt,
          specVersion: effectiveSpecVersion,
        });
        if (!inserted) {
          throw new EntityConflictError(
            `Event for hook "${data.correlationId}" could not be created`,
          );
        }
        eventId = inserted.eventId;
        return compact(inserted);
      }, SLOT_INSERT_TRANSACTION);
    }

    // Handle wait_created event: create wait entity
    if (data.eventType === 'wait_created') {
      const waitId = `${effectiveRunId}-${data.correlationId}`;
      try {
        await drizzle.insert(schema.waits).values({
          waitId,
          runId: effectiveRunId,
          status: 'waiting',
          resumeAt: data.eventData?.resumeAt,
          specVersion: effectiveSpecVersion,
        });
      } catch (error: unknown) {
        if (isDuplicateKeyError(error, 'workflow_waits.PRIMARY')) {
          throw new EntityConflictError(`Wait "${data.correlationId}" already exists`);
        }
        throw error;
      }
      wait = await fetchWait(waitId);
    }

    // Handle wait_completed: conditional UPDATE rejects duplicate completions.
    if (data.eventType === 'wait_completed') {
      const waitId = `${effectiveRunId}-${data.correlationId}`;
      const [updated] = await drizzle
        .update(schema.waits)
        .set({ status: 'completed', completedAt: now })
        .where(and(eq(schema.waits.waitId, waitId), eq(schema.waits.status, 'waiting')));
      if (updated.affectedRows === 0) {
        const [existing] = await drizzle
          .select({ status: schema.waits.status })
          .from(schema.waits)
          .where(eq(schema.waits.waitId, waitId))
          .limit(1);
        if (!existing) {
          throw new WorkflowWorldError(`Wait "${data.correlationId}" not found`, { status: 404 });
        }
        if (existing.status === 'completed') {
          throw new EntityConflictError(`Wait "${data.correlationId}" already completed`);
        }
      } else {
        wait = await fetchWait(waitId);
      }
    }

    async function fetchWait(waitId: string): Promise<Wait | undefined> {
      const [row] = await drizzle
        .select()
        .from(schema.waits)
        .where(eq(schema.waits.waitId, waitId))
        .limit(1);
      if (!row) return undefined;
      return {
        waitId: row.waitId,
        runId: row.runId,
        status: row.status,
        resumeAt: row.resumeAt ?? undefined,
        completedAt: row.completedAt ?? undefined,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        specVersion: row.specVersion ?? undefined,
      };
    }

    // Generic event insert for every path that has not written one yet.
    try {
      if (!value) {
        let inserted: InsertedEventRow | undefined;
        if (data.eventType === 'step_created') {
          // Step + event commit atomically; a crash cannot leave a mutated
          // entity without the corresponding event.
          const created = await drizzle.transaction(async (tx) => {
            let stepValue: Step | undefined;
            try {
              await tx.insert(schema.steps).values({
                runId: effectiveRunId,
                stepId: data.correlationId!,
                stepName: data.eventData.stepName,
                input: data.eventData.input as SerializedContent,
                status: 'pending',
                attempt: 0,
                specVersion: effectiveSpecVersion,
              });
            } catch (error: unknown) {
              if (!isDuplicateKeyError(error, 'workflow_steps.PRIMARY')) {
                throw error;
              }
              const [existingEvent] = await tx
                .select({ eventId: events.eventId })
                .from(events)
                .where(
                  and(
                    eq(events.runId, effectiveRunId),
                    eq(events.correlationId, data.correlationId!),
                    eq(events.eventType, 'step_created'),
                  ),
                )
                .limit(1);
              if (existingEvent) {
                throw new EntityConflictError(
                  `step_created for correlationId "${data.correlationId}" already exists in run "${effectiveRunId}"`,
                );
              }
              // Orphaned row from a crashed partial write: keep the row and
              // complete the missing event inside this transaction.
            }
            stepValue = await fetchStep(tx, effectiveRunId, data.correlationId!, resolveData);
            if (!stepValue) {
              throw new EntityConflictError(
                `step_created for correlationId "${data.correlationId}" already exists in run "${effectiveRunId}"`,
              );
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
          step = created.stepValue;
          inserted = created.eventValue;
        } else {
          inserted = await appendEvent({
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
          value = compact(inserted);
        }
      }
    } catch (error: unknown) {
      // Translate the unique violation on the correlated-event functional
      // index into EntityConflictError, the dedup signal the runtime's
      // catch path expects. Gated on the index name so other duplicate-key
      // violations still propagate raw.
      const isDeduplicatedCorrelatedEvent =
        isChildEntityCreationEventType(data.eventType) ||
        (data.eventType === 'attr_set' && data.eventData.writer.type === 'workflow');
      if (
        isDeduplicatedCorrelatedEvent &&
        isDuplicateKeyError(error, 'workflow_events_entity_creation_unique')
      ) {
        throw new EntityConflictError(
          `${data.eventType} for correlationId "${data.correlationId}" already exists in run "${effectiveRunId}"`,
        );
      }
      throw error;
    }

    if (!value || !eventId) {
      throw new EntityConflictError(
        `${data.eventType} for run "${effectiveRunId}" could not be created`,
      );
    }

    const result = {
      ...data,
      ...value,
      runId: effectiveRunId,
      eventId,
      ...(storedEventData !== undefined ? { eventData: storedEventData } : {}),
    };
    // Strip eventData leaked by the ...data spread for run_started events.
    if (data.eventType === 'run_started') {
      delete (result as { eventData?: unknown }).eventData;
    }
    const parsed = EventSchema.parse(result);

    // The skipped-slot report and the inline delta share events/cursor/
    // hasMore. The delta wins: the skipped slots all sit above the cursor,
    // so it is a strict superset and the only one that advances cursor.
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
        // No cursor: the report is a lower bound on what this write skipped
        // over, not a page the caller has read to the end of.
        eventPage = { data: report.events, cursor: null, hasMore: report.hasMore };
      }
    }

    // Preload all events for run_started to reduce TTFB (skippable).
    if (data.eventType === 'run_started' && run && !params?.skipPreload) {
      const eventRows = await drizzle
        .select()
        .from(events)
        .where(eq(events.runId, effectiveRunId))
        .orderBy(events.eventId);
      const preload = eventRows.map((e) => {
        applyCborFallbackEvent(e);
        return stripEventDataRefs(EventSchema.parse(compact(e)), resolveData);
      });
      eventPage = { data: preload, cursor: preload.at(-1)?.eventId ?? null, hasMore: false };
    }

    // Inline delta: the page events.list({ cursor: sinceCursor }) would
    // return right now, saving the caller the round-trip.
    if (typeof params?.sinceCursor === 'string') {
      eventPage = await readEventsAfterCursor(effectiveRunId, params.sinceCursor, resolveData).then(
        (delta) => ({ data: delta.events, cursor: delta.cursor, hasMore: delta.hasMore }),
      );
    }

    const eventResult: EventResult = {
      event: stripEventDataRefs(parsed, resolveData),
      run,
      step,
      hook,
      wait,
      ...(stepCreatedLazily ? { stepCreated: true as const } : {}),
      ...(data.eventType === 'run_started' && run ? { maxEvents } : {}),
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
  };

  /** One `events.list` page strictly after `cursor`, for sinceCursor deltas. */
  async function readEventsAfterCursor(
    runId: string,
    cursor: string,
    resolveData: ResolveData,
  ): Promise<{ events: Event[]; cursor: string | null; hasMore: boolean }> {
    const limit = 100;
    const rows = await drizzle
      .select()
      .from(events)
      .where(and(eq(events.runId, runId), gt(events.eventId, cursor)))
      .orderBy(events.eventId)
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const data = page.map((e) => {
      applyCborFallbackEvent(e);
      return stripEventDataRefs(EventSchema.parse(compact(e)), resolveData);
    });
    return { events: data, cursor: data.at(-1)?.eventId ?? null, hasMore: rows.length > limit };
  }

  return {
    create: create as Storage['events']['create'],
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
      // No explicit limit means "every remaining event": page internally so
      // a full-log read is not truncated at one page.
      const limit = params.pagination?.limit ?? getMaxEventsPerRun();
      const sortOrder = params.pagination?.sortOrder ?? 'asc';
      const order =
        sortOrder === 'desc'
          ? { by: desc(events.eventId), compare: lt }
          : { by: events.eventId, compare: gt };
      const resolveData = params.resolveData ?? 'all';
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
              map(cursor, (c: string) => order.compare(events.eventId, c)),
            ),
          )
          .orderBy(order.by)
          .limit(pageLimit + 1);
        const page = rows.slice(0, pageLimit);
        for (const row of page) {
          applyCborFallbackEvent(row);
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
      const all = await drizzle
        .select()
        .from(events)
        .where(
          and(
            eq(events.correlationId, params.correlationId),
            // A correlation id names a step, hook or wait within its run,
            // not across runs; scoping is also what makes the event-id
            // cursor unambiguous, since (run_id, id) is the primary key.
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
  };
}

export function createHooksStorage(drizzle: Drizzle): Storage['hooks'] {
  const hooks = schema.hooks;
  const ownerRunIsTerminal = ownerRunIsTerminalSubquery(drizzle);
  // A hook is readable while its run lives or its retention holds its token.
  const available = or(gt(hooks.tokenRetentionUntil, sql`NOW(3)`), notExists(ownerRunIsTerminal));

  return {
    async get(hookId, params) {
      const [value] = await drizzle
        .select()
        .from(hooks)
        .where(and(eq(hooks.hookId, hookId), available))
        .limit(1);
      if (!value) {
        throw new HookNotFoundError(hookId);
      }
      value.metadata ||= value.metadataJson;
      const parsed = HookSchema.parse(compact(value));
      parsed.isWebhook ??= true;
      const resolveData = params?.resolveData ?? 'all';
      return filterHookData(parsed, resolveData);
    },
    async getByToken(token, params) {
      const [value] = await drizzle
        .select()
        .from(hooks)
        .where(and(eq(hooks.token, token), available))
        .limit(1);
      if (!value) {
        throw new HookNotFoundError(token);
      }
      value.metadata ||= value.metadataJson;
      const parsed = HookSchema.parse(compact(value));
      parsed.isWebhook ??= true;
      const resolveData = params?.resolveData ?? 'all';
      return filterHookData(parsed, resolveData);
    },
    async list(params: ListHooksParams) {
      const limit = params?.pagination?.limit ?? 100;
      const fromCursor = params?.pagination?.cursor;
      const sortOrder = params?.pagination?.sortOrder ?? 'asc';
      const cursorFn = sortOrder === 'asc' ? gt : lt;
      const orderBy = sortOrder === 'asc' ? hooks.hookId : desc(hooks.hookId);
      const all = await drizzle
        .select()
        .from(hooks)
        .where(
          and(
            available,
            map(params.runId, (id: string) => eq(hooks.runId, id)),
            map(fromCursor, (c: string) => cursorFn(hooks.hookId, c)),
          ),
        )
        .orderBy(orderBy)
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
    get: (async (runId: string, stepId: string, params?: any) => {
      const [value] = await drizzle
        .select(params?.resolveData === 'none' ? stepColumnsWithoutData : undefined)
        .from(steps)
        .where(and(eq(steps.runId, runId), eq(steps.stepId, stepId)))
        .limit(1);

      if (!value) {
        throw new WorkflowWorldError(`Step not found: ${stepId}`, {
          status: 404,
        });
      }
      applyCborFallbackStep(value);
      const parsed = StepSchema.parse(compact(value));
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
          const parsed = StepSchema.parse(compact(v));
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

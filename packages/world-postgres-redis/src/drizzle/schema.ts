import {
  type Event,
  type Hook,
  StepStatusSchema,
  type Step,
  type Wait,
  WaitStatusSchema,
  type WorkflowRun,
  WorkflowRunStatusSchema,
} from '@workflow/world';
import { sql } from 'drizzle-orm';
import {
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgEnum,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';
import { pgSchema } from 'drizzle-orm/pg-core';
import { Cbor, type Cborized } from './cbor.js';

function mustBeMoreThanOne<T>(t: T[]) {
  return t as [T, ...T[]];
}

export const schema = pgSchema('workflow');

export const workflowRunStatus = pgEnum(
  'status',
  mustBeMoreThanOne(WorkflowRunStatusSchema.options),
);

export const stepStatus = pgEnum('step_status', mustBeMoreThanOne(StepStatusSchema.options));

export const waitStatus = pgEnum('wait_status', mustBeMoreThanOne(WaitStatusSchema.options));

/**
 * A mapped type that converts all properties of T to Drizzle ORM column definitions,
 * marking them as not nullable if they are not optional in T.
 */
type DrizzlishOfType<T extends object> = {
  [key in keyof T]-?: undefined extends T[key]
    ? { _: { notNull: boolean } }
    : { _: { notNull: true } };
};

/**
 * Sadly we do `any[]` right now
 */
export type SerializedContent = any[];

export const runs = schema.table(
  'workflow_runs',
  {
    runId: varchar('id').primaryKey(),
    /** @deprecated */
    outputJson: jsonb('output').$type<SerializedContent>(),
    output: Cbor<SerializedContent>()('output_cbor'),
    deploymentId: varchar('deployment_id').notNull(),
    status: workflowRunStatus('status').notNull(),
    workflowName: varchar('name').notNull(),
    /** @deprecated */
    executionContextJson: jsonb('execution_context').$type<Record<string, any>>(),
    executionContext: Cbor<Record<string, any>>()('execution_context_cbor'),
    /** @deprecated */
    inputJson: jsonb('input').$type<SerializedContent>(),
    input: Cbor<SerializedContent>()('input_cbor'),
    /** @deprecated legacy JSON-stringified StructuredError; use `error` */
    errorJson: text('error'),
    /** run_failed error, stored verbatim as the serialized payload the
     * runtime hydrates via hydrateRunError. */
    error: Cbor<unknown>()('error_cbor'),
    /** Plaintext error category from run_failed (USER_ERROR, ...). */
    errorCode: varchar('error_code'),
    /** Plaintext string-string metadata set via `setAttributes()`. JSONB so
     * attr_set merges happen SQL-side without a read-modify-write. */
    attributes: jsonb('attributes').$type<Record<string, string>>().default({}).notNull(),
    /** The run's X25519 public key (base64), stamped at creation. Not secret. */
    encryptionPublicKey: varchar('encryption_public_key'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .defaultNow()
      .$onUpdateFn(() => new Date())
      .notNull(),
    completedAt: timestamp('completed_at'),
    startedAt: timestamp('started_at'),
    specVersion: integer('spec_version'),
    expiredAt: timestamp('expired_at'),
  } satisfies DrizzlishOfType<
    Cborized<
      Omit<WorkflowRun, 'input'> & { input?: unknown },
      'input' | 'output' | 'executionContext' | 'error'
    >
  >,
  (tb) => [index().on(tb.workflowName), index().on(tb.status)],
);

export const events = schema.table(
  'workflow_events',
  {
    eventId: varchar('id').notNull(),
    eventType: varchar('type').$type<Event['eventType']>().notNull(),
    correlationId: varchar('correlation_id'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    occurredAt: timestamp('occurred_at'),
    runId: varchar('run_id').notNull(),
    /** @deprecated */
    eventDataJson: jsonb('payload'),
    eventData: Cbor<unknown>()('payload_cbor'),
    specVersion: integer('spec_version'),
    // `resumeId` is omitted deliberately: this world does not advertise lazy
    // hook-resume dedup, so it never persists the resume idempotency key.
  } satisfies DrizzlishOfType<
    Cborized<Omit<Event, 'resumeId'> & { eventData?: undefined }, 'eventData'>
  >,
  (tb) => [
    // Event ids are per-run slot positions, so `evnt_...0001` exists once per
    // run and is only unique together with its run. Pre-slot runs keep
    // globally-unique ULIDs, which this key also admits. The key leads with
    // run_id, so every by-run lookup and range scan is served by it.
    primaryKey({ columns: [tb.runId, tb.eventId] }),
    index().on(tb.correlationId),
    // A redelivered creation event must conflict (surfaced as
    // EntityConflictError) instead of appending a second row. Partial so
    // repeatable event types stay unconstrained.
    uniqueIndex('workflow_events_entity_creation_unique')
      .on(tb.runId, tb.correlationId, tb.eventType)
      .where(sql`"type" IN ('step_created', 'hook_created', 'wait_created', 'attr_set')`),
  ],
);

/**
 * Which runs are slot-numbered. A row exists iff the run is, so its absence is
 * exactly the "this run predates slots, keep minting ULIDs" signal.
 *
 * A marker, not a counter: positions are allocated by the insert that occupies
 * them (max slot + 1 read inside the INSERT), so a failed write leaves its
 * position free instead of burning it into a permanent hole.
 */
export const eventSlots = schema.table('workflow_event_slots', {
  runId: varchar('run_id').primaryKey(),
});

export const steps = schema.table(
  'workflow_steps',
  {
    runId: varchar('run_id').notNull(),
    stepId: varchar('step_id').primaryKey(),
    stepName: varchar('step_name').notNull(),
    status: stepStatus('status').notNull(),
    /** @deprecated */
    inputJson: jsonb('input').$type<SerializedContent>(),
    input: Cbor<SerializedContent>()('input_cbor').notNull(),
    /** @deprecated */
    outputJson: jsonb('output').$type<SerializedContent>(),
    output: Cbor<SerializedContent>()('output_cbor'),
    /** @deprecated legacy JSON-stringified StructuredError; use `error` */
    errorJson: text('error'),
    /** step_failed / step_retrying error, stored verbatim as the serialized
     * payload the runtime hydrates via hydrateStepError. */
    error: Cbor<unknown>()('error_cbor'),
    attempt: integer('attempt').notNull(),
    startedAt: timestamp('started_at'),
    completedAt: timestamp('completed_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .defaultNow()
      .$onUpdateFn(() => new Date())
      .notNull(),
    retryAfter: timestamp('retry_after'),
    specVersion: integer('spec_version'),
  } satisfies DrizzlishOfType<Cborized<Step, 'input' | 'output' | 'error'>>,
  (tb) => [index().on(tb.runId), index().on(tb.status)],
);

export const hooks = schema.table(
  'workflow_hooks',
  {
    runId: varchar('run_id').notNull(),
    hookId: varchar('hook_id').primaryKey(),
    token: varchar('token').notNull(),
    ownerId: varchar('owner_id').notNull(),
    projectId: varchar('project_id').notNull(),
    environment: varchar('environment').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    tokenRetentionUntil: timestamp('token_retention_until', { withTimezone: true }),
    /** @deprecated */
    metadataJson: jsonb('metadata').$type<SerializedContent>(),
    metadata: Cbor<unknown>()('metadata_cbor'),
    specVersion: integer('spec_version'),
    isWebhook: boolean('is_webhook'),
    isSystem: boolean('is_system').default(false),
    // `resumeContext` / `resumeCapabilities` are response-only surfaces this
    // world does not persist, so they must not become columns.
  } satisfies DrizzlishOfType<
    Cborized<Omit<Hook, 'resumeContext' | 'resumeCapabilities'>, 'metadata'>
  >,
  // token is UNIQUE so concurrent hook_created calls for the same token
  // cannot both insert (the hook_created handler routes the loser to the
  // duplicate / hook_conflict paths).
  (tb) => [index().on(tb.runId), uniqueIndex('workflow_hooks_token_index').on(tb.token)],
);

export const waits = schema.table(
  'workflow_waits',
  {
    waitId: varchar('wait_id').primaryKey(),
    runId: varchar('run_id').notNull(),
    status: waitStatus('status').notNull(),
    resumeAt: timestamp('resume_at'),
    completedAt: timestamp('completed_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .defaultNow()
      .$onUpdateFn(() => new Date())
      .notNull(),
    specVersion: integer('spec_version'),
  } satisfies DrizzlishOfType<Wait>,
  (tb) => [index().on(tb.runId)],
);

export const outbox = schema.table(
  'workflow_outbox',
  {
    id: text('id').primaryKey(),
    messageId: text('message_id').notNull().unique(),
    payload: jsonb('payload').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    attempts: integer('attempts').default(0).notNull(),
    lastError: text('last_error'),
  },
  (tb) => [index('idx_outbox_unsent').on(tb.createdAt)],
);

const bytea = customType<{ data: Buffer; notNull: false; default: false }>({
  dataType() {
    return 'bytea';
  },
});

export const streams = schema.table(
  'workflow_stream_chunks',
  {
    chunkId: varchar('id').$type<`chnk_${string}`>().notNull(),
    streamId: varchar('stream_id').notNull(),
    /** Owning workflow run; nullable because pre-existing rows predate it. */
    runId: varchar('run_id'),
    chunkData: bytea('data').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    eof: boolean('eof').notNull(),
  },
  (tb) => [primaryKey({ columns: [tb.streamId, tb.chunkId] }), index().on(tb.runId)],
);

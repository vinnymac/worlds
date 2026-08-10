import {
  type Event,
  type Hook,
  type Step,
  StepStatusSchema,
  type WorkflowRun,
  WorkflowRunStatusSchema,
} from '@workflow/world';
import {
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgEnum,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';
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
    error: text('error'),
    attributes: jsonb('attributes').$type<Record<string, string>>().notNull().default({}),
    errorCode: varchar('error_code', { length: 255 }),
    encryptionPublicKey: text('encryption_public_key'),
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
      'input' | 'output' | 'executionContext'
    >
  >,
  (tb) => [index().on(tb.workflowName), index().on(tb.status)],
);

export const events = schema.table(
  'workflow_events',
  {
    eventId: varchar('id').primaryKey(),
    eventType: varchar('type').$type<Event['eventType']>().notNull(),
    correlationId: varchar('correlation_id'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    occurredAt: timestamp('occurred_at'),
    runId: varchar('run_id').notNull(),
    /** @deprecated */
    eventDataJson: jsonb('payload'),
    eventData: Cbor<unknown>()('payload_cbor'),
    specVersion: integer('spec_version'),
    resumeId: varchar('resume_id', { length: 255 }),
  } satisfies DrizzlishOfType<Cborized<Event & { eventData?: undefined }, 'eventData'>>,
  (tb) => [index().on(tb.runId), index().on(tb.correlationId)],
);

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
    error: text('error'),
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
  } satisfies DrizzlishOfType<Cborized<Step, 'input' | 'output'>>,
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
    /** @deprecated */
    metadataJson: jsonb('metadata').$type<SerializedContent>(),
    metadata: Cbor<unknown>()('metadata_cbor'),
    specVersion: integer('spec_version'),
    isWebhook: boolean('is_webhook'),
    isSystem: boolean('is_system'),
    tokenRetentionUntil: timestamp('token_retention_until'),
    /** @deprecated */
    resumeContextJson: jsonb('resume_context'),
    resumeContext: Cbor<unknown>()('resume_context_cbor'),
    /** @deprecated */
    resumeCapabilitiesJson: jsonb('resume_capabilities'),
    resumeCapabilities: Cbor<unknown>()('resume_capabilities_cbor'),
  } satisfies DrizzlishOfType<Cborized<Hook, 'metadata' | 'resumeContext' | 'resumeCapabilities'>>,
  // token is UNIQUE so concurrent hook_created calls for the same token
  // cannot both insert (the hook_created handler routes the loser to the
  // duplicate / hook_conflict paths).
  (tb) => [index().on(tb.runId), uniqueIndex('workflow_hooks_token_index').on(tb.token)],
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
    /** Owning workflow run — nullable because pre-existing rows predate it. */
    runId: varchar('run_id'),
    chunkData: bytea('data').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    eof: boolean('eof').notNull(),
  },
  (tb) => [primaryKey({ columns: [tb.streamId, tb.chunkId] }), index().on(tb.runId)],
);

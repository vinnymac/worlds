import {
  type Event,
  type Hook,
  type Step,
  StepStatusSchema,
  type WorkflowRun,
  WorkflowRunStatusSchema,
} from '@workflow/world';
import {
  bigint,
  boolean,
  customType,
  index,
  int,
  json,
  mysqlEnum,
  mysqlSchema,
  primaryKey,
  text,
  timestamp,
  varchar,
} from 'drizzle-orm/mysql-core';
import { Cbor, type Cborized } from './cbor.js';

function mustBeMoreThanOne<T>(t: T[]) {
  return t as [T, ...T[]];
}

const runStatusValues = mustBeMoreThanOne(WorkflowRunStatusSchema.options);
const stepStatusValues = mustBeMoreThanOne(StepStatusSchema.options);

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

export const schema = mysqlSchema('workflow');

/**
 * Optional `WorkflowRun` fields this World does not store yet. Each one is
 * optional surface the runtime routes around when absent (dynamic workflows,
 * per-run encryption keys).
 */
type UnpersistedRunFields = 'dynamicWorkflowCode' | 'encryptionPublicKey';

/** Optional `Hook` fields this World does not store yet (hook token
 * retention, durable resume capabilities, force-claim lineage). */
type UnpersistedHookFields =
  | 'isSystem'
  | 'tokenRetentionUntil'
  | 'resumeContext'
  | 'resumeCapabilities'
  | 'claimedFrom';

export const runs = schema.table(
  'workflow_runs',
  {
    runId: varchar('id', { length: 255 }).primaryKey(),
    /** @deprecated */
    outputJson: json('output').$type<SerializedContent>(),
    output: Cbor<SerializedContent>()('output_cbor'),
    deploymentId: varchar('deployment_id', { length: 255 }).notNull(),
    status: mysqlEnum('status', runStatusValues).notNull(),
    workflowName: varchar('name', { length: 255 }).notNull(),
    /** @deprecated */
    executionContextJson: json('execution_context').$type<Record<string, any>>(),
    executionContext: Cbor<Record<string, any>>()('execution_context_cbor'),
    /** @deprecated */
    inputJson: json('input').$type<SerializedContent>(),
    input: Cbor<SerializedContent>()('input_cbor'),
    /** @deprecated legacy JSON-stringified `{ message, stack, code }` */
    errorJson: text('error'),
    /** The thrown value as the runtime serialized it, stored verbatim. */
    error: Cbor<unknown>()('error_cbor'),
    errorCode: varchar('error_code', { length: 255 }),
    /** Run attributes, set by run_created and attr_set. */
    attributes: json('attributes').$type<Record<string, string>>(),
    createdAt: timestamp('created_at', { fsp: 3 }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { fsp: 3 })
      .defaultNow()
      .$onUpdateFn(() => new Date())
      .notNull(),
    completedAt: timestamp('completed_at', { fsp: 3 }),
    startedAt: timestamp('started_at', { fsp: 3 }),
    specVersion: int('spec_version'),
    expiredAt: timestamp('expired_at', { fsp: 3 }),
    /** How many events the run's log holds, which is also the slot of its
     * latest event. Advanced in the transaction that appends each event (see
     * `insertEvent`). Not part of the `WorkflowRun` contract, stripped before
     * return. */
    eventCount: int('event_count').default(0).notNull(),
  } satisfies DrizzlishOfType<
    Cborized<
      // Nullable column: WorkflowRunSchema reads a missing value as {}.
      Omit<WorkflowRun, 'input' | 'attributes' | UnpersistedRunFields> & {
        input?: unknown;
        attributes?: Record<string, string>;
      },
      'input' | 'output' | 'executionContext' | 'error'
    > & { eventCount: number; errorJson?: string }
  >,
  (tb) => [
    index('idx_workflow_runs_name').on(tb.workflowName),
    index('idx_workflow_runs_status').on(tb.status),
  ],
);

export const events = schema.table(
  'workflow_events',
  {
    eventId: varchar('id', { length: 255 }).notNull(),
    eventType: varchar('type', { length: 255 }).$type<Event['eventType']>().notNull(),
    correlationId: varchar('correlation_id', { length: 255 }),
    createdAt: timestamp('created_at', { fsp: 3 }).defaultNow().notNull(),
    occurredAt: timestamp('occurred_at', { fsp: 3 }),
    runId: varchar('run_id', { length: 255 }).notNull(),
    /** @deprecated */
    eventDataJson: json('payload'),
    eventData: Cbor<unknown>()('payload_cbor'),
    specVersion: int('spec_version'),
  } satisfies DrizzlishOfType<
    Cborized<Omit<Event, 'resumeId'> & { eventData?: undefined }, 'eventData'>
  >,
  (tb) => [
    // Event ids are slot positions within a run, so they are unique only
    // together with the run id.
    primaryKey({ columns: [tb.runId, tb.eventId] }),
    index('idx_workflow_events_run_id').on(tb.runId),
    index('idx_workflow_events_correlation_id').on(tb.correlationId),
  ],
);

export const steps = schema.table(
  'workflow_steps',
  {
    runId: varchar('run_id', { length: 255 }).notNull(),
    stepId: varchar('step_id', { length: 255 }).primaryKey(),
    stepName: varchar('step_name', { length: 255 }).notNull(),
    status: mysqlEnum('status', stepStatusValues).notNull(),
    /** @deprecated */
    inputJson: json('input').$type<SerializedContent>(),
    input: Cbor<SerializedContent>()('input_cbor'),
    /** @deprecated we stream binary data */
    outputJson: json('output').$type<SerializedContent>(),
    output: Cbor<SerializedContent>()('output_cbor'),
    /** @deprecated legacy JSON-stringified `{ message, stack }` */
    errorJson: text('error'),
    /** The thrown value as the runtime serialized it, stored verbatim. */
    error: Cbor<unknown>()('error_cbor'),
    attempt: int('attempt').notNull(),
    startedAt: timestamp('started_at', { fsp: 3 }),
    completedAt: timestamp('completed_at', { fsp: 3 }),
    createdAt: timestamp('created_at', { fsp: 3 }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { fsp: 3 })
      .defaultNow()
      .$onUpdateFn(() => new Date())
      .notNull(),
    retryAfter: timestamp('retry_after', { fsp: 3 }),
    specVersion: int('spec_version'),
  } satisfies DrizzlishOfType<
    Cborized<Omit<Step, 'input'> & { input?: unknown }, 'output' | 'input' | 'error'> & {
      errorJson?: string;
    }
  >,
  (tb) => [
    index('idx_workflow_steps_run_id').on(tb.runId),
    index('idx_workflow_steps_status').on(tb.status),
  ],
);

export const hooks = schema.table(
  'workflow_hooks',
  {
    runId: varchar('run_id', { length: 255 }).notNull(),
    hookId: varchar('hook_id', { length: 255 }).primaryKey(),
    token: varchar('token', { length: 255 }).notNull(),
    ownerId: varchar('owner_id', { length: 255 }).notNull(),
    projectId: varchar('project_id', { length: 255 }).notNull(),
    environment: varchar('environment', { length: 255 }).notNull(),
    createdAt: timestamp('created_at', { fsp: 3 }).defaultNow().notNull(),
    /** @deprecated */
    metadataJson: json('metadata').$type<SerializedContent>(),
    metadata: Cbor<SerializedContent>()('metadata_cbor'),
    specVersion: int('spec_version'),
    isWebhook: boolean('is_webhook'),
  } satisfies DrizzlishOfType<Cborized<Omit<Hook, UnpersistedHookFields>, 'metadata'>>,
  (tb) => [
    index('idx_workflow_hooks_run_id').on(tb.runId),
    index('idx_workflow_hooks_token').on(tb.token),
  ],
);

const blob = customType<{ data: Buffer; notNull: false; default: false }>({
  dataType() {
    return 'mediumblob';
  },
});

export const streams = schema.table(
  'workflow_stream_chunks',
  {
    chunkId: varchar('id', { length: 255 }).$type<`chnk_${string}`>().notNull(),
    streamId: varchar('stream_id', { length: 255 }).notNull(),
    runId: varchar('run_id', { length: 255 }),
    chunkData: blob('data').notNull(),
    createdAt: timestamp('created_at', { fsp: 3 }).defaultNow().notNull(),
    eof: boolean('eof').notNull(),
    /** @deprecated ordering uses the monotonic ULID chunkId; kept for legacy rows */
    sequence: bigint('sequence', { mode: 'number' }).notNull(),
  },
  (tb) => [
    primaryKey({ columns: [tb.streamId, tb.chunkId] }),
    index('idx_stream_chunks_sequence').on(tb.streamId, tb.sequence),
    index('idx_stream_chunks_run_id').on(tb.runId),
  ],
);

// ============================================================
// Queue tables for pure MySQL queue implementation
// ============================================================

export const jobs = schema.table(
  'workflow_jobs',
  {
    id: bigint('id', { mode: 'number' }).autoincrement().primaryKey(),
    jobId: varchar('job_id', { length: 255 }).notNull().unique(),
    queueName: varchar('queue_name', { length: 255 }).notNull(),
    /** The effective enqueue idempotency key, released when the job completes */
    idempotencyKey: varchar('idempotency_key', { length: 255 }),
    payload: blob('payload').notNull(),
    status: mysqlEnum('status', ['pending', 'processing', 'failed']).notNull().default('pending'),
    attempt: int('attempt').notNull().default(0),
    maxAttempts: int('max_attempts').notNull().default(3),
    createdAt: timestamp('created_at', { fsp: 3 }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { fsp: 3 })
      .defaultNow()
      .$onUpdateFn(() => new Date())
      .notNull(),
    lockedAt: timestamp('locked_at', { fsp: 3 }),
    lockedBy: varchar('locked_by', { length: 255 }),
    /** Fencing token set per claim; settles must match it */
    claimToken: varchar('claim_token', { length: 64 }),
    error: text('error'),
    scheduledFor: timestamp('scheduled_for', { fsp: 3 }),
  },
  (tb) => [
    index('idx_jobs_queue_status').on(tb.queueName, tb.status, tb.id),
    index('idx_jobs_scheduled').on(tb.scheduledFor),
  ],
);

export const idempotency = schema.table(
  'workflow_job_idempotency',
  {
    idempotencyKey: varchar('idempotency_key', { length: 255 }).primaryKey(),
    messageId: varchar('message_id', { length: 255 }).notNull(),
    queueName: varchar('queue_name', { length: 255 }).notNull(),
    createdAt: timestamp('created_at', { fsp: 3 }).defaultNow().notNull(),
  },
  (tb) => [index('idx_idempotency_created').on(tb.createdAt)],
);

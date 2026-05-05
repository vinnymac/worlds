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
    error: text('error'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .defaultNow()
      .$onUpdateFn(() => new Date())
      .notNull(),
    completedAt: timestamp('completed_at'),
    startedAt: timestamp('started_at'),
    specVersion: int('spec_version'),
    expiredAt: timestamp('expired_at'),
  } satisfies DrizzlishOfType<
    Cborized<
      Omit<WorkflowRun, 'input'> & { input?: unknown },
      'input' | 'output' | 'executionContext'
    >
  >,
  (tb) => [
    index('idx_workflow_runs_name').on(tb.workflowName),
    index('idx_workflow_runs_status').on(tb.status),
  ],
);

export const events = schema.table(
  'workflow_events',
  {
    eventId: varchar('id', { length: 255 }).primaryKey(),
    eventType: varchar('type', { length: 255 }).$type<Event['eventType']>().notNull(),
    correlationId: varchar('correlation_id', { length: 255 }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    runId: varchar('run_id', { length: 255 }).notNull(),
    /** @deprecated */
    eventDataJson: json('payload'),
    eventData: Cbor<unknown>()('payload_cbor'),
    specVersion: int('spec_version'),
  } satisfies DrizzlishOfType<Cborized<Event & { eventData?: undefined }, 'eventData'>>,
  (tb) => [
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
    error: text('error'),
    attempt: int('attempt').notNull(),
    startedAt: timestamp('started_at'),
    completedAt: timestamp('completed_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .defaultNow()
      .$onUpdateFn(() => new Date())
      .notNull(),
    retryAfter: timestamp('retry_after'),
    specVersion: int('spec_version'),
  } satisfies DrizzlishOfType<
    Cborized<Omit<Step, 'input'> & { input?: unknown }, 'output' | 'input'>
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
    createdAt: timestamp('created_at').defaultNow().notNull(),
    /** @deprecated */
    metadataJson: json('metadata').$type<SerializedContent>(),
    metadata: Cbor<SerializedContent>()('metadata_cbor'),
    specVersion: int('spec_version'),
    isWebhook: boolean('is_webhook'),
  } satisfies DrizzlishOfType<Cborized<Hook, 'metadata'>>,
  (tb) => [
    index('idx_workflow_hooks_run_id').on(tb.runId),
    index('idx_workflow_hooks_token').on(tb.token),
  ],
);

const blob = customType<{ data: Buffer; notNull: false; default: false }>({
  dataType() {
    return 'blob';
  },
});

export const streams = schema.table(
  'workflow_stream_chunks',
  {
    chunkId: varchar('id', { length: 255 }).$type<`chnk_${string}`>().notNull(),
    streamId: varchar('stream_id', { length: 255 }).notNull(),
    chunkData: blob('data').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    eof: boolean('eof').notNull(),
    sequence: bigint('sequence', { mode: 'number' }).notNull(),
  },
  (tb) => [
    primaryKey({ columns: [tb.streamId, tb.chunkId] }),
    index('idx_stream_chunks_sequence').on(tb.streamId, tb.sequence),
  ],
);

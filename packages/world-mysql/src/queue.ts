import { setTimeout as delay } from 'node:timers/promises';
import {
  MessageId,
  parseQueueName,
  type Queue,
  type QueueKind,
  type QueueOptions,
  type QueuePayload,
  type ValidQueueName,
} from '@workflow/world';
import { createWorkflowUrl } from '@workflow/utils';
import { decode, encode } from 'cbor-x';
import { and, eq, type SQL, sql } from 'drizzle-orm';
import type { MySql2Database } from 'drizzle-orm/mysql2';
import { monotonicFactory, ulid } from 'ulid';
import { type QueueMetrics, metrics } from './metrics.js';
import * as schema from './schema.js';
import { debug } from './util.js';

type Drizzle = MySql2Database<typeof schema>;

const QUEUE_PATHNAMES = {
  workflow: 'flow',
  step: 'step',
} as const satisfies Record<QueueKind, string>;

export interface MysqlQueueConfig {
  /** Poll interval in milliseconds (default: 100) */
  pollIntervalMs?: number;
  /** Number of concurrent workers per queue prefix (default: 10) */
  concurrency?: number;
  /** Maximum attempts before marking as failed (default: 3) */
  maxAttempts?: number;
  /** Worker ID for lock tracking */
  workerId?: string;
  /** TTL for idempotency records in milliseconds (default: 5 minutes) */
  idempotencyTtlMs?: number;
  /** How often to run idempotency cleanup in milliseconds (default: 60 seconds) */
  cleanupIntervalMs?: number;
  /**
   * How long a job may stay in 'processing' before it is considered orphaned
   * (worker crashed mid-dispatch) and reclaimed. Must exceed the HTTP dispatch
   * timeout. Default: httpTimeoutMs + 60_000
   */
  visibilityTimeoutMs?: number;
  /**
   * Base URL the worker uses to dispatch jobs back to the user's HTTP server.
   * Default: process.env.WORKFLOW_BASE_URL || `http://localhost:${process.env.PORT ?? 3000}`
   */
  baseUrl?: string;
  /** Per-job HTTP request timeout (ms). Default: 300_000 */
  httpTimeoutMs?: number;
}

interface JobEnvelope {
  queueName: ValidQueueName;
  message: QueuePayload;
}

/**
 * MySQL errnos the queue's start-up probe reads as "migrations have not run".
 * Anything else (auth, connectivity) propagates untouched.
 */
const UNMIGRATED_ERRNOS = new Set([
  1054, // ER_BAD_FIELD_ERROR
  1146, // ER_NO_SUCH_TABLE
]);

function isUnmigratedError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'errno' in error &&
    typeof error.errno === 'number' &&
    UNMIGRATED_ERRNOS.has(error.errno)
  );
}

/** `max_attempts` column default, also the enqueue-time default for new rows. */
const DEFAULT_MAX_ATTEMPTS = 3;

/** Row shape returned by raw SQL SELECT on workflow_jobs (snake_case columns) */
export interface RawJobRow {
  id: number;
  job_id: string;
  queue_name: string;
  idempotency_key: string | null;
  payload: Buffer;
  status: string;
  attempt: number;
  max_attempts: number;
  created_at: Date;
  updated_at: Date;
  locked_at: Date | null;
  locked_by: string | null;
  claim_token: string | null;
  error: string | null;
  scheduled_for: Date | null;
}

function resolveBaseUrl(config: MysqlQueueConfig): string {
  if (config.baseUrl) return config.baseUrl;
  if (process.env.WORKFLOW_BASE_URL) return process.env.WORKFLOW_BASE_URL;
  const port = process.env.PORT ?? '3000';
  return `http://localhost:${port}`;
}

/**
 * JSON transport that preserves Uint8Array values via a tagged envelope
 * ({ __type: 'Uint8Array', data: '<base64>' }). Required for the resilient
 * start path where runInput.input (binary serialized data) is sent through
 * the queue; plain JSON.stringify would mangle it into index-keyed objects.
 */
function encodeTaggedJson(value: unknown): string {
  // Pre-walk instead of a JSON.stringify replacer: Buffer.prototype.toJSON
  // runs before the replacer sees the value, so a replacer alone would miss
  // Buffers (which CBOR decoding produces for binary data).
  const tag = (v: unknown): unknown => {
    if (v instanceof Uint8Array) {
      return { __type: 'Uint8Array', data: Buffer.from(v).toString('base64') };
    }
    if (Array.isArray(v)) {
      return v.map(tag);
    }
    if (v !== null && typeof v === 'object' && !(v instanceof Date)) {
      const out: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(v)) {
        out[key] = tag(val);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(tag(value));
}

function decodeTaggedJson(text: string): unknown {
  return JSON.parse(text, (_key, v: unknown) => {
    if (
      v !== null &&
      typeof v === 'object' &&
      (v as { __type?: unknown }).__type === 'Uint8Array' &&
      typeof (v as { data?: unknown }).data === 'string'
    ) {
      return new Uint8Array(Buffer.from((v as { data: string }).data, 'base64'));
    }
    return v;
  });
}

/**
 * Delete expired idempotency keys, but only when the deduped job is gone
 * (completed jobs are deleted; their keys are released in completeJob).
 * Keys whose job is still pending/processing, e.g. scheduled far in the
 * future by a 503 timeoutSeconds or a long retryAfter, must survive the
 * TTL, otherwise a replay re-enqueue would insert a duplicate job.
 */
export async function cleanupExpiredIdempotencyKeys(db: Drizzle, ttlMs: number): Promise<number> {
  // Compute the cutoff server-side: binding a JS Date through raw SQL uses
  // the driver's local timezone while drizzle-written timestamps are UTC.
  const ttlSeconds = Math.ceil(ttlMs / 1000);

  const result = await db.execute(sql`
    DELETE i FROM \`workflow\`.\`workflow_job_idempotency\` i
    WHERE i.\`created_at\` < DATE_SUB(NOW(3), INTERVAL ${ttlSeconds} SECOND)
      AND NOT EXISTS (
        SELECT 1 FROM \`workflow\`.\`workflow_jobs\` j
        WHERE j.\`job_id\` = i.\`message_id\`
          AND j.\`status\` IN ('pending', 'processing')
      )
  `);

  const affectedRows =
    (result as unknown as [{ affectedRows: number }, unknown])[0]?.affectedRows ?? 0;
  debug('Cleaned up expired idempotency keys', {
    affectedRows,
    ttlSeconds,
  });
  return affectedRows;
}

/**
 * Reclaim jobs orphaned in 'processing' by a crashed/restarted worker:
 * reset them to 'pending' so another worker picks them up, or mark them
 * 'failed' when their attempts are exhausted. Without this, any process
 * death between fetchJob's commit and completeJob strands the run forever.
 */
export async function reclaimStaleJobs(db: Drizzle, visibilityTimeoutMs: number): Promise<number> {
  // Compute the cutoff server-side: binding a JS Date through raw SQL uses
  // the driver's local timezone while drizzle-written timestamps are UTC.
  const timeoutSeconds = Math.ceil(visibilityTimeoutMs / 1000);

  const reset = await db.execute(sql`
    UPDATE \`workflow\`.\`workflow_jobs\`
    SET \`status\` = 'pending',
        \`locked_at\` = NULL,
        \`locked_by\` = NULL,
        \`claim_token\` = NULL,
        \`updated_at\` = NOW(3)
    WHERE \`status\` = 'processing'
      AND \`locked_at\` < DATE_SUB(NOW(3), INTERVAL ${timeoutSeconds} SECOND)
      AND \`attempt\` < \`max_attempts\`
  `);
  const resetRows = (reset as unknown as [{ affectedRows: number }, unknown])[0]?.affectedRows ?? 0;

  const failed = await db.execute(sql`
    UPDATE \`workflow\`.\`workflow_jobs\`
    SET \`status\` = 'failed',
        \`error\` = 'Job lock expired: worker crashed or timed out',
        \`locked_at\` = NULL,
        \`locked_by\` = NULL,
        \`claim_token\` = NULL,
        \`updated_at\` = NOW(3)
    WHERE \`status\` = 'processing'
      AND \`locked_at\` < DATE_SUB(NOW(3), INTERVAL ${timeoutSeconds} SECOND)
      AND \`attempt\` >= \`max_attempts\`
  `);
  const failedRows =
    (failed as unknown as [{ affectedRows: number }, unknown])[0]?.affectedRows ?? 0;

  if (resetRows > 0 || failedRows > 0) {
    debug('Reclaimed stale processing jobs', {
      resetRows,
      failedRows,
      timeoutSeconds,
    });
  }
  return resetRows + failedRows;
}

export async function fetchJob(
  db: Drizzle,
  queueName: string,
  workerId: string,
): Promise<RawJobRow | null> {
  return await db.transaction(async (tx) => {
    const rawResult = await tx.execute(sql`
      SELECT * FROM \`workflow\`.\`workflow_jobs\`
      WHERE \`queue_name\` = ${queueName}
        AND \`status\` = 'pending'
        AND (\`scheduled_for\` IS NULL OR \`scheduled_for\` <= NOW())
      ORDER BY \`id\` ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    `);

    const outerResult = rawResult as unknown as [RawJobRow[], unknown];
    const rows = outerResult[0];
    if (!rows || rows.length === 0) return null;
    const job = rows[0];
    if (!job || !job.id) return null;

    const claimToken = ulid();
    await tx.execute(sql`
      UPDATE \`workflow\`.\`workflow_jobs\`
      SET \`status\` = 'processing',
          \`locked_at\` = NOW(),
          \`locked_by\` = ${workerId},
          \`claim_token\` = ${claimToken},
          \`attempt\` = \`attempt\` + 1,
          \`updated_at\` = NOW()
      WHERE \`id\` = ${job.id}
    `);

    return {
      ...job,
      status: 'processing',
      locked_by: workerId,
      claim_token: claimToken,
      attempt: (job.attempt ?? 0) + 1,
    };
  });
}

async function enqueueJob(
  db: Drizzle,
  queueName: string,
  envelope: JobEnvelope,
  opts?: { idempotencyKey?: string; delaySeconds?: number; maxAttempts?: number },
): Promise<{ messageId: MessageId }> {
  const generateId = monotonicFactory();
  const messageId = MessageId.parse(`msg_${generateId()}`);
  const idempotencyKey = opts?.idempotencyKey ?? messageId;

  try {
    return await db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(schema.idempotency)
        .where(eq(schema.idempotency.idempotencyKey, idempotencyKey))
        .limit(1);

      if (existing) {
        return { messageId: MessageId.parse(existing.messageId) };
      }

      const scheduledFor = opts?.delaySeconds
        ? new Date(Date.now() + opts.delaySeconds * 1000)
        : null;

      await tx.insert(schema.idempotency).values({
        idempotencyKey,
        messageId,
        queueName,
      });

      await tx.insert(schema.jobs).values({
        jobId: messageId,
        queueName,
        // Persist the effective key so job completion can release it
        idempotencyKey,
        payload: Buffer.from(encode(envelope)),
        status: 'pending',
        maxAttempts: opts?.maxAttempts ?? 3,
        scheduledFor,
      });

      return { messageId };
    });
  } catch (error: unknown) {
    // Concurrent INSERTs racing on the same idempotency key; treat the
    // duplicate-key error as a hit.
    const errorCode =
      (error as { code?: string; cause?: { code?: string } })?.code ??
      (error as { cause?: { code?: string } })?.cause?.code;

    if (errorCode === 'ER_DUP_ENTRY') {
      const [existing] = await db
        .select()
        .from(schema.idempotency)
        .where(eq(schema.idempotency.idempotencyKey, idempotencyKey))
        .limit(1);

      if (existing) {
        return { messageId: MessageId.parse(existing.messageId) };
      }
      return { messageId };
    }
    throw error;
  }
}

/**
 * WHERE clause matching only the claim this executor holds. A reclaim clears
 * the token and a redelivery sets a new one, so a stalled executor's settle
 * matches nothing. `<=>` lets a NULL token match NULL (pre-migration claims);
 * the status check stops that from settling an unclaimed row by id alone.
 */
function claimedBy(job: RawJobRow): SQL | undefined {
  return and(
    eq(schema.jobs.id, job.id),
    eq(schema.jobs.status, 'processing'),
    sql`${schema.jobs.claimToken} <=> ${job.claim_token}`,
    sql`${schema.jobs.lockedBy} <=> ${job.locked_by}`,
  );
}

/**
 * mysql2 connects with CLIENT_FOUND_ROWS, so affectedRows counts matched rows
 * (not changed rows) for UPDATE; 0 means the claim is no longer ours.
 */
function isStaleSettle(
  result: [{ affectedRows: number }, unknown],
  job: RawJobRow,
  op: string,
): boolean {
  if (result[0].affectedRows > 0) return false;
  debug('Ignoring stale settle for reclaimed job', {
    op,
    jobId: job.job_id,
    attempt: job.attempt,
    lockedBy: job.locked_by,
  });
  return true;
}

/**
 * Release the job's own key reservation. Matching `message_id` keeps a delayed
 * release from deleting a key that expired and was re-reserved by a newer job.
 */
async function releaseIdempotencyKey(db: Drizzle, job: RawJobRow, key: string): Promise<void> {
  await db
    .delete(schema.idempotency)
    .where(
      and(eq(schema.idempotency.idempotencyKey, key), eq(schema.idempotency.messageId, job.job_id)),
    );
}

/** Returns false when the claim was lost and the settle did nothing. */
export async function handleJobFailure(
  db: Drizzle,
  job: RawJobRow,
  error: unknown,
): Promise<boolean> {
  const errorMessage = error instanceof Error ? error.message : String(error);
  const attempt = job.attempt ?? 1;
  const maxAttempts = job.max_attempts ?? DEFAULT_MAX_ATTEMPTS;

  if (attempt >= maxAttempts) {
    const updated = await db
      .update(schema.jobs)
      .set({
        status: 'failed',
        error: errorMessage,
        lockedAt: null,
        lockedBy: null,
        claimToken: null,
      })
      .where(claimedBy(job));
    if (isStaleSettle(updated, job, 'fail')) return false;
    // Permanent failure: release the idempotency key so the failed job does
    // not block a future re-enqueue of the same logical message.
    if (job.idempotency_key) {
      await releaseIdempotencyKey(db, job, job.idempotency_key);
    }
    return true;
  }
  const backoffMs = Math.min(1000 * 2 ** (attempt - 1), 30000);
  const scheduledFor = new Date(Date.now() + backoffMs);

  const updated = await db
    .update(schema.jobs)
    .set({
      status: 'pending',
      error: errorMessage,
      lockedAt: null,
      lockedBy: null,
      claimToken: null,
      scheduledFor,
    })
    .where(claimedBy(job));
  return !isStaleSettle(updated, job, 'retry');
}

/**
 * Returns false when the claim was lost and the settle did nothing. `onSettled`
 * runs the moment the row is gone, before the idempotency key is released, so a
 * throw from that release cannot unrecord a job that did complete.
 */
export async function completeJob(
  db: Drizzle,
  job: RawJobRow,
  onSettled?: () => void,
): Promise<boolean> {
  const deleted = await db.delete(schema.jobs).where(claimedBy(job));
  // A stale executor must not release the key the live claim still owns.
  if (isStaleSettle(deleted, job, 'complete')) return false;
  onSettled?.();
  // Release the idempotency key recorded at enqueue time. Rows written
  // before the idempotency_key column existed fall back to the messageId,
  // which was the default key.
  await releaseIdempotencyKey(db, job, job.idempotency_key ?? job.job_id);
  return true;
}

/**
 * Re-schedule after a 503 timeoutSeconds without consuming an attempt.
 * Returns false when the claim was lost and the settle did nothing.
 */
export async function rescheduleJob(
  db: Drizzle,
  job: RawJobRow,
  timeoutMs: number,
): Promise<boolean> {
  const updated = await db
    .update(schema.jobs)
    .set({
      status: 'pending',
      lockedAt: null,
      lockedBy: null,
      claimToken: null,
      scheduledFor: new Date(Date.now() + timeoutMs),
      attempt: Math.max(0, (job.attempt ?? 1) - 1),
    })
    .where(claimedBy(job));
  return !isStaleSettle(updated, job, 'reschedule');
}

/**
 * Pure MySQL queue: jobs are rows in `workflow_jobs`, picked with FOR UPDATE
 * SKIP LOCKED. Worker dispatches via HTTP fetch to the user's server.
 */
export function createQueue(
  db: Drizzle,
  config: MysqlQueueConfig = {},
): Queue & {
  start(): Promise<void>;
  stop(): void;
  getMetrics(queueName: string): Promise<QueueMetrics>;
} {
  const {
    pollIntervalMs = 50,
    concurrency = 10,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    workerId = `worker_${monotonicFactory()()}`,
    idempotencyTtlMs = 5 * 60 * 1000,
    cleanupIntervalMs = 60 * 1000,
    httpTimeoutMs = 300_000,
    visibilityTimeoutMs = httpTimeoutMs + 60_000,
  } = config;

  let cleanupTimer: ReturnType<typeof setInterval> | null = null;

  const prefix = 'workflow_';
  const Queues = {
    workflow: `${prefix}flows`,
    step: `${prefix}steps`,
  } as const satisfies Record<QueueKind, string>;

  let running = false;

  const getDeploymentId: Queue['getDeploymentId'] = async () => 'mysql';

  const queue: Queue['queue'] = async (
    queueName: ValidQueueName,
    message: QueuePayload,
    opts?: QueueOptions,
  ) => {
    const { kind } = parseQueueName(queueName);
    const listKey = Queues[kind];

    const envelope: JobEnvelope = { queueName, message };

    return enqueueJob(db, listKey, envelope, {
      idempotencyKey: opts?.idempotencyKey,
      delaySeconds: opts?.delaySeconds,
      maxAttempts,
    });
  };

  const createQueueHandler: Queue['createQueueHandler'] = (queueNamePrefix, handler) => {
    return async (req) => {
      const reqQueueName = req.headers.get('x-vqs-queue-name') as ValidQueueName | null;
      const reqMessageId = req.headers.get('x-vqs-message-id') as MessageId | null;
      const attemptStr = req.headers.get('x-vqs-message-attempt');

      if (!reqQueueName || !reqMessageId || !attemptStr || !req.body) {
        return Response.json({ error: 'Missing required headers or body' }, { status: 400 });
      }
      if (!reqQueueName.startsWith(queueNamePrefix)) {
        return Response.json({ error: 'Unhandled queue' }, { status: 400 });
      }

      const attempt = Number.parseInt(attemptStr, 10);
      try {
        // Tagged-JSON transport: restores Uint8Array values that dispatch()
        // encoded, keeping binary payloads (e.g. runInput.input) intact.
        const body = decodeTaggedJson(await req.text());
        const result = await handler(body, {
          attempt,
          queueName: reqQueueName,
          messageId: reqMessageId,
        });
        if (result && typeof result.timeoutSeconds === 'number') {
          return Response.json({ timeoutSeconds: result.timeoutSeconds }, { status: 503 });
        }
        return Response.json({ ok: true });
      } catch (error) {
        return Response.json({ error: String(error) }, { status: 500 });
      }
    };
  };

  async function dispatch(
    envelope: JobEnvelope,
    messageId: string,
    attempt: number,
    pathname: 'flow' | 'step',
  ): Promise<Response> {
    const baseUrl = resolveBaseUrl(config);
    const url = createWorkflowUrl(baseUrl, { type: pathname });
    return fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-vqs-queue-name': envelope.queueName,
        'x-vqs-message-id': messageId,
        'x-vqs-message-attempt': String(attempt),
      },
      body: encodeTaggedJson(envelope.message),
      signal: AbortSignal.timeout(httpTimeoutMs),
    });
  }

  async function processJob(job: RawJobRow, listKey: string, kind: QueueKind): Promise<void> {
    const startTime = Date.now();
    try {
      const envelope = decode(job.payload) as JobEnvelope;
      const response = await dispatch(
        envelope,
        job.job_id,
        job.attempt ?? 1,
        QUEUE_PATHNAMES[kind],
      );

      if (response.ok) {
        // A stale settle is not counted: the live claim records its own outcome.
        await completeJob(db, job, () => metrics.recordProcessed(listKey, Date.now() - startTime));
        return;
      }

      const text = await response.text();

      if (response.status === 503) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = null;
        }
        if (
          parsed &&
          typeof parsed === 'object' &&
          typeof (parsed as { timeoutSeconds?: unknown }).timeoutSeconds === 'number'
        ) {
          const timeoutMs = (parsed as { timeoutSeconds: number }).timeoutSeconds * 1000;
          await rescheduleJob(db, job, timeoutMs);
          return;
        }
      }

      throw new Error(`HTTP ${response.status}: ${text}`);
    } catch (error) {
      // Same rule handleJobFailure applies, so a dead-letter is never counted as a retry.
      const isRetry = (job.attempt ?? 1) < (job.max_attempts ?? DEFAULT_MAX_ATTEMPTS);
      console.error(
        `[world-mysql processJob] Error processing job ${job.job_id} (attempt ${job.attempt}/${job.max_attempts}):`,
        error instanceof Error ? error.message : error,
      );
      if (await handleJobFailure(db, job, error)) {
        metrics.recordError(listKey, isRetry);
      }
    }
  }

  async function worker(kind: QueueKind, listKey: string, workerIdx: number) {
    const wId = `${workerId}_${kind}_${workerIdx}`;

    while (running) {
      try {
        const job = await fetchJob(db, listKey, wId);
        if (job) {
          await processJob(job, listKey, kind);
        } else {
          await delay(pollIntervalMs);
        }
      } catch (error) {
        console.error(`[world-mysql worker ${wId}] Error:`, error);
        await delay(1000);
      }
    }
  }

  function startWorkers() {
    const entries = Object.entries(Queues) as [QueueKind, string][];
    for (const [kind, listKey] of entries) {
      for (let i = 0; i < concurrency; i++) {
        worker(kind, listKey, i).catch((error) => {
          console.error(`[world-mysql] Worker for ${listKey} crashed:`, error);
        });
      }
    }
  }

  return {
    createQueueHandler,
    getDeploymentId,
    queue,
    async start() {
      // Without migration 0005 every claim fails and workers retry forever,
      // so refuse to start instead.
      try {
        await db.execute(sql`SELECT ${schema.jobs.claimToken} FROM ${schema.jobs} LIMIT 0`);
      } catch (error) {
        // drizzle wraps the mysql2 error, so read the errno off either level.
        if (
          isUnmigratedError(error) ||
          (error instanceof Error && isUnmigratedError(error.cause))
        ) {
          throw new Error(
            '[world-mysql] workflow_jobs is missing its claim_token column (or the table itself); run world-mysql-setup to apply migrations',
            { cause: error },
          );
        }
        throw error;
      }

      running = true;

      // Recover jobs orphaned by a previous crashed process before workers
      // start pulling new work.
      try {
        await reclaimStaleJobs(db, visibilityTimeoutMs);
      } catch (error) {
        debug('Error reclaiming stale jobs on start', { error });
      }

      startWorkers();

      cleanupTimer = setInterval(async () => {
        try {
          await cleanupExpiredIdempotencyKeys(db, idempotencyTtlMs);
        } catch (error) {
          debug('Error in idempotency cleanup', { error });
        }
        try {
          await reclaimStaleJobs(db, visibilityTimeoutMs);
        } catch (error) {
          debug('Error reclaiming stale jobs', { error });
        }
      }, cleanupIntervalMs);

      debug('Started queue workers and cleanup timer', {
        concurrency,
        pollIntervalMs,
        idempotencyTtlMs,
        cleanupIntervalMs,
        visibilityTimeoutMs,
      });
    },
    stop() {
      running = false;
      if (cleanupTimer) {
        clearInterval(cleanupTimer);
        cleanupTimer = null;
      }
      debug('Stopped queue workers and cleanup timer');
    },
    async getMetrics(queueName: string): Promise<QueueMetrics> {
      return metrics.getMetrics(db, queueName);
    },
  };
}

import { setTimeout as delay } from 'node:timers/promises';
import {
  MessageId,
  type Queue,
  type QueueOptions,
  type QueuePayload,
  type QueuePrefix,
  type ValidQueueName,
} from '@workflow/world';
import { decode, encode } from 'cbor-x';
import { eq, sql } from 'drizzle-orm';
import type { MySql2Database } from 'drizzle-orm/mysql2';
import { monotonicFactory } from 'ulid';
import { type QueueMetrics, metrics } from './metrics.js';
import * as schema from './schema.js';
import { debug } from './util.js';

type Drizzle = MySql2Database<typeof schema>;

const QUEUE_PATHNAMES = {
  __wkf_workflow_: 'flow',
  __wkf_step_: 'step',
} as const satisfies Record<QueuePrefix, string>;

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

/** Row shape returned by raw SQL SELECT on workflow_jobs (snake_case columns) */
interface RawJobRow {
  id: number;
  job_id: string;
  queue_name: string;
  payload: Buffer;
  status: string;
  attempt: number;
  max_attempts: number;
  created_at: Date;
  updated_at: Date;
  locked_at: Date | null;
  locked_by: string | null;
  error: string | null;
  scheduled_for: Date | null;
}

function resolveBaseUrl(config: MysqlQueueConfig): string {
  if (config.baseUrl) return config.baseUrl;
  if (process.env.WORKFLOW_BASE_URL) return process.env.WORKFLOW_BASE_URL;
  const port = process.env.PORT ?? '3000';
  return `http://localhost:${port}`;
}

async function cleanupExpiredIdempotencyKeys(db: Drizzle, ttlMs: number): Promise<number> {
  const cutoff = new Date(Date.now() - ttlMs);

  const result = await db.execute(sql`
    DELETE FROM \`workflow\`.\`workflow_job_idempotency\`
    WHERE \`created_at\` < ${cutoff}
  `);

  const affectedRows =
    (result as unknown as [{ affectedRows: number }, unknown])[0]?.affectedRows ?? 0;
  debug('Cleaned up expired idempotency keys', {
    affectedRows,
    cutoffDate: cutoff.toISOString(),
  });
  return affectedRows;
}

async function fetchJob(
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

    await tx.execute(sql`
      UPDATE \`workflow\`.\`workflow_jobs\`
      SET \`status\` = 'processing',
          \`locked_at\` = NOW(),
          \`locked_by\` = ${workerId},
          \`attempt\` = \`attempt\` + 1,
          \`updated_at\` = NOW()
      WHERE \`id\` = ${job.id}
    `);

    return {
      ...job,
      status: 'processing',
      locked_by: workerId,
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
        payload: Buffer.from(encode(envelope)),
        status: 'pending',
        maxAttempts: opts?.maxAttempts ?? 3,
        scheduledFor,
      });

      return { messageId };
    });
  } catch (error: unknown) {
    // Concurrent INSERTs racing on the same idempotency key — treat the
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

async function handleJobFailure(
  db: Drizzle,
  jobId: number,
  error: unknown,
  attempt: number,
  maxAttempts: number,
): Promise<void> {
  const errorMessage = error instanceof Error ? error.message : String(error);

  if (attempt >= maxAttempts) {
    await db
      .update(schema.jobs)
      .set({
        status: 'failed',
        error: errorMessage,
        lockedAt: null,
        lockedBy: null,
      })
      .where(eq(schema.jobs.id, jobId));
  } else {
    const backoffMs = Math.min(1000 * 2 ** (attempt - 1), 30000);
    const scheduledFor = new Date(Date.now() + backoffMs);

    await db
      .update(schema.jobs)
      .set({
        status: 'pending',
        error: errorMessage,
        lockedAt: null,
        lockedBy: null,
        scheduledFor,
      })
      .where(eq(schema.jobs.id, jobId));
  }
}

async function completeJob(db: Drizzle, jobId: number, idempotencyKey?: string): Promise<void> {
  await db.delete(schema.jobs).where(eq(schema.jobs.id, jobId));
  if (idempotencyKey) {
    await db
      .delete(schema.idempotency)
      .where(eq(schema.idempotency.idempotencyKey, idempotencyKey));
  }
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
    maxAttempts = 3,
    workerId = `worker_${monotonicFactory()()}`,
    idempotencyTtlMs = 5 * 60 * 1000,
    cleanupIntervalMs = 60 * 1000,
    httpTimeoutMs = 300_000,
  } = config;

  let cleanupTimer: ReturnType<typeof setInterval> | null = null;

  const prefix = 'workflow_';
  const Queues = {
    __wkf_workflow_: `${prefix}flows`,
    __wkf_step_: `${prefix}steps`,
  } as const satisfies Record<QueuePrefix, string>;

  let running = false;

  const getDeploymentId: Queue['getDeploymentId'] = async () => 'mysql';

  const queue: Queue['queue'] = async (
    queueName: ValidQueueName,
    message: QueuePayload,
    opts?: QueueOptions,
  ) => {
    const qPrefix = parseQueuePrefix(queueName);
    const listKey = Queues[qPrefix];

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
        const body = await req.json();
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
    pathname: string,
  ): Promise<Response> {
    const baseUrl = resolveBaseUrl(config);
    const url = `${baseUrl}/.well-known/workflow/v1/${pathname}`;
    return fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-vqs-queue-name': envelope.queueName,
        'x-vqs-message-id': messageId,
        'x-vqs-message-attempt': String(attempt),
      },
      body: JSON.stringify(envelope.message),
      signal: AbortSignal.timeout(httpTimeoutMs),
    });
  }

  async function processJob(
    job: RawJobRow,
    listKey: string,
    queuePrefix: QueuePrefix,
  ): Promise<void> {
    const startTime = Date.now();
    try {
      const envelope = decode(job.payload) as JobEnvelope;
      const response = await dispatch(
        envelope,
        job.job_id,
        job.attempt ?? 1,
        QUEUE_PATHNAMES[queuePrefix],
      );

      if (response.ok) {
        await completeJob(db, job.id, job.job_id);
        metrics.recordProcessed(listKey, Date.now() - startTime);
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
          // Re-schedule without consuming an attempt.
          await db
            .update(schema.jobs)
            .set({
              status: 'pending',
              lockedAt: null,
              lockedBy: null,
              scheduledFor: new Date(Date.now() + timeoutMs),
              attempt: Math.max(0, (job.attempt ?? 1) - 1),
            })
            .where(eq(schema.jobs.id, job.id));
          return;
        }
      }

      throw new Error(`HTTP ${response.status}: ${text}`);
    } catch (error) {
      const isRetry = (job.attempt ?? 1) < (job.max_attempts ?? maxAttempts);
      metrics.recordError(listKey, isRetry);
      console.error(
        `[world-mysql processJob] Error processing job ${job.job_id} (attempt ${job.attempt}/${job.max_attempts}):`,
        error instanceof Error ? error.message : error,
      );
      await handleJobFailure(db, job.id, error, job.attempt ?? 1, job.max_attempts ?? maxAttempts);
    }
  }

  async function worker(queuePrefix: QueuePrefix, listKey: string, workerIdx: number) {
    const wId = `${workerId}_${queuePrefix}_${workerIdx}`;

    while (running) {
      try {
        const job = await fetchJob(db, listKey, wId);
        if (job) {
          await processJob(job, listKey, queuePrefix);
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
    const entries = Object.entries(Queues) as [QueuePrefix, string][];
    for (const [queuePrefix, listKey] of entries) {
      for (let i = 0; i < concurrency; i++) {
        worker(queuePrefix, listKey, i).catch((error) => {
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
      running = true;
      startWorkers();

      cleanupTimer = setInterval(async () => {
        try {
          await cleanupExpiredIdempotencyKeys(db, idempotencyTtlMs);
        } catch (error) {
          debug('Error in idempotency cleanup', { error });
        }
      }, cleanupIntervalMs);

      debug('Started queue workers and cleanup timer', {
        concurrency,
        pollIntervalMs,
        idempotencyTtlMs,
        cleanupIntervalMs,
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

const parseQueuePrefix = (name: ValidQueueName): QueuePrefix => {
  const prefixes: QueuePrefix[] = ['__wkf_step_', '__wkf_workflow_'];
  for (const p of prefixes) {
    if (name.startsWith(p)) return p;
  }
  throw new Error(`Invalid queue name: ${name}`);
};

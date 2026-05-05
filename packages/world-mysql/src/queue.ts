import { setTimeout } from 'node:timers/promises';
import {
  MessageId,
  type Queue,
  type QueueOptions,
  type QueuePayload,
  QueuePayloadSchema,
  type QueuePrefix,
  type ValidQueueName,
} from '@workflow/world';
import { createLocalWorld } from '@workflow/world-local';
import { decode, encode } from 'cbor-x';
import { eq, sql } from 'drizzle-orm';
import type { MySql2Database } from 'drizzle-orm/mysql2';
import { monotonicFactory } from 'ulid';
import * as schema from './schema.js';

type Drizzle = MySql2Database<typeof schema>;

export interface MysqlQueueConfig {
  /** Poll interval in milliseconds (default: 100) */
  pollIntervalMs?: number;
  /** Number of concurrent workers per queue prefix (default: 10) */
  concurrency?: number;
  /** Maximum attempts before marking as failed (default: 3) */
  maxAttempts?: number;
  /** Worker ID for lock tracking */
  workerId?: string;
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

/**
 * Fetch the next available pending job using FOR UPDATE SKIP LOCKED.
 * This guarantees no two workers ever process the same job.
 */
async function fetchJob(
  db: Drizzle,
  queueName: string,
  workerId: string,
): Promise<RawJobRow | null> {
  return await db.transaction(async (tx) => {
    // Select the oldest pending job that is ready to execute
    const rawResult = await tx.execute(sql`
      SELECT * FROM \`workflow\`.\`workflow_jobs\`
      WHERE \`queue_name\` = ${queueName}
        AND \`status\` = 'pending'
        AND (\`scheduled_for\` IS NULL OR \`scheduled_for\` <= NOW())
      ORDER BY \`id\` ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    `);

    // drizzle execute with mysql2 returns [[rows], [fields]]
    const outerResult = rawResult as unknown as [RawJobRow[], unknown];
    const rows = outerResult[0];
    if (!rows || rows.length === 0) return null;
    const job = rows[0];
    if (!job || !job.id) return null;

    // Mark as processing
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

/**
 * Enqueue a job with idempotency support.
 * Uses a transaction to atomically check the idempotency table and insert the job.
 */
async function enqueueJob(
  db: Drizzle,
  queueName: string,
  message: QueuePayload,
  opts?: { idempotencyKey?: string; delaySeconds?: number; maxAttempts?: number },
): Promise<{ messageId: MessageId }> {
  const generateId = monotonicFactory();
  const messageId = MessageId.parse(`msg_${generateId()}`);
  const idempotencyKey = opts?.idempotencyKey ?? messageId;

  try {
    const result = await db.transaction(async (tx) => {
      // Check idempotency
      const [existing] = await tx
        .select()
        .from(schema.idempotency)
        .where(eq(schema.idempotency.idempotencyKey, idempotencyKey))
        .limit(1);

      if (existing) {
        return { messageId: MessageId.parse(existing.messageId) };
      }

      // Compute scheduled time if delay is specified
      const scheduledFor = opts?.delaySeconds
        ? new Date(Date.now() + opts.delaySeconds * 1000)
        : null;

      // Insert atomically
      await tx.insert(schema.idempotency).values({
        idempotencyKey,
        messageId,
        queueName,
      });

      await tx.insert(schema.jobs).values({
        jobId: messageId,
        queueName,
        payload: Buffer.from(encode(message)),
        status: 'pending',
        maxAttempts: opts?.maxAttempts ?? 3,
        scheduledFor,
      });

      return { messageId };
    });

    return result;
  } catch (error: unknown) {
    // Handle duplicate key error as an idempotency hit (race condition between
    // SELECT and INSERT in concurrent requests with the same idempotencyKey)
    // Check both error.code and error.cause.code (Drizzle wraps the MySQL error)
    const errorCode = (error as any)?.code || (error as any)?.cause?.code;

    if (errorCode === 'ER_DUP_ENTRY') {
      // Fetch the existing record to return its messageId
      const [existing] = await db
        .select()
        .from(schema.idempotency)
        .where(eq(schema.idempotency.idempotencyKey, idempotencyKey))
        .limit(1);

      if (existing) {
        return { messageId: MessageId.parse(existing.messageId) };
      }
      // If the record was already cleaned up, return current messageId
      return { messageId };
    }
    throw error;
  }
}

/**
 * Handle job failure with exponential backoff retry.
 * If max attempts reached, marks as permanently failed.
 */
async function handleJobFailure(
  db: Drizzle,
  jobId: number,
  error: unknown,
  attempt: number,
  maxAttempts: number,
): Promise<void> {
  const errorMessage = error instanceof Error ? error.message : String(error);

  if (attempt >= maxAttempts) {
    // Permanently failed
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
    // Exponential backoff: 1s, 2s, 4s, 8s...
    const backoffMs = Math.min(1000 * Math.pow(2, attempt - 1), 30000);
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

/**
 * Mark a job as successfully completed (delete it).
 */
async function completeJob(db: Drizzle, jobId: number, idempotencyKey?: string): Promise<void> {
  await db.delete(schema.jobs).where(eq(schema.jobs.id, jobId));
  // Clean up idempotency entry after successful processing
  if (idempotencyKey) {
    await db
      .delete(schema.idempotency)
      .where(eq(schema.idempotency.idempotencyKey, idempotencyKey));
  }
}

/**
 * Creates a pure MySQL queue implementation.
 * Uses FOR UPDATE SKIP LOCKED for concurrent, safe job processing.
 */
export function createQueue(
  db: Drizzle,
  config: MysqlQueueConfig = {},
): Queue & { start(): Promise<void>; stop(): void } {
  const {
    pollIntervalMs = 50,
    concurrency = 10,
    maxAttempts = 3,
    workerId = `worker_${monotonicFactory()()}`,
  } = config;

  const port = process.env.PORT ? Number(process.env.PORT) : undefined;
  const embeddedWorld = createLocalWorld({ dataDir: undefined, port });

  const prefix = 'workflow_';
  const Queues = {
    __wkf_workflow_: `${prefix}flows`,
    __wkf_step_: `${prefix}steps`,
  } as const satisfies Record<QueuePrefix, string>;

  let running = false;

  const createQueueHandler = embeddedWorld.createQueueHandler;

  const getDeploymentId: Queue['getDeploymentId'] = async () => {
    return 'mysql';
  };

  const queue: Queue['queue'] = async (
    queueName: ValidQueueName,
    message: QueuePayload,
    opts?: QueueOptions,
  ) => {
    const [qPrefix] = parseQueueName(queueName);
    const listKey = Queues[qPrefix];

    // Store the full original queue name in the payload envelope so workers can
    // reconstruct it when forwarding to the embedded world
    const envelope = { __queueName: queueName, __payload: message };

    const result = await enqueueJob(db, listKey, envelope as unknown as QueuePayload, {
      idempotencyKey: opts?.idempotencyKey,
      delaySeconds: opts?.delaySeconds,
      maxAttempts,
    });

    return result;
  };

  async function processJob(
    job: RawJobRow,
    _listKey: string,
    _queuePrefix: QueuePrefix,
  ): Promise<void> {
    try {
      // Decode CBOR payload - contains our envelope with original queue name
      const envelope = decode(job.payload) as {
        __queueName: ValidQueueName;
        __payload: unknown;
      };

      const queueName = envelope.__queueName;
      const message = QueuePayloadSchema.parse(envelope.__payload);

      // Forward to embedded world for processing with the original queue name
      await embeddedWorld.queue(queueName, message, {
        idempotencyKey: job.job_id,
      });

      // Success - remove the job
      await completeJob(db, job.id, job.job_id);
    } catch (error) {
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
          // No jobs available, wait before polling again
          await setTimeout(pollIntervalMs);
        }
      } catch (error) {
        // Connection error or similar - back off
        console.error(`[world-mysql worker ${wId}] Error:`, error);
        await setTimeout(1000);
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
    },
    stop() {
      running = false;
    },
  };
}

const parseQueueName = (name: ValidQueueName): [QueuePrefix, string] => {
  const prefixes: QueuePrefix[] = ['__wkf_step_', '__wkf_workflow_'];
  for (const p of prefixes) {
    if (name.startsWith(p)) {
      return [p, name.slice(p.length)];
    }
  }
  throw new Error(`Invalid queue name: ${name}`);
};

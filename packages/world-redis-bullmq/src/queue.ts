import {
  MessageId,
  type Queue as QueueInterface,
  type QueuePayload,
  type QueuePrefix,
  type ValidQueueName,
} from '@workflow/world';
import { type Job, Queue, Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import { monotonicFactory } from 'ulid';
import type { RedisWorldConfig } from './config.js';
import { debug } from './util.js';

/**
 * Queue statistics from BullMQ, useful for monitoring and observability.
 */
export interface QueueStats {
  /** Jobs waiting to be processed */
  waiting: number;
  /** Jobs currently being processed */
  active: number;
  /** Successfully completed jobs (still retained) */
  completed: number;
  /** Failed jobs (still retained) */
  failed: number;
  /** Jobs scheduled for future execution */
  delayed: number;
}

const QUEUE_PATHNAMES = {
  __wkf_workflow_: 'flow',
  __wkf_step_: 'step',
} as const satisfies Record<QueuePrefix, string>;

interface QueueJobData {
  /** The actual workflow/step queue name, including the suffix (e.g. `__wkf_workflow_wrun_…`) */
  queueName: ValidQueueName;
  /** The opaque message payload — forwarded as the fetch body */
  message: QueuePayload;
}

/**
 * Build the HTTP callback URL the BullMQ worker will POST to. The user must
 * mount `world.createQueueHandler(...)` at `/.well-known/workflow/v1/flow` and
 * `/.well-known/workflow/v1/step` (the Workflow DevKit convention).
 */
function resolveBaseUrl(config: RedisWorldConfig): string {
  if (config.baseUrl) return config.baseUrl;
  if (process.env.WORKFLOW_BASE_URL) return process.env.WORKFLOW_BASE_URL;
  const port = process.env.PORT ?? '3000';
  return `http://localhost:${port}`;
}

/**
 * BullMQ-backed Queue. Job dispatch happens via HTTP fetch to the user's
 * server — this package does not embed a workflow runtime.
 */
export function createQueue(
  redis: Redis,
  config: RedisWorldConfig,
): QueueInterface & { start(): Promise<void>; getQueueStats(): Promise<QueueStats> } {
  const generateMessageId = monotonicFactory();

  const prefix = config.jobPrefix || 'workflow_';
  const Queues = {
    __wkf_workflow_: `${prefix}flows`,
    __wkf_step_: `${prefix}steps`,
  } as const satisfies Record<QueuePrefix, string>;

  const maxAttempts = config.maxAttempts ?? 5;
  const backoffType = config.backoffType ?? 'exponential';
  const backoffDelayMs = config.backoffDelayMs ?? 1000;
  const httpTimeoutMs = config.httpTimeoutMs ?? 300_000;
  const stalledInterval = config.stalledInterval ?? 30_000;
  const maxStalledCount = config.maxStalledCount ?? 1;
  const idempotencyTtlMs = config.idempotencyTtlMs ?? 60_000;

  // BullMQ requires maxRetriesPerRequest: null on the connection.
  const connectionOptions = {
    host: redis.options.host,
    port: redis.options.port,
    password: redis.options.password,
    db: redis.options.db,
    maxRetriesPerRequest: null as null,
  };

  const bullQueues = new Map<QueuePrefix, Queue<QueueJobData>>();
  const workers = new Map<QueuePrefix, Worker<QueueJobData>>();

  for (const [queuePrefix, jobName] of Object.entries(Queues) as [QueuePrefix, string][]) {
    bullQueues.set(
      queuePrefix,
      new Queue<QueueJobData>(jobName, { connection: connectionOptions }),
    );
  }

  const queue: QueueInterface['queue'] = async (queueName, message, opts) => {
    const queuePrefix = parseQueuePrefix(queueName);
    const bullQueue = bullQueues.get(queuePrefix);
    if (!bullQueue) throw new Error(`No BullMQ queue registered for prefix ${queuePrefix}`);

    const messageId = MessageId.parse(`msg_${generateMessageId()}`);
    const delayMs = opts?.delaySeconds ? Math.max(0, opts.delaySeconds * 1000) : undefined;

    try {
      await bullQueue.add(
        queueName,
        { queueName, message },
        {
          jobId: messageId,
          delay: delayMs,
          attempts: maxAttempts,
          backoff: { type: backoffType, delay: backoffDelayMs },
          // BullMQ native deduplication with TTL — re-submitting within the
          // window returns the original job id without enqueuing again.
          ...(opts?.idempotencyKey && {
            deduplication: { id: opts.idempotencyKey, ttl: idempotencyTtlMs },
          }),
          removeOnComplete: { age: 86_400, count: 1000 },
          removeOnFail: { age: 7 * 86_400 },
        },
      );
    } catch (err) {
      // BullMQ throws on dedup hits — that's fine, return the messageId anyway.
      debug('queue add returned:', err);
    }

    return { messageId };
  };

  function createProcessor(queuePrefix: QueuePrefix) {
    const pathname = QUEUE_PATHNAMES[queuePrefix];
    return async (job: Job<QueueJobData>) => {
      const baseUrl = resolveBaseUrl(config);
      const url = `${baseUrl}/.well-known/workflow/v1/${pathname}`;
      const messageId = job.id ?? `msg_${generateMessageId()}`;

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-vqs-queue-name': job.data.queueName,
          'x-vqs-message-id': messageId,
          'x-vqs-message-attempt': String(job.attemptsMade + 1),
        },
        body: JSON.stringify(job.data.message),
        signal: AbortSignal.timeout(httpTimeoutMs),
      });

      if (response.ok) return;

      const text = await response.text();

      // 503 with { timeoutSeconds } means "retry later without consuming an
      // attempt" — defer the job via BullMQ's delayed queue.
      if (response.status === 503) {
        try {
          const parsed = JSON.parse(text);
          if (typeof parsed?.timeoutSeconds === 'number') {
            const delayMs = parsed.timeoutSeconds * 1000;
            // moveToDelayed is the documented BullMQ recipe for "soft retry".
            await job.moveToDelayed(Date.now() + delayMs, job.token);
            return;
          }
        } catch {
          // fall through to generic failure
        }
      }

      throw new Error(`HTTP ${response.status}: ${text}`);
    };
  }

  const createQueueHandler: QueueInterface['createQueueHandler'] = (queueNamePrefix, handler) => {
    return async (req) => {
      const queueName = req.headers.get('x-vqs-queue-name') as ValidQueueName | null;
      const messageId = req.headers.get('x-vqs-message-id') as MessageId | null;
      const attemptStr = req.headers.get('x-vqs-message-attempt');

      if (!queueName || !messageId || !attemptStr || !req.body) {
        return Response.json({ error: 'Missing required headers or body' }, { status: 400 });
      }
      if (!queueName.startsWith(queueNamePrefix)) {
        return Response.json({ error: 'Unhandled queue' }, { status: 400 });
      }

      const attempt = Number.parseInt(attemptStr, 10);

      try {
        const body = await req.json();
        const result = await handler(body, { attempt, queueName, messageId });

        if (result && typeof result.timeoutSeconds === 'number') {
          return Response.json({ timeoutSeconds: result.timeoutSeconds }, { status: 503 });
        }
        return Response.json({ ok: true });
      } catch (error) {
        debug('queue handler error:', error);
        return Response.json({ error: String(error) }, { status: 500 });
      }
    };
  };

  const getDeploymentId: QueueInterface['getDeploymentId'] = async () => 'redis';

  async function startWorkers() {
    const concurrency = config.queueConcurrency || 10;

    for (const [queuePrefix] of Object.entries(Queues) as [QueuePrefix, string][]) {
      const jobName = Queues[queuePrefix];
      const worker = new Worker<QueueJobData>(jobName, createProcessor(queuePrefix), {
        connection: connectionOptions,
        concurrency,
        stalledInterval,
        maxStalledCount,
        // Low drainDelay reduces idle pickup latency.
        drainDelay: 300,
      });

      worker.on('failed', (job, err) => {
        console.error(`Job ${job?.id} failed:`, err);
      });
      worker.on('error', (err) => {
        console.error('Worker error:', err);
      });

      workers.set(queuePrefix, worker);
    }

    await Promise.all(Array.from(workers.values()).map((worker) => worker.waitUntilReady()));
  }

  async function getQueueStats(): Promise<QueueStats> {
    const totals: QueueStats = {
      waiting: 0,
      active: 0,
      completed: 0,
      failed: 0,
      delayed: 0,
    };

    for (const bullQueue of bullQueues.values()) {
      const counts = await bullQueue.getJobCounts(
        'waiting',
        'active',
        'completed',
        'failed',
        'delayed',
      );
      totals.waiting += counts.waiting;
      totals.active += counts.active;
      totals.completed += counts.completed;
      totals.failed += counts.failed;
      totals.delayed += counts.delayed;
    }

    return totals;
  }

  return {
    createQueueHandler,
    getDeploymentId,
    queue,
    getQueueStats,
    async start() {
      await startWorkers();
    },
  };
}

const parseQueuePrefix = (name: ValidQueueName): QueuePrefix => {
  const prefixes: QueuePrefix[] = ['__wkf_step_', '__wkf_workflow_'];
  for (const prefix of prefixes) {
    if (name.startsWith(prefix)) return prefix;
  }
  throw new Error(`Invalid queue name: ${name}`);
};

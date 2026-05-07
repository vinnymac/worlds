import * as Stream from 'node:stream';
import { JsonTransport } from '@vercel/queue';
import {
  MessageId,
  type Queue as QueueInterface,
  type QueueOptions,
  QueuePayloadSchema,
  type QueuePrefix,
  type ValidQueueName,
} from '@workflow/world';
import { createLocalWorld } from '@workflow/world-local';
import { Queue, Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import { monotonicFactory } from 'ulid';
import type { RedisWorldConfig } from './config.js';

interface MessageData {
  attempt: number;
  messageId: string;
  idempotencyKey?: string;
  id: string;
  data: Buffer;
}

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

/**
 * The Redis queue works by creating two BullMQ queues:
 * - `{prefix}flows` for workflow jobs
 * - `{prefix}steps` for step jobs
 *
 * When a message is queued, it is sent to BullMQ with the appropriate queue name.
 * When a job is processed, it is deserialized and then re-queued into the _embedded world_,
 * showing that we can reuse the embedded world, mix and match worlds to build
 * hybrid architectures, and even migrate between worlds.
 */
export function createQueue(
  redis: Redis,
  config: RedisWorldConfig,
): QueueInterface & { start(): Promise<void>; getQueueStats(): Promise<QueueStats> } {
  const port = process.env.PORT ? Number(process.env.PORT) : undefined;
  const embeddedWorld = createLocalWorld({ dataDir: undefined, port });

  const transport = new JsonTransport();
  const generateMessageId = monotonicFactory();

  const prefix = config.jobPrefix || 'workflow_';
  const Queues = {
    __wkf_workflow_: `${prefix}flows`,
    __wkf_step_: `${prefix}steps`,
  } as const satisfies Record<QueuePrefix, string>;

  // Retry / backoff defaults
  const maxAttempts = config.maxAttempts ?? 5;
  const backoffType = config.backoffType ?? 'exponential';
  const backoffDelayMs = config.backoffDelayMs ?? 1000;

  // Stalled-job recovery defaults (BullMQ v5 handles this internally)
  const stalledInterval = config.stalledInterval ?? 30_000;
  const maxStalledCount = config.maxStalledCount ?? 1;

  // Create BullMQ connection options from Redis instance
  const connectionOptions = {
    host: redis.options.host,
    port: redis.options.port,
    password: redis.options.password,
    db: redis.options.db,
  };

  // Create BullMQ queues eagerly to avoid cold-start delays on first job add
  const bullQueues = new Map<string, Queue>();
  const workers = new Map<string, Worker>();

  for (const queueName of Object.values(Queues)) {
    bullQueues.set(queueName, new Queue(queueName, { connection: connectionOptions }));
  }

  function getQueue(name: string): Queue {
    let queue = bullQueues.get(name);
    if (!queue) {
      queue = new Queue(name, {
        connection: connectionOptions,
      });
      bullQueues.set(name, queue);
    }
    return queue;
  }

  const createQueueHandler = embeddedWorld.createQueueHandler;

  const getDeploymentId: QueueInterface['getDeploymentId'] = async () => {
    return 'redis';
  };

  const queue: QueueInterface['queue'] = async (
    queueName: ValidQueueName,
    message: unknown,
    opts?: QueueOptions,
  ) => {
    const [queuePrefix, queueId] = parseQueueName(queueName);
    const jobName = Queues[queuePrefix] as string;
    const bullQueue = getQueue(jobName);

    const body = transport.serialize(message);
    const messageId = MessageId.parse(`msg_${generateMessageId()}`);

    const messageData: MessageData = {
      id: queueId,
      data: body,
      attempt: 1,
      messageId,
      idempotencyKey: opts?.idempotencyKey,
    };

    // Compute delay from delaySeconds (BullMQ expects milliseconds)
    const delayMs = opts?.delaySeconds ? Math.max(0, opts.delaySeconds * 1000) : undefined;

    // BullMQ uses jobId for deduplication — passing the messageId as the
    // jobId means re-submitting the same message is a no-op while the job
    // is still in the queue, giving us free idempotency.
    await bullQueue.add(
      jobName,
      {
        ...messageData,
        data: messageData.data.toString('base64'),
      },
      {
        jobId: opts?.idempotencyKey ?? messageId,
        delay: delayMs,
        attempts: maxAttempts,
        backoff: {
          type: backoffType,
          delay: backoffDelayMs,
        },
        removeOnComplete: { age: 86_400, count: 1000 },
        removeOnFail: { age: 7 * 86_400 },
      },
    );

    return { messageId };
  };

  async function setupListener(queuePrefix: QueuePrefix, jobName: string) {
    const concurrency = config.queueConcurrency || 10;

    const worker = new Worker(
      jobName,
      async (job) => {
        const messageData = {
          ...job.data,
          data: Buffer.from(job.data.data as string, 'base64'),
        } as MessageData;

        const bodyStream = Stream.Readable.toWeb(Stream.Readable.from([messageData.data]));
        const body = await transport.deserialize(bodyStream as ReadableStream<Uint8Array>);
        const message = QueuePayloadSchema.parse(body);
        const queueName = `${queuePrefix}${messageData.id}` as const;
        await embeddedWorld.queue(queueName, message, {
          idempotencyKey: messageData.idempotencyKey,
        });
      },
      {
        connection: connectionOptions,
        concurrency,
        stalledInterval,
        maxStalledCount,
        // Use a low drainDelay to ensure fast job pickup when the queue is idle.
        // The default of 5000ms causes unnecessary latency for health checks and
        // other time-sensitive operations.
        drainDelay: 300,
      },
    );

    workers.set(jobName, worker);

    // Set up error handlers
    worker.on('failed', (job, err) => {
      console.error(`Job ${job?.id} failed:`, err);
    });

    worker.on('error', (err) => {
      console.error('Worker error:', err);
    });
  }

  async function setupListeners() {
    for (const [queuePrefix, jobName] of Object.entries(Queues) as [QueuePrefix, string][]) {
      await setupListener(queuePrefix, jobName);
    }
  }

  /**
   * Returns aggregate job counts across all BullMQ queues.
   * Useful for monitoring dashboards and health checks.
   */
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
      await setupListeners();
    },
  };
}

const parseQueueName = (name: ValidQueueName): [QueuePrefix, string] => {
  const prefixes: QueuePrefix[] = ['__wkf_step_', '__wkf_workflow_'];
  for (const prefix of prefixes) {
    if (name.startsWith(prefix)) {
      return [prefix, name.slice(prefix.length)];
    }
  }
  throw new Error(`Invalid queue name: ${name}`);
};

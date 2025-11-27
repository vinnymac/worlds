import * as Stream from 'node:stream';
import { JsonTransport } from '@vercel/queue';
import {
  MessageId,
  type Queue as QueueInterface,
  QueuePayloadSchema,
  type QueuePrefix,
  type ValidQueueName,
} from '@workflow/world';
import { createEmbeddedWorld } from '@workflow/world-local';
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
  config: RedisWorldConfig
): QueueInterface & { start(): Promise<void> } {
  const port = process.env.PORT ? Number(process.env.PORT) : undefined;
  const embeddedWorld = createEmbeddedWorld({ dataDir: undefined, port });

  const transport = new JsonTransport();
  const generateMessageId = monotonicFactory();

  const prefix = config.jobPrefix || 'workflow_';
  const Queues = {
    __wkf_workflow_: `${prefix}flows`,
    __wkf_step_: `${prefix}steps`,
  } as const satisfies Record<QueuePrefix, string>;

  // Create BullMQ connection options from Redis instance
  const connectionOptions = {
    host: redis.options.host,
    port: redis.options.port,
    password: redis.options.password,
    db: redis.options.db,
  };

  // Create BullMQ queues
  const bullQueues = new Map<string, Queue>();
  const workers = new Map<string, Worker>();

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
    opts?: { idempotencyKey?: string }
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

    // BullMQ uses jobId for deduplication
    await bullQueue.add(
      jobName,
      {
        ...messageData,
        data: messageData.data.toString('base64'),
      },
      {
        jobId: opts?.idempotencyKey ?? messageId,
        attempts: 3,
        removeOnComplete: 100, // Keep last 100 completed jobs
        removeOnFail: 1000, // Keep last 1000 failed jobs
      }
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

        const bodyStream = Stream.Readable.toWeb(
          Stream.Readable.from([messageData.data])
        );
        const body = await transport.deserialize(
          bodyStream as ReadableStream<Uint8Array>
        );
        const message = QueuePayloadSchema.parse(body);
        const queueName = `${queuePrefix}${messageData.id}` as const;
        await embeddedWorld.queue(queueName, message, {
          idempotencyKey: messageData.idempotencyKey,
        });
      },
      {
        connection: connectionOptions,
        concurrency,
      }
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
    for (const [queuePrefix, jobName] of Object.entries(Queues) as [
      QueuePrefix,
      string,
    ][]) {
      await setupListener(queuePrefix, jobName);
    }
  }

  return {
    createQueueHandler,
    getDeploymentId,
    queue,
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

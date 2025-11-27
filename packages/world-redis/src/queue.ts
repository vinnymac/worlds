import { setTimeout } from 'node:timers/promises';
import { JsonTransport } from '@vercel/queue';
import {
  MessageId,
  type Queue,
  QueuePayloadSchema,
  type QueuePrefix,
  type ValidQueueName,
} from '@workflow/world';
import { createEmbeddedWorld } from '@workflow/world-local';
import type { Redis } from 'ioredis';
import { monotonicFactory } from 'ulid';
import type { RedisWorldConfig } from './config.js';

interface MessageData {
  id: string;
  data: string; // base64-encoded
  idempotencyKey?: string;
  messageId: string;
  attempt: number;
}

/**
 * The Redis queue works by creating two Redis lists (one for workflows, one for steps):
 * - `${prefix}flows` for workflow jobs
 * - `${prefix}steps` for step jobs
 *
 * When a message is queued, it is LPUSHed to the appropriate Redis list with idempotency tracking.
 * Workers use BRPOP to retrieve messages from lists and forward them to the _embedded world_.
 */
export function createQueue(
  redis: Redis,
  config: RedisWorldConfig
): Queue & { start(): Promise<void> } {
  const port = process.env.PORT ? Number(process.env.PORT) : undefined;
  const embeddedWorld = createEmbeddedWorld({ dataDir: undefined, port });

  const transport = new JsonTransport();
  const generateMessageId = monotonicFactory();

  const prefix = config.jobPrefix || 'workflow_';
  const Queues = {
    __wkf_workflow_: `${prefix}flows`,
    __wkf_step_: `${prefix}steps`,
  } as const satisfies Record<QueuePrefix, string>;

  const createQueueHandler = embeddedWorld.createQueueHandler;

  const getDeploymentId: Queue['getDeploymentId'] = async () => {
    return 'redis';
  };

  const queue: Queue['queue'] = async (queueName, message, opts) => {
    const [qPrefix, id] = parseQueueName(queueName);
    const listKey = Queues[qPrefix];
    const body = transport.serialize(message);
    const messageId = MessageId.parse(`msg_${generateMessageId()}`);

    // Use idempotency key to prevent duplicate processing
    const idempotencyKey = opts?.idempotencyKey ?? messageId;
    const idempotencySetKey = `${listKey}:idempotent`;

    // Atomically check and add - SADD returns number of elements added (0 if already exists)
    const added = await redis.sadd(idempotencySetKey, idempotencyKey);
    if (added === 0) {
      // Already queued with this idempotency key, return early
      return { messageId };
    }

    // Set TTL on the Set (24 hours)
    await redis.expire(idempotencySetKey, 86400);

    const messageData: MessageData = {
      id,
      data: Buffer.from(body).toString('base64'),
      idempotencyKey: opts?.idempotencyKey,
      messageId,
      attempt: 1,
    };

    const payload = JSON.stringify(messageData);

    // Use pipeline for better performance
    await redis
      .multi()
      .lpush(listKey, payload)
      .publish(`chan:${listKey}`, 'new')
      .exec();

    return { messageId };
  };

  async function worker(queuePrefix: QueuePrefix, listKey: string) {
    // Each worker uses its own Redis client because BRPOP blocks the connection
    const workerRedis = redis.duplicate();
    // Note: duplicate() creates a new client that auto-connects on first command

    try {
      while (true) {
        let result: [string, string] | null;

        try {
          // Use BRPOP to wait for items; blocks indefinitely with timeout=0
          result = await workerRedis.brpop(listKey, 0);
        } catch (error) {
          // Handle brpop errors gracefully
          console.error(
            `[world-redis worker] Error calling brpop on ${listKey}:`,
            error
          );

          // Wait 1 second before retrying
          await setTimeout(1000);
          continue;
        }

        if (!result) {
          // Should not happen with timeout=0, but handle gracefully
          continue;
        }

        const item = result[1]; // brpop returns [key, value]

        try {
          const parsed: MessageData = JSON.parse(item);
          const body = Buffer.from(parsed.data, 'base64');
          const decoded = await transport.deserialize(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(body);
                controller.close();
              },
            })
          );
          const message = QueuePayloadSchema.parse(decoded);
          const queueName = `${queuePrefix}${parsed.id}` as const;

          // embeddedWorld.queue() is fire-and-forget internally, but we await it
          await embeddedWorld.queue(queueName, message, {
            idempotencyKey: parsed.idempotencyKey,
          });

          // After successful processing, remove the idempotency key
          if (parsed.idempotencyKey) {
            await workerRedis.srem(
              `${listKey}:idempotent`,
              parsed.idempotencyKey
            );
          }
        } catch (error) {
          // Log parsing/deserialization errors but continue processing
          console.error(
            `[world-redis worker] Error processing message from ${listKey}:`,
            error
          );
        }
      }
    } finally {
      await workerRedis.quit();
    }
  }

  async function startWorkers() {
    const concurrency = config.queueConcurrency || 10;
    const entries = Object.entries(Queues) as [QueuePrefix, string][];

    // Start all workers without awaiting (they run forever)
    await Promise.all(
      entries.flatMap(([queuePrefix, listKey]) =>
        Array.from({ length: concurrency }, () => worker(queuePrefix, listKey))
      )
    );
  }

  return {
    createQueueHandler,
    getDeploymentId,
    queue,
    async start() {
      // workers run in background
      void startWorkers();
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

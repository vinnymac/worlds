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

interface MessageData {
  id: string;
  data: string; // base64-encoded
  idempotencyKey?: string;
  messageId: string;
  attempt: number;
}

/**
 * The Postgres-Redis queue works by creating two Redis lists:
 * - `${prefix}flows` for workflow jobs
 * - `${prefix}steps` for step jobs
 *
 * When a message is queued, it is LPUSHed to the appropriate Redis list with idempotency tracking.
 * Workers use BRPOPLPUSH to atomically move messages to a processing list, then forward them to the _embedded world_.
 */
export function createQueue(
  redis: Redis,
  config: { jobPrefix?: string; queueConcurrency?: number }
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
    return 'postgres-redis';
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

  // Helper: Fetch message from queue with error handling
  async function fetchMessage(
    workerRedis: Redis,
    listKey: string,
    processingListKey: string
  ): Promise<string | null> {
    try {
      return await workerRedis.brpoplpush(listKey, processingListKey, 0);
    } catch (error) {
      console.error(
        `[world-postgres-redis worker] Error calling brpoplpush on ${listKey}:`,
        error
      );
      await setTimeout(1000);
      return null;
    }
  }

  // Helper: Parse and decode message
  async function parseMessage(
    item: string,
    queuePrefix: QueuePrefix
  ): Promise<{
    parsed: MessageData;
    message: ReturnType<typeof QueuePayloadSchema.parse>;
    queueName: ValidQueueName;
  }> {
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
    const queueName = `${queuePrefix}${parsed.id}` as ValidQueueName;
    return { parsed, message, queueName };
  }

  // Helper: Clean up successful message
  async function processMessageSuccess(
    workerRedis: Redis,
    listKey: string,
    processingListKey: string,
    item: string,
    idempotencyKey?: string
  ) {
    await workerRedis.lrem(processingListKey, 1, item);
    if (idempotencyKey) {
      await workerRedis.srem(`${listKey}:idempotent`, idempotencyKey);
    }
  }

  // Helper: Requeue message after error
  async function requeueMessage(
    workerRedis: Redis,
    listKey: string,
    processingListKey: string,
    item: string,
    errorType: string,
    error: any
  ) {
    console.error(
      `[world-postgres-redis worker] ${errorType} error on ${listKey}:`,
      error
    );
    await workerRedis.lrem(processingListKey, 1, item);
    await workerRedis.rpush(listKey, item);
    await setTimeout(1000);
  }

  // Helper: Process single message with error handling
  async function processSingleMessage(
    workerRedis: Redis,
    listKey: string,
    processingListKey: string,
    item: string,
    queuePrefix: QueuePrefix
  ): Promise<void> {
    try {
      const { parsed, message, queueName } = await parseMessage(
        item,
        queuePrefix
      );

      try {
        await embeddedWorld.queue(queueName, message, {
          idempotencyKey: parsed.idempotencyKey,
        });
        await processMessageSuccess(
          workerRedis,
          listKey,
          processingListKey,
          item,
          parsed.idempotencyKey
        );
      } catch (httpError) {
        await requeueMessage(
          workerRedis,
          listKey,
          processingListKey,
          item,
          'HTTP request failed',
          httpError
        );
      }
    } catch (parseError) {
      await requeueMessage(
        workerRedis,
        listKey,
        processingListKey,
        item,
        'Error processing message',
        parseError
      );
    }
  }

  async function worker(queuePrefix: QueuePrefix, listKey: string) {
    const workerRedis = redis.duplicate();
    const processingListKey = `${listKey}:processing`;

    try {
      while (true) {
        const item = await fetchMessage(
          workerRedis,
          listKey,
          processingListKey
        );

        if (item) {
          await processSingleMessage(
            workerRedis,
            listKey,
            processingListKey,
            item,
            queuePrefix
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

    // Start all workers (they run forever in background)
    entries.forEach(([queuePrefix, listKey]) => {
      for (let i = 0; i < concurrency; i++) {
        // Start worker in background (don't await)
        worker(queuePrefix, listKey).catch((error) => {
          console.error(
            `[world-postgres-redis] Worker for ${listKey} crashed:`,
            error
          );
        });
      }
    });
  }

  return {
    createQueueHandler,
    getDeploymentId,
    queue,
    async start() {
      // Start workers (runs in background)
      startWorkers();
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

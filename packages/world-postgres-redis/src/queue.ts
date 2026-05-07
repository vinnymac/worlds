import { setTimeout } from 'node:timers/promises';
import { JsonTransport } from '@vercel/queue';
import {
  MessageId,
  type Queue,
  QueuePayloadSchema,
  type QueuePrefix,
  type ValidQueueName,
} from '@workflow/world';
import { createLocalWorld } from '@workflow/world-local';
import { eq } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { monotonicFactory } from 'ulid';
import type { Drizzle } from './drizzle/index.js';
import { Schema } from './drizzle/index.js';
import { createOutboxRelay, type OutboxRelay } from './outbox.js';
import { debug } from './util.js';

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
 * When a message is queued, it is written to a Postgres outbox table first
 * for atomicity. An outbox relay worker polls the outbox and pushes to Redis,
 * deleting outbox rows once Redis confirms receipt. This ensures no messages
 * are lost if Redis is temporarily unavailable.
 *
 * Workers use BRPOPLPUSH to atomically move messages to a processing list,
 * then forward them to the _embedded world_.
 */
export function createQueue(
  redis: Redis,
  drizzle: Drizzle,
  config: { jobPrefix?: string; queueConcurrency?: number },
): Queue & { start(): Promise<void>; outboxRelay: OutboxRelay } {
  const port = process.env.PORT ? Number(process.env.PORT) : undefined;
  const embeddedWorld = createLocalWorld({ dataDir: undefined, port });

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

  /**
   * Push a message payload directly to Redis (used by the outbox relay).
   * Idempotency is handled by the outbox's UNIQUE(message_id) constraint,
   * so we skip Redis-side idempotency tracking entirely (Enhancement 6).
   */
  async function pushToRedis(listKey: string, payload: string): Promise<void> {
    await redis.multi().lpush(listKey, payload).publish(`chan:${listKey}`, 'new').exec();
  }

  // Create the outbox relay that drains Postgres outbox -> Redis
  const outboxRelay = createOutboxRelay(drizzle, async (entry) => {
    const outboxPayload = entry.payload as { listKey: string; messageData: string };
    await pushToRedis(outboxPayload.listKey, outboxPayload.messageData);
  });

  const queue: Queue['queue'] = async (queueName, message, opts) => {
    const [qPrefix, id] = parseQueueName(queueName);
    const listKey = Queues[qPrefix];
    const body = transport.serialize(message);
    const messageId = MessageId.parse(`msg_${generateMessageId()}`);

    // Use idempotency key to prevent duplicate processing
    const idempotencyKey = opts?.idempotencyKey ?? messageId;

    const messageData: MessageData = {
      id,
      data: Buffer.from(body).toString('base64'),
      idempotencyKey: opts?.idempotencyKey,
      messageId,
      attempt: 1,
    };

    const serializedMessage = JSON.stringify(messageData);

    // Write to Postgres outbox for guaranteed delivery.
    // The UNIQUE(message_id) constraint handles idempotency -- if this
    // idempotency key was already written, onConflictDoNothing ensures
    // we don't duplicate and we return early.
    const [inserted] = await drizzle
      .insert(Schema.outbox)
      .values({
        id: messageId,
        messageId: idempotencyKey,
        payload: { listKey, messageData: serializedMessage },
      })
      .onConflictDoNothing()
      .returning({ id: Schema.outbox.id });

    if (!inserted) {
      // Idempotency: this message was already queued
      debug(`Queue: idempotent skip for ${idempotencyKey}`);
      return { messageId };
    }

    // Optimistic fast path: try to push to Redis immediately.
    // If this fails, the outbox relay will pick it up.
    try {
      await pushToRedis(listKey, serializedMessage);
      // Success: remove from outbox immediately
      await drizzle.delete(Schema.outbox).where(eq(Schema.outbox.id, messageId));
    } catch (err) {
      debug(`Queue: Redis push failed for ${messageId}, outbox relay will retry:`, err);
      // Leave in outbox for relay to handle
    }

    return { messageId };
  };

  // Helper: Fetch message from queue with error handling
  async function fetchMessage(
    workerRedis: Redis,
    listKey: string,
    processingListKey: string,
  ): Promise<string | null> {
    try {
      return await workerRedis.brpoplpush(listKey, processingListKey, 0);
    } catch (error) {
      console.error(`[world-postgres-redis worker] Error calling brpoplpush on ${listKey}:`, error);
      await setTimeout(1000);
      return null;
    }
  }

  // Helper: Parse and decode message
  async function parseMessage(
    item: string,
    queuePrefix: QueuePrefix,
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
      }),
    );
    const message = QueuePayloadSchema.parse(decoded);
    const queueName = `${queuePrefix}${parsed.id}` as ValidQueueName;
    return { parsed, message, queueName };
  }

  // Helper: Clean up successful message
  async function processMessageSuccess(
    workerRedis: Redis,
    _listKey: string,
    processingListKey: string,
    item: string,
    _idempotencyKey?: string,
  ) {
    await workerRedis.lrem(processingListKey, 1, item);
    // Idempotency is now handled by the Postgres outbox UNIQUE(message_id)
    // constraint (Enhancement 6), so no Redis-side dedup set to clean up.
  }

  // Helper: Requeue message after error
  async function requeueMessage(
    workerRedis: Redis,
    listKey: string,
    processingListKey: string,
    item: string,
    errorType: string,
    error: any,
  ) {
    console.error(`[world-postgres-redis worker] ${errorType} error on ${listKey}:`, error);
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
    queuePrefix: QueuePrefix,
  ): Promise<void> {
    try {
      const { parsed, message, queueName } = await parseMessage(item, queuePrefix);

      try {
        await embeddedWorld.queue(queueName, message, {
          idempotencyKey: parsed.idempotencyKey,
        });
        await processMessageSuccess(
          workerRedis,
          listKey,
          processingListKey,
          item,
          parsed.idempotencyKey,
        );
      } catch (httpError) {
        await requeueMessage(
          workerRedis,
          listKey,
          processingListKey,
          item,
          'HTTP request failed',
          httpError,
        );
      }
    } catch (parseError) {
      await requeueMessage(
        workerRedis,
        listKey,
        processingListKey,
        item,
        'Error processing message',
        parseError,
      );
    }
  }

  async function worker(queuePrefix: QueuePrefix, listKey: string) {
    const workerRedis = redis.duplicate();
    const processingListKey = `${listKey}:processing`;

    try {
      while (true) {
        const item = await fetchMessage(workerRedis, listKey, processingListKey);

        if (item) {
          await processSingleMessage(workerRedis, listKey, processingListKey, item, queuePrefix);
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
          console.error(`[world-postgres-redis] Worker for ${listKey} crashed:`, error);
        });
      }
    });
  }

  return {
    createQueueHandler,
    getDeploymentId,
    queue,
    outboxRelay,
    async start() {
      // Start outbox relay (polls Postgres outbox -> Redis)
      outboxRelay.start();
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

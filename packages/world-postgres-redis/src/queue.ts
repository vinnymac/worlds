import { setTimeout as delay } from 'node:timers/promises';
import {
  MessageId,
  type Queue,
  type QueuePayload,
  type QueuePrefix,
  type ValidQueueName,
} from '@workflow/world';
import { eq } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { monotonicFactory } from 'ulid';
import type { PostgresWorldConfig } from './config.js';
import { type Drizzle, Schema } from './drizzle/index.js';
import { createOutboxRelay, type OutboxRelay } from './outbox.js';
import { debug } from './util.js';

interface MessageEnvelope {
  messageId: string;
  idempotencyKey?: string;
  queueName: ValidQueueName;
  attempt: number;
  message: QueuePayload;
}

const QUEUE_PATHNAMES = {
  __wkf_workflow_: 'flow',
  __wkf_step_: 'step',
} as const satisfies Record<QueuePrefix, string>;

function resolveBaseUrl(config: PostgresWorldConfig): string {
  if (config.baseUrl) return config.baseUrl;
  if (process.env.WORKFLOW_BASE_URL) return process.env.WORKFLOW_BASE_URL;
  const port = process.env.PORT ?? '3000';
  return `http://localhost:${port}`;
}

function computeBackoffMs(attempt: number, config: PostgresWorldConfig): number {
  const base = config.backoffDelayMs ?? 1000;
  if (config.backoffType === 'fixed') return base;
  return base * 2 ** Math.max(0, attempt - 1);
}

/**
 * Postgres-Redis queue.
 *
 * - `queue()` writes the envelope to a Postgres outbox table first (atomic
 *   with any user transaction the caller wraps around it), then optimistically
 *   LPUSHes to a Redis list. If the Redis push fails, the outbox relay drains
 *   the row asynchronously.
 * - Workers BRPOPLPUSH to a processing list, then dispatch the payload via
 *   HTTP fetch to `${baseUrl}/.well-known/workflow/v1/{flow|step}`. Retries
 *   and 503-soft-retry are implemented manually.
 */
export function createQueue(
  redis: Redis,
  drizzle: Drizzle,
  config: PostgresWorldConfig,
): Queue & { start(): Promise<void>; outboxRelay: OutboxRelay } {
  const generateMessageId = monotonicFactory();
  const maxAttempts = config.maxAttempts ?? 5;
  const httpTimeoutMs = config.httpTimeoutMs ?? 300_000;

  const prefix = config.jobPrefix || 'workflow_';
  const Queues = {
    __wkf_workflow_: `${prefix}flows`,
    __wkf_step_: `${prefix}steps`,
  } as const satisfies Record<QueuePrefix, string>;

  const getDeploymentId: Queue['getDeploymentId'] = async () => 'postgres-redis';

  async function pushToRedis(listKey: string, payload: string): Promise<void> {
    await redis.multi().lpush(listKey, payload).publish(`chan:${listKey}`, 'new').exec();
  }

  const outboxRelay = createOutboxRelay(drizzle, async (entry) => {
    const outboxPayload = entry.payload as { listKey: string; envelope: string };
    await pushToRedis(outboxPayload.listKey, outboxPayload.envelope);
  });

  const queue: Queue['queue'] = async (queueName, message, opts) => {
    const queuePrefix = parseQueuePrefix(queueName);
    const listKey = Queues[queuePrefix];
    const messageId = MessageId.parse(`msg_${generateMessageId()}`);
    const idempotencyKey = opts?.idempotencyKey ?? messageId;

    const envelope: MessageEnvelope = {
      messageId,
      idempotencyKey: opts?.idempotencyKey,
      queueName,
      attempt: 1,
      message,
    };
    const serialized = JSON.stringify(envelope);

    // Outbox idempotency via UNIQUE(message_id) constraint.
    const [inserted] = await drizzle
      .insert(Schema.outbox)
      .values({
        id: messageId,
        messageId: idempotencyKey,
        payload: { listKey, envelope: serialized },
      })
      .onConflictDoNothing()
      .returning({ id: Schema.outbox.id });

    if (!inserted) {
      debug(`Queue: idempotent skip for ${idempotencyKey}`);
      return { messageId };
    }

    // Optimistic Redis push. Failure is recovered by the outbox relay.
    try {
      await pushToRedis(listKey, serialized);
      await drizzle.delete(Schema.outbox).where(eq(Schema.outbox.id, messageId));
    } catch (err) {
      debug(`Queue: Redis push failed for ${messageId}, outbox relay will retry:`, err);
    }

    return { messageId };
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
        debug('queue handler error:', error);
        return Response.json({ error: String(error) }, { status: 500 });
      }
    };
  };

  async function dispatch(envelope: MessageEnvelope, pathname: string): Promise<Response> {
    const baseUrl = resolveBaseUrl(config);
    const url = `${baseUrl}/.well-known/workflow/v1/${pathname}`;
    return fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-vqs-queue-name': envelope.queueName,
        'x-vqs-message-id': envelope.messageId,
        'x-vqs-message-attempt': String(envelope.attempt),
      },
      body: JSON.stringify(envelope.message),
      signal: AbortSignal.timeout(httpTimeoutMs),
    });
  }

  async function processItem(
    workerRedis: Redis,
    listKey: string,
    processingListKey: string,
    item: string,
    queuePrefix: QueuePrefix,
  ): Promise<void> {
    let envelope: MessageEnvelope;
    try {
      envelope = JSON.parse(item) as MessageEnvelope;
    } catch (error) {
      console.error(`[world-postgres-redis worker] invalid envelope on ${listKey}:`, error);
      await workerRedis.lrem(processingListKey, 1, item);
      return;
    }

    try {
      const response = await dispatch(envelope, QUEUE_PATHNAMES[queuePrefix]);

      if (response.ok) {
        await workerRedis.lrem(processingListKey, 1, item);
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
          await workerRedis.lrem(processingListKey, 1, item);
          void delay(timeoutMs).then(() => {
            void redis.lpush(listKey, item);
          });
          return;
        }
      }

      // Hard failure: increment attempt, re-LPUSH with backoff, or drop.
      await workerRedis.lrem(processingListKey, 1, item);
      if (envelope.attempt < maxAttempts) {
        const next: MessageEnvelope = { ...envelope, attempt: envelope.attempt + 1 };
        const backoffMs = computeBackoffMs(next.attempt, config);
        const payload = JSON.stringify(next);
        void delay(backoffMs).then(() => {
          void redis.lpush(listKey, payload);
        });
      } else {
        console.error(
          `[world-postgres-redis worker] dropping ${envelope.messageId} after ${envelope.attempt} attempts: HTTP ${response.status}: ${text}`,
        );
      }
    } catch (error) {
      console.error(`[world-postgres-redis worker] dispatch error on ${listKey}:`, error);
      await workerRedis.lrem(processingListKey, 1, item);
      if (envelope.attempt < maxAttempts) {
        const next: MessageEnvelope = { ...envelope, attempt: envelope.attempt + 1 };
        const backoffMs = computeBackoffMs(next.attempt, config);
        const payload = JSON.stringify(next);
        void delay(backoffMs).then(() => {
          void redis.lpush(listKey, payload);
        });
      }
    }
  }

  async function worker(queuePrefix: QueuePrefix, listKey: string) {
    const workerRedis = redis.duplicate();
    const processingListKey = `${listKey}:processing`;

    try {
      while (true) {
        let item: string | null;
        try {
          item = await workerRedis.brpoplpush(listKey, processingListKey, 0);
        } catch (error) {
          console.error(`[world-postgres-redis worker] brpoplpush error on ${listKey}:`, error);
          await delay(1000);
          continue;
        }
        if (!item) continue;
        await processItem(workerRedis, listKey, processingListKey, item, queuePrefix);
      }
    } finally {
      await workerRedis.quit();
    }
  }

  async function startWorkers() {
    const concurrency = config.queueConcurrency || 10;
    const entries = Object.entries(Queues) as [QueuePrefix, string][];

    entries.forEach(([queuePrefix, listKey]) => {
      for (let i = 0; i < concurrency; i++) {
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
      outboxRelay.start();
      startWorkers();
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

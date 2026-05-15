import { setTimeout as delay } from 'node:timers/promises';
import {
  MessageId,
  type Queue,
  type QueuePayload,
  type QueuePrefix,
  type ValidQueueName,
} from '@workflow/world';
import type { Redis } from 'ioredis';
import { monotonicFactory } from 'ulid';
import type { MysqlRedisWorldConfig } from './config.js';

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

function resolveBaseUrl(config: MysqlRedisWorldConfig): string {
  if (config.baseUrl) return config.baseUrl;
  if (process.env.WORKFLOW_BASE_URL) return process.env.WORKFLOW_BASE_URL;
  const port = process.env.PORT ?? '3000';
  return `http://localhost:${port}`;
}

function computeBackoffMs(attempt: number, config: MysqlRedisWorldConfig): number {
  const base = config.backoffDelayMs ?? 1000;
  if (config.backoffType === 'fixed') return base;
  return base * 2 ** Math.max(0, attempt - 1);
}

/**
 * MySQL-Redis queue.
 *
 * Two Redis lists per world (`${prefix}flows`, `${prefix}steps`) carry queued
 * envelopes. `queue()` LPUSHes; workers BRPOPLPUSH onto a processing list and
 * dispatch via HTTP fetch to `${baseUrl}/.well-known/workflow/v1/{flow|step}`.
 * Idempotency is tracked in a Redis SET with a 24h TTL.
 */
export function createQueue(
  redis: Redis,
  config: MysqlRedisWorldConfig,
): Queue & { start(): Promise<void> } {
  const generateMessageId = monotonicFactory();
  const maxAttempts = config.maxAttempts ?? 5;
  const httpTimeoutMs = config.httpTimeoutMs ?? 300_000;

  const prefix = config.jobPrefix || 'workflow_';
  const Queues = {
    __wkf_workflow_: `${prefix}flows`,
    __wkf_step_: `${prefix}steps`,
  } as const satisfies Record<QueuePrefix, string>;

  const getDeploymentId: Queue['getDeploymentId'] = async () =>
    config.deploymentId ?? 'mysql-redis';

  const queue: Queue['queue'] = async (queueName, message, opts) => {
    const queuePrefix = parseQueuePrefix(queueName);
    const listKey = Queues[queuePrefix];
    const messageId = MessageId.parse(`msg_${generateMessageId()}`);

    const idempotencyKey = opts?.idempotencyKey ?? messageId;
    const idempotencySetKey = `${listKey}:idempotent`;
    const added = await redis.sadd(idempotencySetKey, idempotencyKey);
    if (added === 0) {
      return { messageId };
    }
    await redis.expire(idempotencySetKey, 86_400);

    const envelope: MessageEnvelope = {
      messageId,
      idempotencyKey: opts?.idempotencyKey,
      queueName,
      attempt: 1,
      message,
    };
    const payload = JSON.stringify(envelope);

    await redis.multi().lpush(listKey, payload).publish(`chan:${listKey}`, 'new').exec();

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
      console.error(`[world-mysql-redis worker] invalid envelope on ${listKey}:`, error);
      await workerRedis.lrem(processingListKey, 1, item);
      return;
    }

    try {
      const response = await dispatch(envelope, QUEUE_PATHNAMES[queuePrefix]);

      if (response.ok) {
        await workerRedis.lrem(processingListKey, 1, item);
        if (envelope.idempotencyKey) {
          await workerRedis.srem(`${listKey}:idempotent`, envelope.idempotencyKey);
        }
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
          `[world-mysql-redis worker] dropping ${envelope.messageId} after ${envelope.attempt} attempts: HTTP ${response.status}: ${text}`,
        );
        if (envelope.idempotencyKey) {
          await workerRedis.srem(`${listKey}:idempotent`, envelope.idempotencyKey);
        }
      }
    } catch (error) {
      console.error(`[world-mysql-redis worker] dispatch error on ${listKey}:`, error);
      await workerRedis.lrem(processingListKey, 1, item);
      if (envelope.attempt < maxAttempts) {
        const next: MessageEnvelope = { ...envelope, attempt: envelope.attempt + 1 };
        const backoffMs = computeBackoffMs(next.attempt, config);
        const payload = JSON.stringify(next);
        void delay(backoffMs).then(() => {
          void redis.lpush(listKey, payload);
        });
      } else if (envelope.idempotencyKey) {
        await workerRedis.srem(`${listKey}:idempotent`, envelope.idempotencyKey);
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
          console.error(`[world-mysql-redis worker] brpoplpush error on ${listKey}:`, error);
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
          console.error(`[world-mysql-redis] Worker for ${listKey} crashed:`, error);
        });
      }
    });
  }

  return {
    createQueueHandler,
    getDeploymentId,
    queue,
    async start() {
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

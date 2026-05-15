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
import type { RedisWorldConfig } from './config.js';
import { debug } from './util.js';

/**
 * Queue depth and health statistics for observability.
 */
export interface QueueStats {
  workflowsPending: number;
  stepsPending: number;
  workflowsIdempotencyKeys: number;
  stepsIdempotencyKeys: number;
  totalPending: number;
}

interface MessageEnvelope {
  /** ulid-based id for this delivery attempt (changes on re-enqueue) */
  messageId: string;
  /** original idempotency key (preserved across retries) */
  idempotencyKey?: string;
  /** full queue name (e.g. `__wkf_workflow_wrun_…`) */
  queueName: ValidQueueName;
  /** 1-indexed attempt counter */
  attempt: number;
  /** the workflow/step payload — forwarded as the HTTP fetch body */
  message: QueuePayload;
}

const QUEUE_PATHNAMES = {
  __wkf_workflow_: 'flow',
  __wkf_step_: 'step',
} as const satisfies Record<QueuePrefix, string>;

function resolveBaseUrl(config: RedisWorldConfig): string {
  if (config.baseUrl) return config.baseUrl;
  if (process.env.WORKFLOW_BASE_URL) return process.env.WORKFLOW_BASE_URL;
  const port = process.env.PORT ?? '3000';
  return `http://localhost:${port}`;
}

function computeBackoffMs(attempt: number, config: RedisWorldConfig): number {
  const base = config.backoffDelayMs ?? 1000;
  if (config.backoffType === 'fixed') return base;
  return base * 2 ** Math.max(0, attempt - 1);
}

/**
 * Redis Lists queue. Two lists per world:
 * - `${prefix}flows` for workflow jobs
 * - `${prefix}steps` for step jobs
 *
 * `queue()` LPUSHes a JSON envelope (with idempotency tracking via a SET).
 * Workers BRPOP, then dispatch the payload via HTTP fetch to
 * `${baseUrl}/.well-known/workflow/v1/${flow|step}`. Retries and 503-soft-retry
 * are implemented manually since Redis Lists has no native delayed queue.
 */
export function createQueue(
  redis: Redis,
  config: RedisWorldConfig,
): Queue & { start(): Promise<void>; getQueueStats(): Promise<QueueStats> } {
  const generateMessageId = monotonicFactory();
  const maxAttempts = config.maxAttempts ?? 5;
  const httpTimeoutMs = config.httpTimeoutMs ?? 300_000;

  const prefix = config.jobPrefix || 'workflow_';
  const Queues = {
    __wkf_workflow_: `${prefix}flows`,
    __wkf_step_: `${prefix}steps`,
  } as const satisfies Record<QueuePrefix, string>;

  const getDeploymentId: Queue['getDeploymentId'] = async () => 'redis';

  const queue: Queue['queue'] = async (queueName, message, opts) => {
    const queuePrefix = parseQueuePrefix(queueName);
    const listKey = Queues[queuePrefix];
    const messageId = MessageId.parse(`msg_${generateMessageId()}`);

    // Idempotency via a SET — SADD returns 0 if the key already exists.
    const idempotencyKey = opts?.idempotencyKey ?? messageId;
    const idempotencySetKey = `${listKey}:idempotent`;
    const added = await redis.sadd(idempotencySetKey, idempotencyKey);
    if (added === 0) {
      return { messageId };
    }
    // Cap idempotency tracking at 24h
    await redis.expire(idempotencySetKey, 86_400);

    const envelope: MessageEnvelope = {
      messageId,
      idempotencyKey: opts?.idempotencyKey,
      queueName,
      attempt: 1,
      message,
    };

    // delaySeconds is best-effort: we sleep before LPUSH. With no native
    // delayed queue, the dispatch runs in this process, so a process restart
    // before the delay elapses drops the message.
    const delayMs = opts?.delaySeconds ? Math.max(0, opts.delaySeconds * 1000) : 0;
    if (delayMs > 0) {
      void delay(delayMs).then(() => {
        void redis
          .multi()
          .lpush(listKey, JSON.stringify(envelope))
          .publish(`chan:${listKey}`, 'new')
          .exec();
      });
    } else {
      await redis
        .multi()
        .lpush(listKey, JSON.stringify(envelope))
        .publish(`chan:${listKey}`, 'new')
        .exec();
    }

    return { messageId };
  };

  const createQueueHandler: Queue['createQueueHandler'] = (queueNamePrefix, handler) => {
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

  async function worker(queuePrefix: QueuePrefix, listKey: string) {
    const pathname = QUEUE_PATHNAMES[queuePrefix];
    // BRPOP blocks the connection, so each worker uses its own client.
    const workerRedis = redis.duplicate();

    try {
      while (true) {
        let result: [string, string] | null;
        try {
          result = await workerRedis.brpop(listKey, 0);
        } catch (error) {
          console.error(`[world-redis worker] brpop error on ${listKey}:`, error);
          await delay(1000);
          continue;
        }
        if (!result) continue;

        const item = result[1];
        let envelope: MessageEnvelope;
        try {
          envelope = JSON.parse(item) as MessageEnvelope;
        } catch (error) {
          console.error(`[world-redis worker] invalid envelope on ${listKey}:`, error);
          continue;
        }

        try {
          const baseUrl = resolveBaseUrl(config);
          const url = `${baseUrl}/.well-known/workflow/v1/${pathname}`;
          const response = await fetch(url, {
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

          if (response.ok) {
            // Success — release idempotency reservation so the same key can be
            // queued again later.
            if (envelope.idempotencyKey) {
              await workerRedis.srem(`${listKey}:idempotent`, envelope.idempotencyKey);
            }
            continue;
          }

          const text = await response.text();

          // 503 + { timeoutSeconds } — soft retry. Re-LPUSH after the delay,
          // without incrementing attempt.
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
              const payload = JSON.stringify(envelope);
              void delay(timeoutMs).then(() => {
                void redis.lpush(listKey, payload);
              });
              continue;
            }
          }

          // Hard failure — increment attempt and re-push with backoff. Drop
          // after maxAttempts.
          if (envelope.attempt < maxAttempts) {
            const nextAttempt = envelope.attempt + 1;
            const backoffMs = computeBackoffMs(nextAttempt, config);
            const next: MessageEnvelope = { ...envelope, attempt: nextAttempt };
            const payload = JSON.stringify(next);
            void delay(backoffMs).then(() => {
              void redis.lpush(listKey, payload);
            });
          } else {
            console.error(
              `[world-redis worker] dropping ${envelope.messageId} after ${envelope.attempt} attempts: HTTP ${response.status}: ${text}`,
            );
            if (envelope.idempotencyKey) {
              await workerRedis.srem(`${listKey}:idempotent`, envelope.idempotencyKey);
            }
          }
        } catch (error) {
          console.error(`[world-redis worker] dispatch error on ${listKey}:`, error);
          if (envelope.attempt < maxAttempts) {
            const nextAttempt = envelope.attempt + 1;
            const backoffMs = computeBackoffMs(nextAttempt, config);
            const next: MessageEnvelope = { ...envelope, attempt: nextAttempt };
            const payload = JSON.stringify(next);
            void delay(backoffMs).then(() => {
              void redis.lpush(listKey, payload);
            });
          } else if (envelope.idempotencyKey) {
            await workerRedis.srem(`${listKey}:idempotent`, envelope.idempotencyKey);
          }
        }
      }
    } finally {
      await workerRedis.quit();
    }
  }

  async function startWorkers() {
    const concurrency = config.queueConcurrency || 10;
    const entries = Object.entries(Queues) as [QueuePrefix, string][];
    await Promise.all(
      entries.flatMap(([queuePrefix, listKey]) =>
        Array.from({ length: concurrency }, () => worker(queuePrefix, listKey)),
      ),
    );
  }

  async function getQueueStats(): Promise<QueueStats> {
    const flowsKey = Queues['__wkf_workflow_'];
    const stepsKey = Queues['__wkf_step_'];

    const [workflowsPending, stepsPending, workflowsIdempotencyKeys, stepsIdempotencyKeys] =
      await Promise.all([
        redis.llen(flowsKey),
        redis.llen(stepsKey),
        redis.scard(`${flowsKey}:idempotent`),
        redis.scard(`${stepsKey}:idempotent`),
      ]);

    const stats: QueueStats = {
      workflowsPending,
      stepsPending,
      workflowsIdempotencyKeys,
      stepsIdempotencyKeys,
      totalPending: workflowsPending + stepsPending,
    };

    debug('queue stats', stats);
    return stats;
  }

  return {
    createQueueHandler,
    getDeploymentId,
    queue,
    getQueueStats,
    async start() {
      void startWorkers();
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

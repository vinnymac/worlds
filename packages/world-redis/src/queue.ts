import { hostname } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import {
  MessageId,
  parseQueueName,
  type Queue,
  type QueueKind,
  type QueuePayload,
  type ValidQueueName,
} from '@workflow/world';
import type { Redis } from 'ioredis';
import { monotonicFactory } from 'ulid';
import type { RedisWorldConfig } from './config.js';
import { debug, parseWithUint8Array, stringifyWithUint8Array } from './util.js';

/**
 * Queue depth and health statistics for observability.
 */
export interface QueueStats {
  workflowsPending: number;
  stepsPending: number;
  workflowsDelayed: number;
  stepsDelayed: number;
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
  workflow: 'flow',
  step: 'step',
} as const satisfies Record<QueueKind, string>;

/** TTL for idempotency reservations. A safety net only: reservations are
 * explicitly released on completion or final drop; the TTL guards against
 * reservations orphaned by bugs, not by crashes (crashed deliveries are
 * recovered from the processing list, so their reservations stay valid). */
const IDEMPOTENCY_TTL_SECONDS = 86_400;
/** How often the delayed-set promoter checks for due messages. */
const DELAYED_POLL_INTERVAL_MS = 100;
/** Max messages promoted per Lua call (loops until drained). */
const PROMOTE_BATCH = 100;
/** How often orphaned processing lists are reclaimed. */
const RECLAIM_INTERVAL_MS = 30_000;
/** Worker liveness key TTL. Generous so slow dispatches (long HTTP calls)
 * with a live heartbeat interval are never reclaimed prematurely. */
const HEARTBEAT_TTL_SECONDS = 90;
/** How often each worker refreshes its liveness key. */
const HEARTBEAT_REFRESH_MS = 30_000;
/** BLMOVE block timeout so worker loops can observe shutdown. */
const BLOCK_TIMEOUT_SECONDS = 5;
/** Delivery is at-least-once: a reclaim can race a live-but-stalled worker,
 * so duplicate deliveries are possible and are deduplicated by the storage
 * layer's EntityConflictError guards. */

// ============================================================
// Lua scripts — every multi-key queue state change is atomic.
// ============================================================

/**
 * Atomically reserve an idempotency key and enqueue an envelope, either
 * immediately (ready list) or durably delayed (sorted set scored by
 * deliver-at time). A crash can no longer separate the reservation from
 * the message.
 *
 * KEYS[1] = idempotency key
 * KEYS[2] = ready list
 * KEYS[3] = delayed zset
 * ARGV[1] = has idempotency key ("1" | "0")
 * ARGV[2] = idempotency TTL seconds
 * ARGV[3] = envelope JSON
 * ARGV[4] = deliver-at ms ("0" = immediate)
 * ARGV[5] = notify channel
 * Returns: 1 if enqueued, 0 if deduplicated
 */
const LUA_ENQUEUE = `
  if ARGV[1] == '1' then
    local reserved = redis.call('SET', KEYS[1], '1', 'NX', 'EX', tonumber(ARGV[2]))
    if not reserved then
      return 0
    end
  end
  if ARGV[4] ~= '0' then
    redis.call('ZADD', KEYS[3], tonumber(ARGV[4]), ARGV[3])
  else
    redis.call('LPUSH', KEYS[2], ARGV[3])
    redis.call('PUBLISH', ARGV[5], 'new')
  end
  return 1
`;

/**
 * Atomically promote due delayed messages to the ready list.
 *
 * KEYS[1] = delayed zset
 * KEYS[2] = ready list
 * ARGV[1] = now ms
 * ARGV[2] = batch size
 * ARGV[3] = notify channel
 * Returns: number of promoted messages
 */
const LUA_PROMOTE_DUE = `
  local due = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, tonumber(ARGV[2]))
  for i = 1, #due do
    redis.call('LPUSH', KEYS[2], due[i])
    redis.call('ZREM', KEYS[1], due[i])
  end
  if #due > 0 then
    redis.call('PUBLISH', ARGV[3], 'new')
  end
  return #due
`;

/**
 * Atomically acknowledge a delivery: remove it from the worker's processing
 * list and (optionally) release its idempotency reservation.
 *
 * KEYS[1] = processing list
 * KEYS[2] = idempotency key
 * ARGV[1] = envelope JSON as popped
 * ARGV[2] = release idempotency key ("1" | "0")
 */
const LUA_ACK = `
  redis.call('LREM', KEYS[1], 1, ARGV[1])
  if ARGV[2] == '1' then
    redis.call('DEL', KEYS[2])
  end
  return 1
`;

/**
 * Atomically defer a delivery: remove it from the worker's processing list
 * and park (a possibly updated copy of) it in the delayed zset. Used for
 * both 503 soft retries and hard-failure backoff — the message is durable
 * in Redis for the entire wait, so a process restart cannot lose it.
 *
 * KEYS[1] = processing list
 * KEYS[2] = delayed zset
 * ARGV[1] = old envelope JSON (as popped)
 * ARGV[2] = new envelope JSON
 * ARGV[3] = deliver-at ms
 */
const LUA_DEFER = `
  redis.call('LREM', KEYS[1], 1, ARGV[1])
  redis.call('ZADD', KEYS[2], tonumber(ARGV[3]), ARGV[2])
  return 1
`;

/**
 * Atomically reclaim an orphaned processing list (its owner heartbeat has
 * expired) by moving every entry back to the ready list.
 *
 * KEYS[1] = processing list
 * KEYS[2] = ready list
 * KEYS[3] = owner heartbeat key
 * ARGV[1] = notify channel
 * Returns: number of reclaimed messages
 */
const LUA_RECLAIM = `
  if redis.call('EXISTS', KEYS[3]) == 1 then
    return 0
  end
  local moved = 0
  while true do
    local v = redis.call('RPOPLPUSH', KEYS[1], KEYS[2])
    if not v then
      break
    end
    moved = moved + 1
  end
  if moved > 0 then
    redis.call('PUBLISH', ARGV[1], 'new')
  end
  return moved
`;

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
 * `queue()` atomically reserves the idempotency key and LPUSHes a JSON
 * envelope (or ZADDs it into `${list}:delayed` when delaySeconds is set).
 * Workers BLMOVE into a per-worker `${list}:processing:*` list, dispatch the
 * payload via HTTP fetch to `${baseUrl}/.well-known/workflow/v1/${flow|step}`,
 * and only then remove the entry — a crash mid-dispatch leaves the message in
 * the processing list, where the reclaimer returns it to the ready list once
 * the worker's heartbeat expires. Retries and 503-soft-retry park the message
 * in the delayed zset (never an in-process timer), so restarts cannot lose
 * deferred deliveries.
 */
export function createQueue(
  redis: Redis,
  config: RedisWorldConfig,
): Queue & {
  start(): Promise<void>;
  stop(): Promise<void>;
  getQueueStats(): Promise<QueueStats>;
} {
  const generateMessageId = monotonicFactory();
  const maxAttempts = config.maxAttempts ?? 5;
  const httpTimeoutMs = config.httpTimeoutMs ?? 300_000;

  const prefix = config.jobPrefix || 'workflow_';
  const Queues = {
    workflow: `${prefix}flows`,
    step: `${prefix}steps`,
  } as const satisfies Record<QueueKind, string>;

  const delayedKey = (listKey: string) => `${listKey}:delayed`;
  const idempotencyKeyFor = (listKey: string, key: string) => `${listKey}:idempotent:${key}`;
  const channelFor = (listKey: string) => `chan:${listKey}`;

  let started = false;
  let stopped = false;
  const abort = new AbortController();
  const workerClients = new Set<Redis>();
  const loopPromises: Promise<void>[] = [];

  /** Abortable sleep that resolves early (instead of throwing) on shutdown. */
  async function sleep(ms: number): Promise<void> {
    try {
      await delay(ms, undefined, { signal: abort.signal });
    } catch {
      // Aborted — shutting down.
    }
  }

  const getDeploymentId: Queue['getDeploymentId'] = async () => 'redis';

  const queue: Queue['queue'] = async (queueName, message, opts) => {
    const { kind } = parseQueueName(queueName);
    const listKey = Queues[kind];
    const messageId = MessageId.parse(`msg_${generateMessageId()}`);

    const envelope: MessageEnvelope = {
      messageId,
      idempotencyKey: opts?.idempotencyKey,
      queueName,
      attempt: 1,
      message,
    };

    const delayMs = opts?.delaySeconds ? Math.max(0, opts.delaySeconds * 1000) : 0;
    const deliverAt = delayMs > 0 ? Date.now() + delayMs : 0;

    // Reservation + enqueue is a single atomic Lua call: a crash can no
    // longer reserve the key without the message landing, and delayed
    // deliveries survive process restarts in the `:delayed` zset.
    await redis.eval(
      LUA_ENQUEUE,
      3,
      idempotencyKeyFor(listKey, opts?.idempotencyKey ?? messageId),
      listKey,
      delayedKey(listKey),
      opts?.idempotencyKey ? '1' : '0',
      IDEMPOTENCY_TTL_SECONDS.toString(),
      stringifyWithUint8Array(envelope),
      deliverAt.toString(),
      channelFor(listKey),
    );

    // Deduplicated enqueues still return a messageId, matching the previous
    // behavior (callers cannot distinguish a dedup from a fresh enqueue).
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
        // Binary-safe transport: revive Uint8Array markers (e.g. the CBOR
        // runInput payload used by resilient start) that the worker
        // serialized with the matching replacer.
        const body = parseWithUint8Array<QueuePayload>(await req.text());
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

  /** Ack a delivery: drop it from the processing list and release its key. */
  async function ack(
    client: Redis,
    listKey: string,
    processingKey: string,
    item: string,
    envelope: MessageEnvelope,
  ) {
    await client.eval(
      LUA_ACK,
      2,
      processingKey,
      idempotencyKeyFor(listKey, envelope.idempotencyKey ?? envelope.messageId),
      item,
      envelope.idempotencyKey ? '1' : '0',
    );
  }

  /** Defer a delivery into the delayed zset (durable, restart-safe). */
  async function defer(
    client: Redis,
    listKey: string,
    processingKey: string,
    item: string,
    nextPayload: string,
    deliverAtMs: number,
  ) {
    await client.eval(
      LUA_DEFER,
      2,
      processingKey,
      delayedKey(listKey),
      item,
      nextPayload,
      Math.round(deliverAtMs).toString(),
    );
  }

  async function worker(kind: QueueKind, listKey: string) {
    const pathname = QUEUE_PATHNAMES[kind];
    const consumerId = `${hostname()}-${process.pid}-${generateMessageId()}`;
    const processingKey = `${listKey}:processing:${consumerId}`;
    const ownerKey = `${processingKey}:owner`;
    // BLMOVE blocks the connection, so each worker uses its own client.
    const workerRedis = redis.duplicate();
    workerClients.add(workerRedis);

    // Liveness heartbeat. If this process dies, the key expires and the
    // reclaimer returns any in-flight message to the ready list.
    const heartbeat = setInterval(() => {
      void workerRedis.set(ownerKey, '1', 'EX', HEARTBEAT_TTL_SECONDS).catch(() => {});
    }, HEARTBEAT_REFRESH_MS);
    heartbeat.unref();

    try {
      while (!stopped) {
        let item: string | null;
        try {
          await workerRedis.set(ownerKey, '1', 'EX', HEARTBEAT_TTL_SECONDS);
          item = await workerRedis.blmove(
            listKey,
            processingKey,
            'RIGHT',
            'LEFT',
            BLOCK_TIMEOUT_SECONDS,
          );
        } catch (error) {
          if (stopped) break;
          console.error(`[world-redis worker] blmove error on ${listKey}:`, error);
          await sleep(1000);
          continue;
        }
        if (!item) continue;

        let envelope: MessageEnvelope;
        try {
          envelope = parseWithUint8Array<MessageEnvelope>(item);
        } catch (error) {
          console.error(`[world-redis worker] invalid envelope on ${listKey}:`, error);
          // Poison message — drop it from the processing list.
          await workerRedis.lrem(processingKey, 1, item).catch(() => {});
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
            body: stringifyWithUint8Array(envelope.message),
            signal: AbortSignal.timeout(httpTimeoutMs),
          });

          if (response.ok) {
            // Success — ack and release the idempotency reservation so the
            // same key can be queued again later.
            await ack(workerRedis, listKey, processingKey, item, envelope);
            continue;
          }

          const text = await response.text();

          // 503 + { timeoutSeconds } — soft retry. Park in the delayed zset
          // (durable across restarts) without incrementing attempt.
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
              await defer(workerRedis, listKey, processingKey, item, item, Date.now() + timeoutMs);
              continue;
            }
          }

          // Hard failure — increment attempt and park with backoff. Drop
          // after maxAttempts.
          if (envelope.attempt < maxAttempts) {
            const nextAttempt = envelope.attempt + 1;
            const backoffMs = computeBackoffMs(nextAttempt, config);
            const next: MessageEnvelope = { ...envelope, attempt: nextAttempt };
            await defer(
              workerRedis,
              listKey,
              processingKey,
              item,
              stringifyWithUint8Array(next),
              Date.now() + backoffMs,
            );
          } else {
            console.error(
              `[world-redis worker] dropping ${envelope.messageId} after ${envelope.attempt} attempts: HTTP ${response.status}: ${text}`,
            );
            // Final drop — ack releases the idempotency reservation so the
            // message can be re-enqueued instead of wedging the run forever.
            await ack(workerRedis, listKey, processingKey, item, envelope);
          }
        } catch (error) {
          if (stopped) break;
          console.error(`[world-redis worker] dispatch error on ${listKey}:`, error);
          try {
            if (envelope.attempt < maxAttempts) {
              const nextAttempt = envelope.attempt + 1;
              const backoffMs = computeBackoffMs(nextAttempt, config);
              const next: MessageEnvelope = { ...envelope, attempt: nextAttempt };
              await defer(
                workerRedis,
                listKey,
                processingKey,
                item,
                stringifyWithUint8Array(next),
                Date.now() + backoffMs,
              );
            } else {
              await ack(workerRedis, listKey, processingKey, item, envelope);
            }
          } catch (redisError) {
            // The message stays in the processing list and will be
            // reclaimed once this worker's heartbeat expires.
            console.error(`[world-redis worker] failed to defer/ack on ${listKey}:`, redisError);
          }
        }
      }
    } finally {
      clearInterval(heartbeat);
      workerClients.delete(workerRedis);
      // disconnect() (not quit()) — quit() on an already-disconnected client
      // would queue the QUIT command and trigger reconnection attempts.
      workerRedis.disconnect();
    }
  }

  /** Promote due delayed messages to the ready lists. */
  async function promoterLoop() {
    while (!stopped) {
      for (const listKey of Object.values(Queues)) {
        try {
          let promoted: unknown;
          do {
            promoted = await redis.eval(
              LUA_PROMOTE_DUE,
              2,
              delayedKey(listKey),
              listKey,
              Date.now().toString(),
              PROMOTE_BATCH.toString(),
              channelFor(listKey),
            );
          } while (promoted === PROMOTE_BATCH);
        } catch (error) {
          if (stopped) return;
          console.error(`[world-redis promoter] error on ${listKey}:`, error);
        }
      }
      await sleep(DELAYED_POLL_INTERVAL_MS);
    }
  }

  /** Return messages stranded in dead workers' processing lists. */
  async function reclaimOnce(listKey: string): Promise<void> {
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(
        cursor,
        'MATCH',
        `${listKey}:processing:*`,
        'COUNT',
        100,
      );
      cursor = next;
      for (const key of keys) {
        if (key.endsWith(':owner')) continue;
        const reclaimed = await redis.eval(
          LUA_RECLAIM,
          3,
          key,
          listKey,
          `${key}:owner`,
          channelFor(listKey),
        );
        if (typeof reclaimed === 'number' && reclaimed > 0) {
          debug(`reclaimed ${reclaimed} message(s) from ${key}`);
        }
      }
    } while (cursor !== '0');
  }

  async function reclaimerLoop() {
    while (!stopped) {
      for (const listKey of Object.values(Queues)) {
        try {
          await reclaimOnce(listKey);
        } catch (error) {
          if (stopped) return;
          console.error(`[world-redis reclaimer] error on ${listKey}:`, error);
        }
      }
      await sleep(RECLAIM_INTERVAL_MS);
    }
  }

  async function countKeys(pattern: string): Promise<number> {
    let cursor = '0';
    let count = 0;
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
      cursor = next;
      count += keys.length;
    } while (cursor !== '0');
    return count;
  }

  async function getQueueStats(): Promise<QueueStats> {
    const flowsKey = Queues.workflow;
    const stepsKey = Queues.step;

    const [
      workflowsPending,
      stepsPending,
      workflowsDelayed,
      stepsDelayed,
      workflowsIdempotencyKeys,
      stepsIdempotencyKeys,
    ] = await Promise.all([
      redis.llen(flowsKey),
      redis.llen(stepsKey),
      redis.zcard(delayedKey(flowsKey)),
      redis.zcard(delayedKey(stepsKey)),
      countKeys(`${flowsKey}:idempotent:*`),
      countKeys(`${stepsKey}:idempotent:*`),
    ]);

    const stats: QueueStats = {
      workflowsPending,
      stepsPending,
      workflowsDelayed,
      stepsDelayed,
      workflowsIdempotencyKeys,
      stepsIdempotencyKeys,
      totalPending: workflowsPending + stepsPending + workflowsDelayed + stepsDelayed,
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
      if (started) return;
      started = true;
      const concurrency = config.queueConcurrency || 10;
      const entries = Object.entries(Queues) as [QueueKind, string][];
      loopPromises.push(
        ...entries.flatMap(([kind, listKey]) =>
          Array.from({ length: concurrency }, () => worker(kind, listKey)),
        ),
        promoterLoop(),
        reclaimerLoop(),
      );
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      abort.abort();
      // Interrupt blocked BLMOVE calls so worker loops can observe `stopped`.
      for (const client of workerClients) {
        client.disconnect();
      }
      await Promise.allSettled(loopPromises);
    },
  };
}

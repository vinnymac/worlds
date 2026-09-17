import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  MessageId,
  parseQueueName,
  type Queue,
  type QueueKind,
  type QueuePayload,
  type ValidQueueName,
} from '@workflow/world';
import { createWorkflowUrl } from '@workflow/utils';
import type { Redis } from 'ioredis';
import { monotonicFactory } from 'ulid';
import { parse, stringify } from '@fantasticfour/shared';
import type { MysqlRedisWorldConfig } from './config.js';
import { debug } from './util.js';

interface MessageEnvelope {
  messageId: string;
  idempotencyKey?: string;
  queueName: ValidQueueName;
  attempt: number;
  message: QueuePayload;
}

const QUEUE_PATHNAMES = {
  workflow: 'flow',
  step: 'step',
} as const satisfies Record<QueueKind, string>;

/** How long an idempotency reservation is held (seconds). */
const IDEMPOTENCY_TTL_SECONDS = 86_400;

/** Default slack past the HTTP timeout before a processing lease is reclaimed. */
const LEASE_GRACE_MS = 30_000;

/**
 * Floor for how long an idle `:reclaims` hash survives (ms). Redis expires the
 * whole hash, so a quiet window drops every count: it undercounts and costs an
 * extra delivery, never a lost message. Per-message keys would have to be
 * derived inside Lua, which leaves them undeclared for Redis Cluster.
 */
const RECLAIMS_TTL_MS = 86_400_000;

/** How often the delayed-delivery pump and lease reclaimer run. */
const MAINTENANCE_INTERVAL_MS = 250;

/** Max entries moved per maintenance pass. */
const MAINTENANCE_BATCH_SIZE = 100;

/** How long a worker blocks waiting for an item before re-checking stop. */
const POP_TIMEOUT_SECONDS = 5;

/** Claim members are `${randomUUID()}${item}`; the UUID is always 36 chars. */
const CLAIM_TOKEN_LENGTH = 36;

/**
 * Atomically reserve an idempotency key and enqueue the payload.
 * Immediate deliveries go to the ready list; delayed deliveries go to the
 * delayed sorted set (scored by deliver-at) so they survive restarts.
 *
 * KEYS[1] = idempotency key, KEYS[2] = ready list, KEYS[3] = delayed zset
 * ARGV[1] = payload, ARGV[2] = deliverAtMs ('0' = immediate),
 * ARGV[3] = idempotency TTL seconds, ARGV[4] = pubsub channel
 */
const ENQUEUE_SCRIPT = `
local reserved = redis.call('SET', KEYS[1], '1', 'NX', 'EX', ARGV[3])
if not reserved then
  return 0
end
if ARGV[2] == '0' then
  redis.call('LPUSH', KEYS[2], ARGV[1])
  redis.call('PUBLISH', ARGV[4], 'new')
else
  redis.call('ZADD', KEYS[3], ARGV[2], ARGV[1])
end
return 1
`;

/**
 * Move due entries from the delayed sorted set to the ready list.
 *
 * KEYS[1] = delayed zset, KEYS[2] = ready list
 * ARGV[1] = now (ms), ARGV[2] = batch limit, ARGV[3] = pubsub channel
 */
const MOVE_DUE_SCRIPT = `
local due = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, tonumber(ARGV[2]))
for _, item in ipairs(due) do
  redis.call('ZREM', KEYS[1], item)
  redis.call('LPUSH', KEYS[2], item)
end
if #due > 0 then
  redis.call('PUBLISH', ARGV[3], 'new')
end
return #due
`;

/**
 * Requeue in-flight entries whose lease expired (worker died or stalled).
 * `:claims` members are token-prefixed per claim; `:leases` members are raw
 * items from pre-fencing workers or adopted orphans, reclaimed only while
 * the processing list still holds them. Each requeue bumps the item's
 * `:reclaims` count (keyed by SHA-1 of the item), which workers add to the
 * attempt so a delivery that keeps outliving its lease still dead-letters.
 *
 * KEYS[1] = lease zset, KEYS[2] = processing list, KEYS[3] = ready list,
 * KEYS[4] = claims zset, KEYS[5] = reclaims hash
 * ARGV[1] = now (ms), ARGV[2] = batch limit, ARGV[3] = claim token length,
 * ARGV[4] = reclaims TTL (ms)
 */
const RECLAIM_SCRIPT = `
local moved = 0
local function requeue(item)
  redis.call('LPUSH', KEYS[3], item)
  redis.call('HINCRBY', KEYS[5], redis.sha1hex(item), 1)
  moved = moved + 1
end
local claims = redis.call('ZRANGEBYSCORE', KEYS[4], '-inf', ARGV[1], 'LIMIT', 0, tonumber(ARGV[2]))
for _, member in ipairs(claims) do
  redis.call('ZREM', KEYS[4], member)
  requeue(string.sub(member, tonumber(ARGV[3]) + 1))
end
local due = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, tonumber(ARGV[2]))
for _, item in ipairs(due) do
  redis.call('ZREM', KEYS[1], item)
  if redis.call('LREM', KEYS[2], 1, item) > 0 then
    requeue(item)
  end
end
if moved > 0 then
  redis.call('PEXPIRE', KEYS[5], ARGV[4])
end
return moved
`;

/**
 * Convert a popped item into a fenced claim. Fails if the processing entry is
 * gone, i.e. an adopted orphan lease expired and the reclaimer requeued it.
 * Drops any raw lease adopted for this item in the pop-to-claim window: the
 * claim supersedes it, and a leftover raw lease would later reclaim whichever
 * delivery holds identical bytes.
 * Returns 0 on failure, else 1 + the item's reclaim count.
 *
 * KEYS[1] = processing list, KEYS[2] = claims zset, KEYS[3] = reclaims hash,
 * KEYS[4] = lease zset
 * ARGV[1] = item, ARGV[2] = claim token, ARGV[3] = lease deadline (ms)
 */
const CLAIM_SCRIPT = `
if redis.call('LREM', KEYS[1], 1, ARGV[1]) == 0 then
  return 0
end
redis.call('ZREM', KEYS[4], ARGV[1])
redis.call('ZADD', KEYS[2], ARGV[3], ARGV[2] .. ARGV[1])
return 1 + tonumber(redis.call('HGET', KEYS[3], redis.sha1hex(ARGV[1])) or 0)
`;

/**
 * Settle a claim only if this claim still owns it (compare-and-delete).
 * A stale claim, already reclaimed and redelivered, changes nothing. The
 * owner's settle clears the item's reclaim count: a retry payload carries
 * the counted attempt forward.
 *
 * KEYS[1] = claims zset, KEYS[2] = delayed zset, KEYS[3] = dlq list,
 * KEYS[4] = idempotency key, KEYS[5] = reclaims hash
 * ARGV[1] = claim token, ARGV[2] = item, ARGV[3] = 'ack' | 'retry' | 'dead',
 * ARGV[4] = release idempotency key ('1' | '0'), ARGV[5] = retry payload,
 * ARGV[6] = retry deliver-at (ms)
 */
const SETTLE_SCRIPT = `
if redis.call('ZREM', KEYS[1], ARGV[1] .. ARGV[2]) == 0 then
  return 0
end
redis.call('HDEL', KEYS[5], redis.sha1hex(ARGV[2]))
if ARGV[3] == 'retry' then
  redis.call('ZADD', KEYS[2], ARGV[6], ARGV[5])
elseif ARGV[3] == 'dead' then
  redis.call('LPUSH', KEYS[3], ARGV[2])
end
if ARGV[4] == '1' then
  redis.call('DEL', KEYS[4])
end
return 1
`;

/**
 * Assign a lease to processing-list entries that have none. This closes the
 * crash window between BRPOPLPUSH and CLAIM_SCRIPT (and a pre-fencing worker's
 * lease ZADD): an orphaned entry adopted here will later expire and be reclaimed.
 *
 * KEYS[1] = processing list, KEYS[2] = lease zset
 * ARGV[1] = lease deadline (ms)
 */
const ADOPT_ORPHANS_SCRIPT = `
local items = redis.call('LRANGE', KEYS[1], 0, -1)
local adopted = 0
for _, item in ipairs(items) do
  if not redis.call('ZSCORE', KEYS[2], item) then
    redis.call('ZADD', KEYS[2], ARGV[1], item)
    adopted = adopted + 1
  end
end
return adopted
`;

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
 *
 * Durability model (at-least-once):
 * - Delayed deliveries (enqueue delaySeconds, retry backoff, 503 suspension)
 *   live in a `:delayed` sorted set scored by deliver-at time; a maintenance
 *   pump atomically moves due entries to the ready list. No delivery ever
 *   depends on an in-process timer surviving.
 * - Every popped item becomes a claim in a `:claims` sorted set, fenced by a
 *   per-claim token; expired claims (worker crashed or stalled) are moved back
 *   to the ready list, and a stale claim's settle is a no-op.
 * - Messages that exhaust maxAttempts are pushed to a `:dlq` list and their
 *   idempotency reservation is released so core's replay-driven re-enqueue
 *   can self-heal the run.
 * - Idempotency reservations are per-key strings with a 24h TTL, released on
 *   successful dispatch.
 *
 * Envelopes are serialized with the shared tagged-JSON codec so Uint8Array
 * values (e.g. the CBOR-transport `runInput.input` on workflow messages)
 * survive the queue round-trip intact.
 */
export function createQueue(
  redis: Redis,
  config: MysqlRedisWorldConfig,
): Queue & { start(): Promise<void>; stop(): void } {
  const generateMessageId = monotonicFactory();
  const maxAttempts = config.maxAttempts ?? 5;
  const httpTimeoutMs = config.httpTimeoutMs ?? 300_000;
  const { visibilityTimeoutMs } = config;
  if (
    visibilityTimeoutMs !== undefined &&
    !(Number.isSafeInteger(visibilityTimeoutMs) && visibilityTimeoutMs >= httpTimeoutMs)
  ) {
    // A lease shorter than the dispatch timeout guarantees concurrent redelivery.
    throw new RangeError(
      `[world-mysql-redis] visibilityTimeoutMs must be an integer >= httpTimeoutMs (${httpTimeoutMs}), got ${visibilityTimeoutMs}`,
    );
  }
  const leaseMs = visibilityTimeoutMs ?? httpTimeoutMs + LEASE_GRACE_MS;
  // Outlive a requeued item's wait for a free worker, and at least two leases.
  const reclaimsTtlMs = Math.max(RECLAIMS_TTL_MS, leaseMs * 2);

  const prefix = config.jobPrefix || 'workflow_';
  const Queues = {
    workflow: `${prefix}flows`,
    step: `${prefix}steps`,
  } as const satisfies Record<QueueKind, string>;

  let stopped = false;

  const keysFor = (listKey: string) => ({
    ready: listKey,
    delayed: `${listKey}:delayed`,
    processing: `${listKey}:processing`,
    /** Raw-item leases: orphan adoption and pre-fencing workers. */
    leases: `${listKey}:leases`,
    claims: `${listKey}:claims`,
    reclaims: `${listKey}:reclaims`,
    dlq: `${listKey}:dlq`,
    channel: `chan:${listKey}`,
    idempotency: (key: string) => `${listKey}:idempotent:${key}`,
  });

  const getDeploymentId: Queue['getDeploymentId'] = async () =>
    config.deploymentId ?? 'mysql-redis';

  const queue: Queue['queue'] = async (queueName, message, opts) => {
    const { kind } = parseQueueName(queueName);
    const keys = keysFor(Queues[kind]);
    const messageId = MessageId.parse(`msg_${generateMessageId()}`);

    const idempotencyKey = opts?.idempotencyKey ?? messageId;

    const envelope: MessageEnvelope = {
      messageId,
      idempotencyKey: opts?.idempotencyKey,
      queueName,
      attempt: 1,
      message,
    };
    const payload = stringify(envelope);
    const deliverAtMs = opts?.delaySeconds ? Date.now() + Math.max(0, opts.delaySeconds * 1000) : 0;

    await redis.eval(
      ENQUEUE_SCRIPT,
      3,
      keys.idempotency(idempotencyKey),
      keys.ready,
      keys.delayed,
      payload,
      String(deliverAtMs),
      String(IDEMPOTENCY_TTL_SECONDS),
      keys.channel,
    );

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
        const body = parse<unknown>(await req.text());
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

  async function dispatch(envelope: MessageEnvelope, pathname: 'flow' | 'step'): Promise<Response> {
    const baseUrl = resolveBaseUrl(config);
    const url = createWorkflowUrl(baseUrl, { type: pathname });
    return fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-vqs-queue-name': envelope.queueName,
        'x-vqs-message-id': envelope.messageId,
        'x-vqs-message-attempt': String(envelope.attempt),
      },
      body: stringify(envelope.message),
      signal: AbortSignal.timeout(httpTimeoutMs),
    });
  }

  type Settle =
    | { mode: 'ack'; releaseIdempotencyKey?: string }
    | { mode: 'retry'; payload: string; deliverAtMs: number }
    | { mode: 'dead'; releaseIdempotencyKey?: string };

  /**
   * Atomically ack, reschedule, or dead-letter a claim. A stale claim leaves
   * the redelivered claim's lease, retry, and idempotency key to its owner.
   */
  async function settle(
    workerRedis: Redis,
    listKey: string,
    token: string,
    item: string,
    action: Settle,
  ): Promise<void> {
    const keys = keysFor(listKey);
    const release = action.mode === 'retry' ? undefined : action.releaseIdempotencyKey;
    const settled = await workerRedis.eval(
      SETTLE_SCRIPT,
      5,
      keys.claims,
      keys.delayed,
      keys.dlq,
      keys.idempotency(release ?? ''),
      keys.reclaims,
      token,
      item,
      action.mode,
      release ? '1' : '0',
      action.mode === 'retry' ? action.payload : '',
      action.mode === 'retry' ? String(action.deliverAtMs) : '0',
    );
    if (settled === 0) {
      debug(`worker skipped stale ${action.mode} on ${listKey}: claim was reclaimed`);
    }
  }

  async function processItem(
    workerRedis: Redis,
    listKey: string,
    token: string,
    item: string,
    reclaims: number,
    kind: QueueKind,
  ): Promise<void> {
    let envelope: MessageEnvelope;
    try {
      const parsed = parse<MessageEnvelope>(item);
      // Each lease expiry spent a delivery that never settled its own retry.
      envelope = { ...parsed, attempt: parsed.attempt + reclaims };
    } catch (error) {
      console.error(`[world-mysql-redis worker] invalid envelope on ${listKey}:`, error);
      await settle(workerRedis, listKey, token, item, { mode: 'ack' });
      return;
    }

    if (envelope.attempt > maxAttempts) {
      console.error(
        `[world-mysql-redis worker] dead-lettering ${envelope.messageId}: lease expired ${reclaims} time(s), exhausting ${maxAttempts} attempts`,
      );
      await settle(workerRedis, listKey, token, item, {
        mode: 'dead',
        releaseIdempotencyKey: envelope.idempotencyKey,
      });
      return;
    }

    const retryOrDeadLetter = async (reason: string) => {
      if (envelope.attempt < maxAttempts) {
        const next: MessageEnvelope = { ...envelope, attempt: envelope.attempt + 1 };
        const backoffMs = computeBackoffMs(next.attempt, config);
        await settle(workerRedis, listKey, token, item, {
          mode: 'retry',
          payload: stringify(next),
          deliverAtMs: Date.now() + backoffMs,
        });
      } else {
        console.error(
          `[world-mysql-redis worker] dead-lettering ${envelope.messageId} after ${envelope.attempt} attempts: ${reason}`,
        );
        await settle(workerRedis, listKey, token, item, {
          mode: 'dead',
          releaseIdempotencyKey: envelope.idempotencyKey,
        });
      }
    };

    try {
      const response = await dispatch(envelope, QUEUE_PATHNAMES[kind]);

      if (response.ok) {
        await settle(workerRedis, listKey, token, item, {
          mode: 'ack',
          releaseIdempotencyKey: envelope.idempotencyKey,
        });
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
          // Suspension: redeliver the same envelope (attempt unchanged, but
          // keeping any counted reclaims) after the requested timeout.
          const timeoutMs = (parsed as { timeoutSeconds: number }).timeoutSeconds * 1000;
          await settle(workerRedis, listKey, token, item, {
            mode: 'retry',
            payload: reclaims > 0 ? stringify(envelope) : item,
            deliverAtMs: Date.now() + timeoutMs,
          });
          return;
        }
      }

      await retryOrDeadLetter(`HTTP ${response.status}: ${text}`);
    } catch (error) {
      console.error(`[world-mysql-redis worker] dispatch error on ${listKey}:`, error);
      await retryOrDeadLetter(String(error));
    }
  }

  async function worker(kind: QueueKind, listKey: string) {
    // `duplicate()` copies the parent's options, and auto-pipelining is a
    // storage-side setting: batching a blocking BRPOPLPUSH with other
    // commands would stall them behind it, so it is turned off here.
    const workerRedis = redis.duplicate({ enableAutoPipelining: false });
    const keys = keysFor(listKey);

    try {
      while (!stopped) {
        let item: string | null;
        try {
          item = await workerRedis.brpoplpush(keys.ready, keys.processing, POP_TIMEOUT_SECONDS);
        } catch (error) {
          if (stopped) break;
          console.error(`[world-mysql-redis worker] brpoplpush error on ${listKey}:`, error);
          await delay(1000);
          continue;
        }
        if (!item) continue;
        // Lease the item under a fresh token so the reclaimer can requeue it
        // and a stale settle from an earlier claim cannot clear this one.
        const token = randomUUID();
        const claimed = await workerRedis.eval(
          CLAIM_SCRIPT,
          4,
          keys.processing,
          keys.claims,
          keys.reclaims,
          keys.leases,
          item,
          token,
          String(Date.now() + leaseMs),
        );
        if (typeof claimed !== 'number') {
          throw new TypeError(`CLAIM_SCRIPT returned ${String(claimed)}`);
        }
        if (claimed === 0) {
          debug(`worker ${listKey} item was reclaimed before its claim`);
          continue;
        }
        await processItem(workerRedis, listKey, token, item, claimed - 1, kind);
      }
    } finally {
      await workerRedis.quit();
    }
  }

  /**
   * Per-list maintenance loop: promotes due delayed entries to the ready list
   * and reclaims processing entries whose lease expired.
   */
  async function maintenance(listKey: string) {
    const keys = keysFor(listKey);
    while (!stopped) {
      try {
        await redis.eval(
          MOVE_DUE_SCRIPT,
          2,
          keys.delayed,
          keys.ready,
          String(Date.now()),
          String(MAINTENANCE_BATCH_SIZE),
          keys.channel,
        );
        await redis.eval(
          ADOPT_ORPHANS_SCRIPT,
          2,
          keys.processing,
          keys.leases,
          String(Date.now() + leaseMs),
        );
        const reclaimed = await redis.eval(
          RECLAIM_SCRIPT,
          5,
          keys.leases,
          keys.processing,
          keys.ready,
          keys.claims,
          keys.reclaims,
          String(Date.now()),
          String(MAINTENANCE_BATCH_SIZE),
          String(CLAIM_TOKEN_LENGTH),
          String(reclaimsTtlMs),
        );
        if (typeof reclaimed === 'number' && reclaimed > 0) {
          console.warn(
            `[world-mysql-redis] reclaimed ${reclaimed} stale processing item(s) on ${listKey}`,
          );
        }
      } catch (error) {
        if (stopped) break;
        console.error(`[world-mysql-redis] maintenance error on ${listKey}:`, error);
        await delay(1000);
        continue;
      }
      await delay(MAINTENANCE_INTERVAL_MS);
    }
  }

  function startWorkers() {
    const concurrency = config.queueConcurrency || 10;
    const entries = Object.entries(Queues) as [QueueKind, string][];
    entries.forEach(([kind, listKey]) => {
      maintenance(listKey).catch((error) => {
        console.error(`[world-mysql-redis] Maintenance loop for ${listKey} crashed:`, error);
      });
      for (let i = 0; i < concurrency; i++) {
        worker(kind, listKey).catch((error) => {
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
    stop() {
      stopped = true;
    },
  };
}

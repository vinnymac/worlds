import { setTimeout as delay } from 'node:timers/promises';
import {
  MessageId,
  parseQueueName,
  type Queue,
  type QueueKind,
  QueuePayloadSchema,
  type ValidQueueName,
} from '@workflow/world';
import { createWorkflowUrl } from '@workflow/utils';
import { eq } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { monotonicFactory } from 'ulid';
import type { PostgresWorldConfig } from './config.js';
import { type Drizzle, Schema } from './drizzle/index.js';
import { createOutboxRelay, type OutboxRelay } from './outbox.js';
import { createEventsStorage } from './storage.js';
import { debug } from './util.js';

interface MessageEnvelope {
  messageId: string;
  idempotencyKey?: string;
  queueName: ValidQueueName;
  attempt: number;
  message: unknown;
}

const QUEUE_PATHNAMES = {
  workflow: 'flow',
  step: 'step',
} as const satisfies Record<QueueKind, string>;

/** How long an enqueue-dedup key survives if never explicitly released. */
const DEDUP_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** How often due delayed/expired-inflight messages are promoted to the ready list. */
const PROMOTE_INTERVAL_MS = 1_000;
/** Extra slack on top of the HTTP timeout before an unacked message redelivers. */
const VISIBILITY_BUFFER_MS = 60_000;
/** Cap on the delivery-side completed-idempotency-key cache. */
const COMPLETED_IDEMPOTENCY_CACHE_LIMIT = 10_000;

/**
 * Atomically move members with score <= ARGV[1] from the sorted set (KEYS[1])
 * to the ready list (KEYS[2]). Used for both the delayed queue and expired
 * in-flight (visibility timeout) recovery.
 */
const MOVE_DUE_SCRIPT = `
local due = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, 100)
for _, member in ipairs(due) do
  redis.call('ZREM', KEYS[1], member)
  redis.call('LPUSH', KEYS[2], member)
end
return #due
`;

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
 * JSON replacer that preserves Uint8Array values via a tagged envelope
 * ({ __type: 'Uint8Array', data: '<base64>' }). Required for the resilient
 * start path where runInput.input (a Uint8Array) travels through the queue.
 */
function binaryReplacer(_key: string, value: unknown): unknown {
  return value instanceof Uint8Array
    ? { __type: 'Uint8Array', data: Buffer.from(value).toString('base64') }
    : value;
}

function binaryReviver(_key: string, value: unknown): unknown {
  if (
    value !== null &&
    typeof value === 'object' &&
    (value as { __type?: unknown }).__type === 'Uint8Array' &&
    typeof (value as { data?: unknown }).data === 'string'
  ) {
    return new Uint8Array(Buffer.from((value as { data: string }).data, 'base64'));
  }
  return value;
}

interface OutboxQueuePayload {
  listKey: string;
  envelope: string;
  deliverAt?: number;
}

/**
 * Postgres-Redis queue.
 *
 * - `queue()` dedups by idempotency key (durable Redis key held for the
 *   message lifetime), writes the envelope to a Postgres outbox table, then
 *   optimistically LPUSHes to a Redis list. If the Redis push fails, the
 *   outbox relay drains the row asynchronously.
 * - Workers BRPOPLPUSH to a processing list, claim the item into an in-flight
 *   sorted set (score = visibility deadline), then dispatch the payload via
 *   HTTP fetch to `${baseUrl}/.well-known/workflow/v1/{flow|step}`.
 * - All delayed redelivery (sleep()/503 soft-retry, failure backoff) goes
 *   through a Redis sorted set scored by delivery time, so pending wake-ups
 *   survive process restarts. A poller promotes due items, and in-flight
 *   items whose visibility deadline expired (crashed worker), back to the
 *   ready list.
 */
export function createQueue(
  redis: Redis,
  drizzle: Drizzle,
  config: PostgresWorldConfig,
): Queue & { start(): Promise<void>; close(): Promise<void>; outboxRelay: OutboxRelay } {
  const generateMessageId = monotonicFactory();
  const maxAttempts = config.maxAttempts ?? 5;
  const httpTimeoutMs = config.httpTimeoutMs ?? 300_000;
  const visibilityMs = httpTimeoutMs + VISIBILITY_BUFFER_MS;

  const prefix = config.jobPrefix || 'workflow_';
  const Queues = {
    workflow: `${prefix}flows`,
    step: `${prefix}steps`,
  } as const satisfies Record<QueueKind, string>;
  const queueEntries = Object.entries(Queues) as [QueueKind, string][];

  // Used to fail the run loudly when a message exhausts its delivery attempts.
  const events = createEventsStorage(drizzle);

  let started = false;
  let closed = false;
  let stopOutboxRelay: (() => void) | null = null;
  let promoteTimer: ReturnType<typeof setInterval> | null = null;
  const workerLoops: Promise<void>[] = [];

  // Delivery-side dedup (same-process): completed keys are never re-executed,
  // in-flight keys cause duplicate deliveries to be acked without dispatch.
  const completedMessages = new Set<string>();
  const inflightMessages = new Map<string, { item: string; execution: Promise<void> }>();

  function markMessageCompleted(idempotencyKey: string): void {
    completedMessages.delete(idempotencyKey);
    completedMessages.add(idempotencyKey);
    if (completedMessages.size > COMPLETED_IDEMPOTENCY_CACHE_LIMIT) {
      const oldestKey = completedMessages.values().next().value;
      if (oldestKey) {
        completedMessages.delete(oldestKey);
      }
    }
  }

  const dedupKeyFor = (listKey: string, idempotencyKey: string) =>
    `${listKey}:dedup:${idempotencyKey}`;

  const getDeploymentId: Queue['getDeploymentId'] = async () => 'postgres-redis';

  async function pushToRedis(listKey: string, payload: string, deliverAt?: number): Promise<void> {
    if (deliverAt !== undefined && deliverAt > Date.now()) {
      await redis.zadd(`${listKey}:delayed`, deliverAt, payload);
      return;
    }
    await redis.multi().lpush(listKey, payload).publish(`chan:${listKey}`, 'new').exec();
  }

  const outboxRelay = createOutboxRelay(drizzle, async (entry) => {
    const outboxPayload = entry.payload as OutboxQueuePayload;
    await pushToRedis(outboxPayload.listKey, outboxPayload.envelope, outboxPayload.deliverAt);
  });

  const queue: Queue['queue'] = async (queueName, message, opts) => {
    const { kind } = parseQueueName(queueName);
    const listKey = Queues[kind];
    const messageId = MessageId.parse(`msg_${generateMessageId()}`);
    const idempotencyKey = opts?.idempotencyKey;
    const dedupKey = idempotencyKey ? dedupKeyFor(listKey, idempotencyKey) : null;

    // Durable enqueue dedup: while a message with this idempotency key is
    // queued, delayed, or in flight, duplicate enqueues are dropped. Core
    // re-enqueues every still-pending step on each workflow replay and
    // relies on this to avoid double execution.
    if (dedupKey) {
      try {
        if (await redis.exists(dedupKey)) {
          debug(`Queue: idempotent skip for ${idempotencyKey}`);
          return { messageId };
        }
      } catch (err) {
        // Redis unreachable: fall through; the outbox UNIQUE constraint
        // still dedups concurrent enqueues, and delivery-side dedup plus
        // storage-level conflict guards make duplicates benign.
        debug(`Queue: dedup check failed for ${idempotencyKey}:`, err);
      }
    }

    const envelope: MessageEnvelope = {
      messageId,
      idempotencyKey,
      queueName,
      attempt: 1,
      message,
    };
    const serialized = JSON.stringify(envelope, binaryReplacer);
    const deliverAt =
      typeof opts?.delaySeconds === 'number' && opts.delaySeconds > 0
        ? Date.now() + opts.delaySeconds * 1000
        : undefined;

    // Outbox idempotency via UNIQUE(message_id) constraint.
    const [inserted] = await drizzle
      .insert(Schema.outbox)
      .values({
        id: messageId,
        messageId: idempotencyKey ?? messageId,
        payload: { listKey, envelope: serialized, deliverAt } satisfies OutboxQueuePayload,
      })
      .onConflictDoNothing()
      .returning({ id: Schema.outbox.id });

    if (!inserted) {
      debug(`Queue: idempotent skip for ${idempotencyKey ?? messageId}`);
      return { messageId };
    }

    // Optimistic Redis push. Failure is recovered by the outbox relay.
    try {
      if (dedupKey) {
        await redis.set(dedupKey, messageId, 'PX', DEDUP_TTL_MS);
      }
      await pushToRedis(listKey, serialized, deliverAt);
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
        // Binary-safe transport: revive tagged Uint8Array values (e.g. the
        // resilient-start runInput.input) before handing off to the runtime.
        const body = QueuePayloadSchema.parse(JSON.parse(await req.text(), binaryReviver));
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
      // The message was parsed without the binary reviver, so any tagged
      // Uint8Array values round-trip verbatim; the queue handler revives them.
      body: JSON.stringify(envelope.message),
      signal: AbortSignal.timeout(httpTimeoutMs),
    });
  }

  async function releaseDedupKey(listKey: string, envelope: MessageEnvelope): Promise<void> {
    if (!envelope.idempotencyKey) return;
    try {
      await redis.del(dedupKeyFor(listKey, envelope.idempotencyKey));
    } catch (err) {
      debug(`Queue: failed to release dedup key for ${envelope.idempotencyKey}:`, err);
    }
  }

  /**
   * Fail the run loudly when a message exhausts its delivery attempts, so the
   * run reaches a terminal state instead of silently never completing.
   */
  async function failRunForExhaustedMessage(
    envelope: MessageEnvelope,
    reason: string,
  ): Promise<void> {
    const parsed = QueuePayloadSchema.safeParse(
      JSON.parse(JSON.stringify(envelope.message), binaryReviver),
    );
    if (!parsed.success) return;
    const message = parsed.data;
    const runId =
      'runId' in message
        ? message.runId
        : 'workflowRunId' in message
          ? message.workflowRunId
          : null;
    if (!runId) return;
    try {
      await events.create(runId, {
        eventType: 'run_failed',
        eventData: {
          error: {
            message: `Queue delivery for "${envelope.queueName}" failed after ${envelope.attempt} attempts: ${reason}`,
          },
        },
      });
    } catch (err) {
      // Run may already be terminal (EntityConflictError); that's fine.
      debug(`Queue: could not record run_failed for dropped message ${envelope.messageId}:`, err);
    }
  }

  async function executeItem(
    workerRedis: Redis,
    listKey: string,
    item: string,
    envelope: MessageEnvelope,
    kind: QueueKind,
  ): Promise<void> {
    const inflightKey = `${listKey}:inflight`;
    const delayedKey = `${listKey}:delayed`;
    const ack = () => workerRedis.zrem(inflightKey, item);

    const scheduleRetry = async (reason: string): Promise<void> => {
      if (envelope.attempt < maxAttempts) {
        const next: MessageEnvelope = { ...envelope, attempt: envelope.attempt + 1 };
        const backoffMs = computeBackoffMs(next.attempt, config);
        // ZADD before ZREM: a crash in between double-delivers (benign)
        // instead of losing the message.
        await workerRedis.zadd(delayedKey, Date.now() + backoffMs, JSON.stringify(next));
        await ack();
      } else {
        console.error(
          `[world-postgres-redis worker] dropping ${envelope.messageId} after ${envelope.attempt} attempts: ${reason}`,
        );
        await failRunForExhaustedMessage(envelope, reason);
        await releaseDedupKey(listKey, envelope);
        await ack();
      }
    };

    try {
      const response = await dispatch(envelope, QUEUE_PATHNAMES[kind]);

      if (response.ok) {
        if (envelope.idempotencyKey) {
          markMessageCompleted(envelope.idempotencyKey);
        }
        await releaseDedupKey(listKey, envelope);
        await ack();
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
          // Durable delayed redelivery: park the message in the delayed
          // sorted set so the wake-up survives process restarts.
          await workerRedis.zadd(delayedKey, Date.now() + timeoutMs, item);
          if (envelope.idempotencyKey) {
            // Keep the enqueue-dedup key alive at least as long as the delay.
            try {
              await workerRedis.pexpire(
                dedupKeyFor(listKey, envelope.idempotencyKey),
                timeoutMs + DEDUP_TTL_MS,
              );
            } catch (err) {
              debug('Queue: failed to extend dedup TTL:', err);
            }
          }
          await ack();
          return;
        }
      }

      await scheduleRetry(`HTTP ${response.status}: ${text}`);
    } catch (error) {
      console.error(`[world-postgres-redis worker] dispatch error on ${listKey}:`, error);
      await scheduleRetry(String(error));
    }
  }

  async function processItem(
    workerRedis: Redis,
    listKey: string,
    processingListKey: string,
    item: string,
    kind: QueueKind,
  ): Promise<void> {
    // Claim the item: record a visibility deadline in the in-flight sorted
    // set, then drop it from the processing landing zone. If this worker
    // dies mid-flight, the promote loop redelivers after the deadline.
    await workerRedis.zadd(`${listKey}:inflight`, Date.now() + visibilityMs, item);
    await workerRedis.lrem(processingListKey, 1, item);
    const ack = () => workerRedis.zrem(`${listKey}:inflight`, item);

    let envelope: MessageEnvelope;
    try {
      // Parsed without the binary reviver: tagged Uint8Array values stay
      // tagged so dispatch can round-trip them verbatim.
      envelope = JSON.parse(item) as MessageEnvelope;
    } catch (error) {
      console.error(`[world-postgres-redis worker] invalid envelope on ${listKey}:`, error);
      await ack();
      return;
    }

    const idempotencyKey = envelope.idempotencyKey;
    if (!idempotencyKey) {
      await executeItem(workerRedis, listKey, item, envelope, kind);
      return;
    }
    if (completedMessages.has(idempotencyKey)) {
      await ack();
      return;
    }
    const existing = inflightMessages.get(idempotencyKey);
    if (existing) {
      // Duplicate delivery while the original is still executing: ack it
      // without dispatching. The original owns retry/reschedule handling.
      // Byte-identical duplicates share the in-flight zset member with the
      // original, so acking here would strip the original's visibility
      // protection: leave that entry for the original's own ack.
      if (existing.item !== item) {
        await ack();
      }
      return;
    }
    const execution = executeItem(workerRedis, listKey, item, envelope, kind).finally(() => {
      inflightMessages.delete(idempotencyKey);
    });
    inflightMessages.set(idempotencyKey, { item, execution });
    await execution;
  }

  async function worker(kind: QueueKind, listKey: string) {
    // `duplicate()` copies the parent's options, and auto-pipelining is a
    // storage-side setting: batching a blocking BRPOPLPUSH with other
    // commands would stall them behind it, so it is turned off here.
    const workerRedis = redis.duplicate({ enableAutoPipelining: false });
    const processingListKey = `${listKey}:processing`;

    try {
      while (!closed) {
        let item: string | null;
        try {
          // Bounded timeout so close() can stop the loop promptly.
          item = await workerRedis.brpoplpush(listKey, processingListKey, 5);
        } catch (error) {
          if (closed) break;
          console.error(`[world-postgres-redis worker] brpoplpush error on ${listKey}:`, error);
          await delay(1000);
          continue;
        }
        if (!item) continue;
        await processItem(workerRedis, listKey, processingListKey, item, kind);
      }
    } finally {
      await workerRedis.quit().catch(() => {
        workerRedis.disconnect();
      });
    }
  }

  /**
   * Requeue items stranded in the processing landing zone by a crash between
   * BRPOPLPUSH and the in-flight claim. The window is milliseconds wide, so
   * the odd item stolen from a live worker just becomes a benign duplicate.
   */
  async function recoverProcessingList(listKey: string): Promise<void> {
    const processingListKey = `${listKey}:processing`;
    for (;;) {
      const item = await redis.rpoplpush(processingListKey, listKey);
      if (item === null) break;
    }
  }

  /** Promote due delayed messages and expired in-flight messages. */
  async function promoteDueMessages(listKey: string): Promise<void> {
    const now = String(Date.now());
    for (const source of [`${listKey}:delayed`, `${listKey}:inflight`]) {
      try {
        await redis.eval(MOVE_DUE_SCRIPT, 2, source, listKey, now);
      } catch (err) {
        if (!closed) {
          debug(`Queue: promote cycle failed for ${source}:`, err);
        }
      }
    }
  }

  function startWorkers() {
    const concurrency = config.queueConcurrency || 10;
    for (const [kind, listKey] of queueEntries) {
      for (let i = 0; i < concurrency; i++) {
        workerLoops.push(
          worker(kind, listKey).catch((error) => {
            console.error(`[world-postgres-redis] Worker for ${listKey} crashed:`, error);
          }),
        );
      }
    }
  }

  return {
    createQueueHandler,
    getDeploymentId,
    queue,
    outboxRelay,
    async start() {
      if (started) return;
      started = true;
      stopOutboxRelay = outboxRelay.start();
      for (const [, listKey] of queueEntries) {
        await recoverProcessingList(listKey);
      }
      startWorkers();
      promoteTimer = setInterval(() => {
        for (const [, listKey] of queueEntries) {
          void promoteDueMessages(listKey);
        }
      }, PROMOTE_INTERVAL_MS);
    },
    async close() {
      closed = true;
      if (promoteTimer) {
        clearInterval(promoteTimer);
        promoteTimer = null;
      }
      stopOutboxRelay?.();
      stopOutboxRelay = null;
      await Promise.all(workerLoops);
      workerLoops.length = 0;
    },
  };
}

import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  MessageId,
  parseQueueName,
  type Queue,
  type QueueKind,
  QueuePayloadSchema,
  type ValidQueueName,
} from '@workflow/world';
import { EntityConflictError, WorkflowRunNotFoundError } from '@workflow/errors';
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
/** How long a message's reclaim count survives without being touched. */
const RECLAIM_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** How often due delayed/expired-inflight messages are promoted to the ready list. */
const PROMOTE_INTERVAL_MS = 1_000;
const DEFAULT_HTTP_TIMEOUT_MS = 300_000;
/** Extra slack on top of the HTTP timeout before an unacked message redelivers. */
const VISIBILITY_BUFFER_MS = 60_000;
/** Cap on the delivery-side completed-idempotency-key cache. */
const COMPLETED_IDEMPOTENCY_CACHE_LIMIT = 10_000;

/**
 * In-flight members are the envelope with a per-claim token spliced in as its
 * first JSON field, so a stale executor can never settle a newer claim of the
 * same bytes, and pre-fencing workers still parse promoted members.
 */
export const CLAIM_PREFIX = '{"__wfClaim":"';
/** Length of the `<uuid>",` segment between CLAIM_PREFIX and the envelope body. */
const CLAIM_TOKEN_SEGMENT = 38;

function claimMemberFor(item: string): string {
  return `${CLAIM_PREFIX}${randomUUID()}",${item.slice(1)}`;
}

function stripClaim(member: string): string {
  return member.startsWith(CLAIM_PREFIX)
    ? `{${member.slice(CLAIM_PREFIX.length + CLAIM_TOKEN_SEGMENT)}`
    : member;
}

/**
 * Atomically move members with score <= ARGV[1] from the sorted set (KEYS[1])
 * to the ready list (KEYS[2]), stripping claim tokens (ARGV[2] is the prefix).
 * Legacy untokened members are pushed verbatim. For expired claims, ARGV[3] is
 * the reclaim counter key prefix (ARGV[4] its TTL); '' skips counting.
 * Returns { moved, uncounted }: a member with no readable messageId is still
 * promoted, since blocking the batch on it would stall every message behind
 * it, but it redelivers unbounded, so the caller reports it.
 */
const MOVE_DUE_SCRIPT = `
local due = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, 100)
local prefix = ARGV[2]
local uncounted = 0
for _, member in ipairs(due) do
  local item = member
  if string.sub(member, 1, #prefix) == prefix then
    item = '{' .. string.sub(member, #prefix + ${CLAIM_TOKEN_SEGMENT + 1})
  end
  local id = nil
  if ARGV[3] ~= '' then
    id = string.match(item, '^{"messageId":"([^"]+)"')
    if not id then
      local ok, decoded = pcall(cjson.decode, item)
      if ok and type(decoded) == 'table' and type(decoded.messageId) == 'string' then
        id = decoded.messageId
      end
    end
    if not id then
      uncounted = uncounted + 1
    end
  end
  redis.call('ZREM', KEYS[1], member)
  if id then
    redis.call('INCR', ARGV[3] .. id)
    redis.call('PEXPIRE', ARGV[3] .. id, ARGV[4])
  end
  redis.call('LPUSH', KEYS[2], item)
end
return { #due, uncounted }
`;

/**
 * Claim a popped item. KEYS: processing, inflight, reclaims counter. ARGV: raw
 * item, deadline, claim member. Returns the reclaim count, or -1 if the item
 * left the processing list (startup recovery requeued it).
 */
const CLAIM_SCRIPT = `
if redis.call('LREM', KEYS[1], 1, ARGV[1]) == 0 then return -1 end
redis.call('ZADD', KEYS[2], ARGV[2], ARGV[3])
return tonumber(redis.call('GET', KEYS[3]) or '0')
`;

/**
 * Give back the reclaim this delivery consumed, for a duplicate that holds its
 * claim without dispatching. KEYS: reclaims counter.
 */
const RELEASE_RECLAIM_SCRIPT = `
local left = redis.call('DECR', KEYS[1])
if left <= 0 then redis.call('DEL', KEYS[1]) end
return left
`;

/**
 * Push a live claim's deadline out. KEYS: inflight. ARGV: deadline, claim
 * member. Returns 0 if the claim is gone. ZADD XX CH cannot tell that apart
 * from an unchanged score.
 */
const EXTEND_CLAIM_SCRIPT = `
if not redis.call('ZSCORE', KEYS[1], ARGV[2]) then return 0 end
redis.call('ZADD', KEYS[1], ARGV[1], ARGV[2])
return 1
`;

/**
 * Compare-and-settle a claim. KEYS: inflight, delayed, dedup, reclaims counter.
 * ARGV: claim member, mode ('drop' | 'release' | 'retry' | 'suspend'),
 * deliverAt, payload, dedup PEXPIRE ms (or ''), messageId the dedup key must
 * hold to be released (or ''), reclaim counter PEXPIRE ms. Returns 0 without
 * side effects if the claim is gone. Release and retry reset the reclaim
 * count; a suspension keeps it, and outlives its own delay.
 */
const SETTLE_SCRIPT = `
if redis.call('ZREM', KEYS[1], ARGV[1]) == 0 then return 0 end
if ARGV[2] == 'release' then
  if ARGV[6] ~= '' and redis.call('GET', KEYS[3]) == ARGV[6] then
    redis.call('DEL', KEYS[3])
  end
  redis.call('DEL', KEYS[4])
elseif ARGV[2] == 'retry' or ARGV[2] == 'suspend' then
  redis.call('ZADD', KEYS[2], ARGV[3], ARGV[4])
  if ARGV[5] ~= '' then redis.call('PEXPIRE', KEYS[3], ARGV[5]) end
  if ARGV[2] == 'retry' then
    redis.call('DEL', KEYS[4])
  else
    redis.call('PEXPIRE', KEYS[4], ARGV[7])
  end
end
return 1
`;

type Settlement =
  | { mode: 'drop' }
  | { mode: 'release' }
  | { mode: 'retry'; deliverAt: number; payload: string }
  | { mode: 'suspend'; deliverAt: number; payload: string; dedupTtlMs: number };

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

function parseTimeoutSeconds(text: string): number | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && 'timeoutSeconds' in parsed) {
      return typeof parsed.timeoutSeconds === 'number' ? parsed.timeoutSeconds : null;
    }
  } catch {
    // Not JSON: treat as an ordinary failure.
  }
  return null;
}

/**
 * The in-flight visibility window. Exported so `createWorld` can reject a bad
 * `visibilityTimeoutMs` before it opens any connection.
 */
export function resolveVisibilityMs(config: PostgresWorldConfig): number {
  const httpTimeoutMs = config.httpTimeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
  const visibilityMs = config.visibilityTimeoutMs;
  if (visibilityMs === undefined) return httpTimeoutMs + VISIBILITY_BUFFER_MS;
  if (!Number.isSafeInteger(visibilityMs) || visibilityMs < httpTimeoutMs) {
    throw new RangeError(
      `world-postgres-redis: visibilityTimeoutMs must be an integer >= httpTimeoutMs (${httpTimeoutMs}), got ${visibilityMs}`,
    );
  }
  return visibilityMs;
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
  const httpTimeoutMs = config.httpTimeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
  const visibilityMs = resolveVisibilityMs(config);

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
  const inflightMessages = new Map<string, { claim: string; execution: Promise<void> }>();

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
  const reclaimsPrefixFor = (listKey: string) => `${listKey}:reclaims:`;

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

  /**
   * Settle a claim atomically against its token. A stale executor (its claim
   * expired and was redelivered) gets `false` and changes nothing in Redis.
   */
  async function settle(
    workerRedis: Redis,
    listKey: string,
    claim: string,
    envelope: MessageEnvelope,
    settlement: Settlement,
  ): Promise<boolean> {
    const inflightKey = `${listKey}:inflight`;
    const { idempotencyKey } = envelope;
    // Without an idempotency key, ARGV gates every dedup write off; the key is
    // an unused name in the dedup keyspace, never another structure.
    const dedupKey = idempotencyKey ? dedupKeyFor(listKey, idempotencyKey) : `${listKey}:dedup:`;
    const delayed =
      settlement.mode === 'retry' || settlement.mode === 'suspend' ? settlement : null;
    const settled = await workerRedis.eval(
      SETTLE_SCRIPT,
      4,
      inflightKey,
      `${listKey}:delayed`,
      dedupKey,
      `${reclaimsPrefixFor(listKey)}${envelope.messageId}`,
      claim,
      settlement.mode,
      String(delayed?.deliverAt ?? 0),
      delayed?.payload ?? '',
      idempotencyKey && settlement.mode === 'suspend' ? String(settlement.dedupTtlMs) : '',
      idempotencyKey ? envelope.messageId : '',
      String(RECLAIM_TTL_MS),
    );
    if (settled !== 1) {
      debug(`Queue: stale claim for ${envelope.messageId}, ${settlement.mode} settle skipped`);
      return false;
    }
    return true;
  }

  /**
   * Fail the run loudly when a message exhausts its delivery attempts, so the
   * run reaches a terminal state instead of silently never completing.
   * Returns false when the write failed and the message must not be dropped.
   */
  async function failRunForExhaustedMessage(
    envelope: MessageEnvelope,
    attempts: number,
    reason: string,
  ): Promise<boolean> {
    const parsed = QueuePayloadSchema.safeParse(
      JSON.parse(JSON.stringify(envelope.message), binaryReviver),
    );
    if (!parsed.success) return true;
    const message = parsed.data;
    const runId =
      'runId' in message
        ? message.runId
        : 'workflowRunId' in message
          ? message.workflowRunId
          : null;
    if (!runId) return true;
    try {
      await events.create(runId, {
        eventType: 'run_failed',
        eventData: {
          error: {
            message: `Queue delivery for "${envelope.queueName}" failed after ${attempts} attempts: ${reason}`,
          },
        },
      });
      return true;
    } catch (err) {
      // An already-terminal or missing run has nothing left to fail.
      if (EntityConflictError.is(err) || WorkflowRunNotFoundError.is(err)) {
        debug(`Queue: run_failed for dropped message ${envelope.messageId} not needed:`, err);
        return true;
      }
      console.error(
        `[world-postgres-redis worker] could not fail run for ${envelope.messageId}, keeping its claim:`,
        err,
      );
      return false;
    }
  }

  /**
   * `envelope.attempt` includes this message's reclaims (claims that expired
   * before settling), so a delivery that keeps outliving its visibility
   * deadline still exhausts its attempts instead of redelivering forever.
   */
  async function executeItem(
    workerRedis: Redis,
    listKey: string,
    item: string,
    claim: string,
    envelope: MessageEnvelope,
    kind: QueueKind,
  ): Promise<void> {
    /** Null keeps the claim, so its expiry redelivers and dead-letters again. */
    const deadLetter = async (reason: string, attempts: number): Promise<Settlement | null> => {
      // Only the owner fails the run. Pushing its deadline out keeps the claim
      // from being redelivered during the DB write.
      const extended = await workerRedis.eval(
        EXTEND_CLAIM_SCRIPT,
        1,
        `${listKey}:inflight`,
        String(Date.now() + visibilityMs),
        claim,
      );
      if (extended !== 1) {
        debug(`Queue: stale claim for exhausted ${envelope.messageId}, not failing run`);
        return { mode: 'release' };
      }
      if (!(await failRunForExhaustedMessage(envelope, attempts, reason))) return null;
      console.error(
        `[world-postgres-redis worker] dropping ${envelope.messageId} after ${attempts} attempts: ${reason}`,
      );
      return { mode: 'release' };
    };
    const retryOrDeadLetter = async (reason: string): Promise<Settlement | null> => {
      if (envelope.attempt >= maxAttempts) return deadLetter(reason, envelope.attempt);
      const next: MessageEnvelope = { ...envelope, attempt: envelope.attempt + 1 };
      return {
        mode: 'retry',
        deliverAt: Date.now() + computeBackoffMs(next.attempt, config),
        payload: JSON.stringify(next),
      };
    };

    if (envelope.attempt > maxAttempts) {
      const reason = 'visibility timeout expired before the delivery settled';
      // The reclaim that pushed this past the budget was never dispatched.
      const settlement = await deadLetter(reason, envelope.attempt - 1);
      if (settlement) await settle(workerRedis, listKey, claim, envelope, settlement);
      return;
    }

    let settlement: Settlement | null;
    try {
      const response = await dispatch(envelope, QUEUE_PATHNAMES[kind]);
      const text = response.ok ? '' : await response.text();
      const timeoutSeconds = response.status === 503 ? parseTimeoutSeconds(text) : null;

      if (response.ok) {
        if (envelope.idempotencyKey) {
          markMessageCompleted(envelope.idempotencyKey);
        }
        settlement = { mode: 'release' };
      } else if (timeoutSeconds !== null) {
        // Durable delayed redelivery: the wake-up survives process restarts,
        // and the enqueue-dedup key outlives the delay.
        const timeoutMs = timeoutSeconds * 1000;
        settlement = {
          mode: 'suspend',
          deliverAt: Date.now() + timeoutMs,
          payload: item,
          dedupTtlMs: timeoutMs + DEDUP_TTL_MS,
        };
      } else {
        settlement = await retryOrDeadLetter(`HTTP ${response.status}: ${text}`);
      }
    } catch (error) {
      console.error(`[world-postgres-redis worker] dispatch error on ${listKey}:`, error);
      settlement = await retryOrDeadLetter(String(error));
    }
    if (settlement) await settle(workerRedis, listKey, claim, envelope, settlement);
  }

  async function processItem(
    workerRedis: Redis,
    listKey: string,
    processingListKey: string,
    rawItem: string,
    kind: QueueKind,
  ): Promise<void> {
    const inflightKey = `${listKey}:inflight`;
    // Pre-fencing promoters push claim-tokened members verbatim.
    const item = stripClaim(rawItem);

    let parsedEnvelope: MessageEnvelope;
    try {
      // Parsed without the binary reviver: tagged Uint8Array values stay
      // tagged so dispatch can round-trip them verbatim.
      const parsed: unknown = JSON.parse(item);
      // `attempt` is checked too: reclaims are added to it below.
      if (
        !parsed ||
        typeof parsed !== 'object' ||
        !('messageId' in parsed) ||
        typeof parsed.messageId !== 'string' ||
        !('attempt' in parsed) ||
        typeof parsed.attempt !== 'number'
      ) {
        throw new Error('envelope is not an object with a messageId and an attempt');
      }
      parsedEnvelope = parsed as MessageEnvelope;
    } catch (error) {
      console.error(`[world-postgres-redis worker] invalid envelope on ${listKey}:`, error);
      await workerRedis.lrem(processingListKey, 1, rawItem);
      return;
    }

    // Atomically move the item from the processing landing zone into the
    // in-flight set under a unique token with a visibility deadline. If this
    // worker dies mid-flight, the promote loop redelivers after the deadline.
    const claim = claimMemberFor(item);
    const reclaims = await workerRedis.eval(
      CLAIM_SCRIPT,
      3,
      processingListKey,
      inflightKey,
      `${reclaimsPrefixFor(listKey)}${parsedEnvelope.messageId}`,
      rawItem,
      String(Date.now() + visibilityMs),
      claim,
    );
    if (typeof reclaims !== 'number') {
      throw new TypeError(`CLAIM_SCRIPT returned ${String(reclaims)}`);
    }
    if (reclaims < 0) {
      debug(`Queue: ${parsedEnvelope.messageId} was requeued before its claim, skipping`);
      return;
    }
    const envelope: MessageEnvelope =
      reclaims > 0
        ? { ...parsedEnvelope, attempt: parsedEnvelope.attempt + reclaims }
        : parsedEnvelope;

    const idempotencyKey = envelope.idempotencyKey;
    if (!idempotencyKey) {
      await executeItem(workerRedis, listKey, item, claim, envelope, kind);
      return;
    }
    if (completedMessages.has(idempotencyKey)) {
      // Release the dedup key: a stalled original's release was fenced off.
      await settle(workerRedis, listKey, claim, envelope, { mode: 'release' });
      return;
    }
    const existing = inflightMessages.get(idempotencyKey);
    if (existing) {
      // Duplicate delivery while the original is still executing. If the
      // original lost its claim, its settle is fenced, so this claim must
      // survive (and later redeliver) to keep the message from being lost.
      if ((await workerRedis.zscore(inflightKey, existing.claim)) !== null) {
        await settle(workerRedis, listKey, claim, envelope, { mode: 'drop' });
      } else {
        // The original is still executing in this process, so this delivery
        // must not dispatch. It holds the claim so the message survives the
        // original's fenced settle, and gives back the reclaim it consumed:
        // an undispatched hold is not a delivery attempt.
        debug(`Queue: original claim for ${idempotencyKey} expired, keeping duplicate claim`);
        if (reclaims > 0) {
          await workerRedis.eval(
            RELEASE_RECLAIM_SCRIPT,
            1,
            `${reclaimsPrefixFor(listKey)}${envelope.messageId}`,
          );
        }
      }
      return;
    }
    const execution = executeItem(workerRedis, listKey, item, claim, envelope, kind).finally(() => {
      inflightMessages.delete(idempotencyKey);
    });
    inflightMessages.set(idempotencyKey, { claim, execution });
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
   * BRPOPLPUSH and the in-flight claim. A live worker whose item is taken
   * finds it gone when claiming and skips it.
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
    const sources = [
      { source: `${listKey}:delayed`, reclaims: '' },
      { source: `${listKey}:inflight`, reclaims: reclaimsPrefixFor(listKey) },
    ];
    for (const { source, reclaims } of sources) {
      let result: unknown;
      try {
        result = await redis.eval(
          MOVE_DUE_SCRIPT,
          2,
          source,
          listKey,
          now,
          CLAIM_PREFIX,
          reclaims,
          String(RECLAIM_TTL_MS),
        );
      } catch (err) {
        if (closed) continue;
        debug(`Queue: promote cycle failed for ${source}:`, err);
        continue;
      }
      // Outside the catch: a shape change is a bug, not a transient failure.
      if (!Array.isArray(result) || typeof result[1] !== 'number') {
        throw new TypeError(`MOVE_DUE_SCRIPT returned ${String(result)}`);
      }
      if (result[1] > 0) {
        console.error(
          `[world-postgres-redis] ${result[1]} expired claim(s) on ${source} carry no readable messageId; their redelivery is unbounded`,
        );
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

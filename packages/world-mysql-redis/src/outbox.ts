import { eq, sql } from 'drizzle-orm';
import type { MySql2Database } from 'drizzle-orm/mysql2';
import * as schema from './schema.js';
import { debug, sleep, withDeadlockRetry } from './util.js';

type Drizzle = MySql2Database<typeof schema>;

const MAX_OUTBOX_ATTEMPTS = 5;
const DEFAULT_RELAY_BATCH_SIZE = 100;
const DEFAULT_POLL_INTERVAL_MS = 500;

export interface OutboxMessage {
  messageId: string;
  payload: unknown;
}

/**
 * Insert an outbox row within an existing transaction context.
 * This should be called inside the same MySQL transaction that writes
 * the event, so the outbox entry is committed atomically with the event.
 */
export async function insertOutboxMessage(tx: Drizzle, message: OutboxMessage): Promise<void> {
  await tx.insert(schema.outbox).values({
    messageId: message.messageId,
    payload: message.payload,
  });
}

/**
 * Relay pending outbox messages to the Redis queue.
 *
 * Uses `FOR UPDATE SKIP LOCKED` so that concurrent relay workers
 * do not double-deliver the same rows.
 *
 * Returns the number of messages successfully relayed.
 */
export async function relayOutbox(
  db: Drizzle,
  redisQueuePush: (payload: unknown, messageId: string) => Promise<void>,
  batchSize = DEFAULT_RELAY_BATCH_SIZE,
): Promise<number> {
  let relayedCount = 0;

  await withDeadlockRetry(async () => {
    await db.transaction(async (tx) => {
      // Fetch pending outbox rows, locking them for this relay worker
      const rows = await tx.execute(sql`
        SELECT id, message_id, payload, attempts
        FROM ${schema.outbox}
        WHERE ${schema.outbox.attempts} < ${MAX_OUTBOX_ATTEMPTS}
        ORDER BY ${schema.outbox.createdAt} ASC
        LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED
      `);

      const pending = (rows as any)[0] as Array<{
        id: number;
        message_id: string;
        payload: unknown;
        attempts: number;
      }>;

      if (!pending || pending.length === 0) return;

      for (const row of pending) {
        try {
          const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
          await redisQueuePush(payload, row.message_id);

          // Successfully relayed -- delete the outbox row
          await tx.delete(schema.outbox).where(eq(schema.outbox.id, row.id));
          relayedCount++;
        } catch (err) {
          debug('outbox relay failed', { messageId: row.message_id, error: String(err) });

          // Record the failure and increment attempt count
          await tx
            .update(schema.outbox)
            .set({
              attempts: sql`${schema.outbox.attempts} + 1`,
              lastError: String(err),
            })
            .where(eq(schema.outbox.id, row.id));
        }
      }
    });
  });

  return relayedCount;
}

/**
 * Get the count of pending outbox messages and the age of the oldest one.
 * Useful for health checks and monitoring.
 */
export async function getOutboxStats(db: Drizzle): Promise<{
  pending: number;
  oldestPendingAgeMs: number | null;
}> {
  const result = await db.execute(sql`
    SELECT
      COUNT(*) AS pending,
      TIMESTAMPDIFF(MICROSECOND, MIN(${schema.outbox.createdAt}), NOW(6)) / 1000 AS oldest_age_ms
    FROM ${schema.outbox}
    WHERE ${schema.outbox.attempts} < ${MAX_OUTBOX_ATTEMPTS}
  `);

  const row = (result as any)[0]?.[0] as
    | { pending: number | string; oldest_age_ms: number | null }
    | undefined;

  return {
    pending: Number(row?.pending ?? 0),
    oldestPendingAgeMs: row?.oldest_age_ms != null ? Number(row.oldest_age_ms) : null,
  };
}

/**
 * Start a background relay loop that continuously drains the outbox.
 * Returns an abort controller that stops the loop when signalled.
 */
export function startOutboxRelay(
  db: Drizzle,
  redisQueuePush: (payload: unknown, messageId: string) => Promise<void>,
  opts?: { pollIntervalMs?: number; batchSize?: number },
): AbortController {
  const controller = new AbortController();
  const pollInterval = opts?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const batchSize = opts?.batchSize ?? DEFAULT_RELAY_BATCH_SIZE;

  const run = async () => {
    while (!controller.signal.aborted) {
      try {
        const count = await relayOutbox(db, redisQueuePush, batchSize);
        if (count === 0) {
          await sleep(pollInterval);
        }
        // If we relayed messages, immediately loop to check for more
      } catch (err) {
        debug('outbox relay loop error', String(err));
        await sleep(pollInterval * 2);
      }
    }
  };

  run().catch((err) => {
    debug('outbox relay loop crashed', String(err));
  });

  return controller;
}

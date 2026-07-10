import { and, asc, eq, lt, sql } from 'drizzle-orm';
import type { Drizzle } from './drizzle/index.js';
import { Schema } from './drizzle/index.js';
import { debug } from './util.js';

const MAX_ATTEMPTS = 5;
const RELAY_INTERVAL_MS = 1_000;
const BATCH_SIZE = 100;
/**
 * Rows younger than this are left to the enqueuer's optimistic push. Without
 * the grace period the relay can push a row in the window between the
 * caller's INSERT and its own push/DELETE, double-delivering the message.
 */
const RELAY_GRACE_MS = 5_000;

export interface OutboxEntry {
  id: string;
  messageId: string;
  payload: unknown;
  attempts: number;
}

export interface OutboxRelay {
  /** Start the relay worker loop. Returns a cleanup function. */
  start(): () => void;
  /** Run a single relay cycle (useful for testing). */
  relayCycle(): Promise<number>;
  /** Get the number of pending outbox entries. */
  getPendingCount(): Promise<number>;
  /** Get the age (in ms) of the oldest pending entry, or null if empty. */
  getOldestPendingAgeMs(): Promise<number | null>;
}

/**
 * Creates an outbox relay that polls for pending outbox entries and pushes them
 * to a destination (e.g., Redis queue). Entries are deleted on success or
 * abandoned after MAX_ATTEMPTS failures.
 *
 * @param drizzle - The Drizzle ORM instance
 * @param pushFn - Async function that pushes a payload to the destination queue.
 *                 Should throw on failure.
 */
export function createOutboxRelay(
  drizzle: Drizzle,
  pushFn: (entry: OutboxEntry) => Promise<void>,
): OutboxRelay {
  const { outbox } = Schema;
  let timer: ReturnType<typeof setInterval> | null = null;

  async function relayCycle(): Promise<number> {
    const rows = await drizzle
      .select()
      .from(outbox)
      .where(
        and(
          lt(outbox.attempts, MAX_ATTEMPTS),
          lt(outbox.createdAt, new Date(Date.now() - RELAY_GRACE_MS)),
        ),
      )
      .orderBy(asc(outbox.createdAt))
      .limit(BATCH_SIZE);

    let relayed = 0;

    for (const row of rows) {
      try {
        await pushFn({
          id: row.id,
          messageId: row.messageId,
          payload: row.payload,
          attempts: row.attempts,
        });
        // Success: delete from outbox
        await drizzle.delete(outbox).where(eq(outbox.id, row.id));
        relayed++;
        debug(`Outbox relay: delivered message ${row.messageId}`);
      } catch (err) {
        // Failure: increment attempts and record error
        const errorMessage = err instanceof Error ? err.message : String(err);
        await drizzle
          .update(outbox)
          .set({
            attempts: sql`${outbox.attempts} + 1`,
            lastError: errorMessage,
          })
          .where(eq(outbox.id, row.id));
        debug(
          `Outbox relay: failed to deliver ${row.messageId} (attempt ${row.attempts + 1}): ${errorMessage}`,
        );
      }
    }

    return relayed;
  }

  // Counts intentionally include rows past MAX_ATTEMPTS: abandoned rows are
  // undelivered messages and must stay visible to the health check rather
  // than silently disappearing.
  async function getPendingCount(): Promise<number> {
    const [result] = await drizzle.select({ count: sql<number>`count(*)::int` }).from(outbox);
    return result?.count ?? 0;
  }

  async function getOldestPendingAgeMs(): Promise<number | null> {
    const [result] = await drizzle
      .select({ createdAt: outbox.createdAt })
      .from(outbox)
      .orderBy(asc(outbox.createdAt))
      .limit(1);
    if (!result) return null;
    return Date.now() - result.createdAt.getTime();
  }

  function start(): () => void {
    timer = setInterval(() => {
      relayCycle().catch((err) => {
        debug('Outbox relay cycle error:', err);
      });
    }, RELAY_INTERVAL_MS);

    // Run immediately on start
    relayCycle().catch((err) => {
      debug('Outbox relay initial cycle error:', err);
    });

    return () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    };
  }

  return {
    start,
    relayCycle,
    getPendingCount,
    getOldestPendingAgeMs,
  };
}

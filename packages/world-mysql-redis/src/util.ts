import { createDebugLogger } from '@fantasticfour/shared';

export { compact, Mutex } from '@fantasticfour/shared';
export const debug = createDebugLogger('mysql-redis-world');

const MAX_DEADLOCK_RETRIES = 3;
const BASE_RETRY_DELAY_MS = 50;

/**
 * Check if an error is a MySQL InnoDB deadlock (ER_LOCK_DEADLOCK / SQLSTATE 40001).
 */
export function isDeadlockError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as Error & { code?: string }).code;
  return code === 'ER_LOCK_DEADLOCK';
}

/**
 * Retry an operation if it fails with a MySQL deadlock error.
 * Uses exponential backoff (50ms, 100ms, 200ms, ...).
 * Non-deadlock errors propagate immediately.
 */
export async function withDeadlockRetry<T>(
  operation: () => Promise<T>,
  maxRetries = MAX_DEADLOCK_RETRIES,
): Promise<T> {
  let lastErr: unknown;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await operation();
    } catch (err) {
      lastErr = err;
      if (!isDeadlockError(err)) throw err;

      const delay = BASE_RETRY_DELAY_MS * 2 ** attempt;
      debug('deadlock retry', { attempt, delay });
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastErr;
}

/**
 * Async sleep utility.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

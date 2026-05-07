import { createDebugLogger } from '@fantasticfour/shared';

export { compact } from '@fantasticfour/shared';
export const debug = createDebugLogger('azure-world');

/**
 * Default maximum retries for Cosmos DB throttled (429) requests.
 */
const DEFAULT_MAX_RETRIES = 5;

/**
 * Check if an error is a Cosmos DB throttle (HTTP 429 Too Many Requests) error.
 * Cosmos DB returns 429 when provisioned RU/s are exhausted.
 */
function isThrottleError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as Record<string, unknown>).code;
  const statusCode = (err as Record<string, unknown>).statusCode;
  return code === 429 || statusCode === 429;
}

/**
 * Wrap a Cosmos DB operation with retry logic for 429 (Too Many Requests) responses.
 *
 * When Cosmos DB provisioned RU/s are exhausted, it returns HTTP 429 with
 * an `x-ms-retry-after-ms` header indicating how long to wait before retrying.
 * This helper respects that header, falling back to exponential backoff.
 *
 * @param operation - The async Cosmos DB operation to execute
 * @param maxRetries - Maximum number of retry attempts (default: 5)
 * @returns The result of the operation
 * @throws The original error if retries are exhausted or the error is not a 429
 *
 * @see https://learn.microsoft.com/en-us/azure/cosmos-db/nosql/conceptual-resilient-sdk-applications
 */
export async function withCosmosRetry<T>(
  operation: () => Promise<T>,
  maxRetries = DEFAULT_MAX_RETRIES,
): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (err) {
      if (!isThrottleError(err) || attempt === maxRetries) {
        throw err;
      }

      // Respect the x-ms-retry-after-ms header from Cosmos DB, fall back to exponential backoff
      const headers = (err as Record<string, unknown>).headers as
        | Record<string, string>
        | undefined;
      const retryAfterMs = Number(headers?.['x-ms-retry-after-ms']) || 100 * 2 ** attempt;

      debug('cosmos throttled (429), retrying', {
        attempt: attempt + 1,
        maxRetries,
        retryAfterMs,
      });

      await new Promise<void>((resolve) => setTimeout(resolve, retryAfterMs));
    }
  }

  // Unreachable -- the loop either returns or throws
  throw new Error('withCosmosRetry: unreachable');
}

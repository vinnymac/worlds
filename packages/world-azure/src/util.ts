import type { OperationResponse } from '@azure/cosmos';
import { createDebugLogger } from '@fantasticfour/shared';

export { compact } from '@fantasticfour/shared';
export const debug = createDebugLogger('azure-world');

/**
 * Default maximum retries for Cosmos DB throttled (429) requests.
 */
const DEFAULT_MAX_RETRIES = 5;

/**
 * `Items.batch()` in @azure/cosmos catches every failure and rethrows
 * `new Error("Batch request error: <server message>")` — a plain Error with
 * no `.code`/`.statusCode`. Detect that wrapper so callers can translate
 * batch failures (conflict re-reads, throttle retries, etag races).
 */
const BATCH_ERROR_PREFIX = 'Batch request error:';

export function isWrappedBatchError(err: unknown): err is Error {
  return err instanceof Error && err.message.startsWith(BATCH_ERROR_PREFIX);
}

/**
 * Per-operation status meaning "rolled back because a sibling operation in the
 * same transactional batch failed" — never the root cause.
 */
const HTTP_FAILED_DEPENDENCY = 424;

/**
 * A transactional-batch operation that the server rejected.
 *
 * Shaped so both classifiers keep working: the `Batch request error:` prefix
 * satisfies {@link isWrappedBatchError}, and `code` carries the real status
 * that `Items.batch()` would otherwise discard.
 */
export class BatchOperationError extends Error {
  readonly code: number;

  constructor(index: number, code: number) {
    super(`${BATCH_ERROR_PREFIX} operation ${index} failed with status ${code}`);
    this.name = 'BatchOperationError';
    this.code = code;
  }
}

/**
 * Surface a rejected transactional batch as an error.
 *
 * `Items.batch()` only wraps *transport* failures — a rejected operation comes
 * back as a resolved response (HTTP 207) carrying the failing status on
 * `result[i].statusCode`, with siblings marked 424. Nothing is committed in
 * that case, so a caller that ignores the response silently drops the write.
 */
export function assertBatchCommitted(response: { result?: OperationResponse[] }): void {
  const results = response.result;
  if (!results) return;
  for (const [index, result] of results.entries()) {
    const status = result.statusCode;
    if (status < 400 || status === HTTP_FAILED_DEPENDENCY) continue;
    throw new BatchOperationError(index, status);
  }
}

function hasStatus(err: unknown, status: number): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as Record<string, unknown>).code;
  const statusCode = (err as Record<string, unknown>).statusCode;
  return code === status || statusCode === status;
}

/** HTTP 409 Conflict (duplicate id) from a non-batch Cosmos DB operation. */
export function isConflictError(err: unknown): boolean {
  return hasStatus(err, 409);
}

/** HTTP 404 Not Found from a non-batch Cosmos DB operation. */
export function isNotFoundError(err: unknown): boolean {
  return hasStatus(err, 404);
}

/** HTTP 412 Precondition Failed (etag mismatch) from a Cosmos DB operation. */
export function isPreconditionFailedError(err: unknown): boolean {
  return hasStatus(err, 412);
}

/**
 * Check if an error is a Cosmos DB throttle (HTTP 429 Too Many Requests) error.
 * Cosmos DB returns 429 when provisioned RU/s are exhausted. Transactional
 * batch failures lose the status code (see isWrappedBatchError), so fall back
 * to matching the server's throttle message on wrapped errors.
 */
function isThrottleError(err: unknown): boolean {
  if (hasStatus(err, 429)) return true;
  return isWrappedBatchError(err) && /TooManyRequests|Request rate is large/i.test(err.message);
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

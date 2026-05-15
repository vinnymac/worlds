import type { RedisOptions } from 'ioredis';

export interface RedisWorldConfig {
  /**
   * Redis connection URL or connection options
   * Examples:
   * - 'redis://localhost:6379'
   * - 'rediss://username:password@host:6380/0'
   * - { host: 'localhost', port: 6379 }
   */
  redis: string | RedisOptions;

  /**
   * Optional prefix for job queue names
   * Default: 'workflow_'
   */
  jobPrefix?: string;

  /**
   * Number of concurrent workers processing jobs
   * Default: 10
   */
  queueConcurrency?: number;

  /**
   * Optional key prefix for all Redis keys
   * Useful for multi-tenancy or namespace isolation
   * Default: 'workflow:'
   */
  keyPrefix?: string;

  /**
   * Maximum retry attempts before marking a job as permanently failed.
   * Default: 5
   */
  maxAttempts?: number;

  /**
   * Backoff strategy for retries: 'fixed' replays at the same interval,
   * 'exponential' doubles the delay on each attempt.
   * Default: 'exponential'
   */
  backoffType?: 'fixed' | 'exponential';

  /**
   * Base delay for backoff (ms). For exponential backoff this is multiplied
   * by 2^(attempt - 1).
   * Default: 1000
   */
  backoffDelayMs?: number;

  /**
   * How often workers check for stalled jobs (ms). A job is considered stalled
   * when a worker has not sent a heartbeat within this interval.
   * Default: 30000 (30s)
   */
  stalledInterval?: number;

  /**
   * Number of consecutive stall checks with no heartbeat before a job is
   * marked as failed. Total stall tolerance = stalledInterval * maxStalledCount.
   * Default: 1
   */
  maxStalledCount?: number;

  /**
   * Base URL the BullMQ worker uses to dispatch jobs back to the user's HTTP
   * server, which must mount `world.createQueueHandler(...)` at
   * `/.well-known/workflow/v1/flow` and `/.well-known/workflow/v1/step`.
   * Default: process.env.WORKFLOW_BASE_URL || `http://localhost:${process.env.PORT ?? 3000}`
   */
  baseUrl?: string;

  /**
   * Per-job HTTP request timeout (ms). Long-running workflow steps may need a
   * higher value.
   * Default: 300_000 (5 minutes)
   */
  httpTimeoutMs?: number;

  /**
   * Idempotency deduplication window (ms) for BullMQ native deduplication.
   * When `idempotencyKey` is supplied to `queue()`, a duplicate enqueue within
   * this window is dropped.
   * Default: 60_000 (1 minute)
   */
  idempotencyTtlMs?: number;
}

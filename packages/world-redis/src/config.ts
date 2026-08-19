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
   * Base URL the worker uses to dispatch jobs back to the user's HTTP server,
   * which must mount `world.createQueueHandler(...)` at
   * `/.well-known/workflow/v1/flow` and `/.well-known/workflow/v1/step`.
   * Default: process.env.WORKFLOW_BASE_URL || `http://localhost:${process.env.PORT ?? 3000}`
   */
  baseUrl?: string;

  /**
   * Per-job HTTP request timeout (ms).
   * Default: 300_000 (5 minutes)
   */
  httpTimeoutMs?: number;

  /**
   * Maximum retry attempts before dropping a job. Each hard failure
   * (non-2xx, non-503) increments the attempt counter and re-LPUSHes with
   * backoff. 503 + { timeoutSeconds } is a "soft" retry and does not consume
   * an attempt.
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

  /** Maximum events a run may accumulate, reported as `EventResult.maxEvents`.
   * Default: `WORKFLOW_MAX_EVENTS` || 25_000 */
  maxEventsPerRun?: number;
}

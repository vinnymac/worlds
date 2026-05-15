import type { RedisOptions } from 'ioredis';

export interface MysqlRedisWorldConfig {
  databaseUrl: string;
  redis: string | RedisOptions;
  jobPrefix?: string;
  queueConcurrency?: number;
  deploymentId?: string;
  /** Outbox relay polling interval in milliseconds. Default: 500 */
  outboxPollIntervalMs?: number;
  /** Number of outbox rows to process per relay batch. Default: 100 */
  outboxBatchSize?: number;
  /**
   * Base URL the worker uses to dispatch jobs back to the user's HTTP server.
   * Default: process.env.WORKFLOW_BASE_URL || `http://localhost:${process.env.PORT ?? 3000}`
   */
  baseUrl?: string;
  /** Per-job HTTP request timeout (ms). Default: 300_000 */
  httpTimeoutMs?: number;
  /** Maximum retry attempts before dropping a job. Default: 5 */
  maxAttempts?: number;
  /** Base backoff delay (ms). Default: 1000 */
  backoffDelayMs?: number;
  /** Backoff strategy. Default: 'exponential' */
  backoffType?: 'fixed' | 'exponential';
}

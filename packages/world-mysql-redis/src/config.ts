import type { RedisOptions } from 'ioredis';

export interface MysqlRedisWorldConfig {
  databaseUrl: string;
  redis: string | RedisOptions;
  jobPrefix?: string;
  queueConcurrency?: number;
  deploymentId?: string;
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
  /** Per-run event ceiling reported on `run_started` (`EventResult.maxEvents`);
   * the runtime fails a runaway run with `MAX_EVENTS_EXCEEDED`.
   * Default: `WORKFLOW_MAX_EVENTS`, else 25000. */
  maxEventsPerRun?: number;

  /**
   * Batch commands issued in the same event-loop tick into one write. A win
   * once several runs are in flight and a marginal loss for a single serial
   * caller. Blocking worker connections opt out regardless.
   * Default: true
   */
  enableAutoPipelining?: boolean;
}

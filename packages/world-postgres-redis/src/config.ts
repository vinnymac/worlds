import type { RedisOptions } from 'ioredis';

export interface PostgresWorldConfig {
  connectionString: string;
  redis: string | RedisOptions;
  jobPrefix?: string;
  queueConcurrency?: number;
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
  /**
   * Per-run event ceiling reported to the runtime on `run_started`
   * (`EventResult.maxEvents`). The runtime fails a runaway run with
   * `MAX_EVENTS_EXCEEDED` once its replay log reaches this many events.
   * Default: `WORKFLOW_MAX_EVENTS`, else 25000.
   */
  maxEventsPerRun?: number;
}

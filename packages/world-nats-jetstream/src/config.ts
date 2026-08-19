import type { ConnectionOptions } from 'nats';

export interface NatsJetStreamWorldConfig {
  /**
   * NATS connection URL or connection options
   * Examples:
   * - 'nats://localhost:4222'
   * - 'nats://user:pass@localhost:4222'
   * - { servers: ['nats://localhost:4222', 'nats://localhost:4223'] }
   */
  nats: string | ConnectionOptions;

  /**
   * Optional prefix for job queue streams
   * Default: 'workflow_'
   */
  jobPrefix?: string;

  /**
   * Number of concurrent workers processing jobs
   * Default: 10
   */
  queueConcurrency?: number;

  /**
   * Optional key prefix for all KV buckets and streams
   * Useful for multi-tenancy or namespace isolation
   * Default: 'workflow_'
   */
  keyPrefix?: string;

  /**
   * Window (in milliseconds) during which duplicate messages (matched by
   * Nats-Msg-Id header) are silently dropped. Should be larger than the
   * longest expected job duration.
   * Default: 15 minutes (900_000)
   */
  dedupWindowMs?: number;

  /**
   * Time-to-live (in milliseconds) for completed/failed/cancelled runs.
   * After this period the run and its associated steps, hooks, and events
   * become eligible for compaction. Set to 0 to retain indefinitely.
   * Default: 30 days (2_592_000_000)
   */
  terminalRunTTLMs?: number;

  /**
   * Base URL the worker uses to dispatch jobs back to the user's HTTP server.
   * Default: process.env.WORKFLOW_BASE_URL || `http://localhost:${process.env.PORT ?? 3000}`
   */
  baseUrl?: string;

  /** Per-job HTTP request timeout (ms). Default: 300_000 */
  httpTimeoutMs?: number;

  /** Ceiling on events a run may accumulate, reported as
   * `EventResult.maxEvents`. Must be a positive integer.
   * Default: `WORKFLOW_MAX_EVENTS`, else 25_000 */
  maxEventsPerRun?: number;
}

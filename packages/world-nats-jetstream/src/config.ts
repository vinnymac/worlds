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
}

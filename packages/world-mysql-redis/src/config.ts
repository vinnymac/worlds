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
}

import type { RedisOptions } from 'ioredis';

export interface MysqlRedisWorldConfig {
  databaseUrl: string;
  redis: string | RedisOptions;
  jobPrefix?: string;
  queueConcurrency?: number;
  deploymentId?: string;
}

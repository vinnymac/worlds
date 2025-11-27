import type { RedisOptions } from 'ioredis';

export interface PostgresWorldConfig {
  connectionString: string;
  redis: string | RedisOptions;
  jobPrefix?: string;
  queueConcurrency?: number;
}

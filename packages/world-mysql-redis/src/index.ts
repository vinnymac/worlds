import type { World } from '@workflow/world';
import { drizzle } from 'drizzle-orm/mysql2';
import { Redis } from 'ioredis';
import mysql from 'mysql2/promise';
import type { MysqlRedisWorldConfig } from './config.js';
import { createQueue } from './queue.js';
import * as schema from './schema.js';
import { createStorage } from './storage.js';
import { createStreamer } from './streamer.js';

export function createWorld(
  config: MysqlRedisWorldConfig = {
    databaseUrl:
      process.env.WORKFLOW_MYSQL_URL ||
      process.env.DATABASE_URL ||
      'mysql://root:root@localhost:3306/world',
    redis: process.env.WORKFLOW_REDIS_URL || process.env.REDIS_URL || 'redis://localhost:6379',
    jobPrefix: process.env.WORKFLOW_MYSQL_JOB_PREFIX,
    queueConcurrency:
      Number.parseInt(process.env.WORKFLOW_MYSQL_WORKER_CONCURRENCY || '10', 10) || 10,
  },
): World & { start(): Promise<void> } {
  // Create Redis client for queue
  const redis =
    typeof config.redis === 'string' ? new Redis(config.redis) : new Redis(config.redis);

  // Create MySQL connection pool
  const pool = mysql.createPool(config.databaseUrl);
  const db = drizzle(pool, { schema, mode: 'default' });

  const queue = createQueue(redis, config);
  const storage = createStorage(db as any);
  const streamer = createStreamer(db as any);

  return {
    ...storage,
    ...streamer,
    ...queue,
    async start() {
      await queue.start();
    },
  };
}

// Re-export schema for users who want to extend or inspect the database schema
export type { MysqlRedisWorldConfig } from './config.js';
export * from './schema.js';

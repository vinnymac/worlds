import type { HealthCheckable } from '@fantasticfour/shared';
import { SPEC_VERSION_CURRENT, type World } from '@workflow/world';
import { drizzle } from 'drizzle-orm/mysql2';
import { Redis } from 'ioredis';
import mysql from 'mysql2/promise';
import type { MysqlRedisWorldConfig } from './config.js';
import { getHealth, type MysqlRedisHealthResult } from './health.js';
import { createQueue } from './queue.js';
import * as schema from './schema.js';
import { createStorage } from './storage.js';
import { createStreamer } from './streamer.js';

export type MysqlRedisWorld = World &
  HealthCheckable & {
    start(): Promise<void>;
    stop(): void;
  };

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
): MysqlRedisWorld {
  // Create Redis client for queue
  const redis =
    typeof config.redis === 'string' ? new Redis(config.redis) : new Redis(config.redis);

  // Create MySQL connection pool
  const pool = mysql.createPool(config.databaseUrl);
  const db = drizzle(pool, { schema, mode: 'default' });

  const queue = createQueue(redis, config);
  const storage = createStorage(db);
  const streamer = createStreamer(db);

  return {
    // Declare the highest spec version this world supports. With spec
    // version 3+, `start()` includes the run input in the queue message
    // (binary-safe queue transport), which enables the resilient-start
    // path in `events.create('run_started')`. That path is required for
    // correctness: the runtime creates `run_created` and enqueues the
    // workflow message in parallel, so `run_started` can win the race.
    specVersion: SPEC_VERSION_CURRENT,
    ...storage,
    ...streamer,
    ...queue,
    async health(): Promise<MysqlRedisHealthResult> {
      return getHealth(db, redis);
    },
    async start() {
      await queue.start();
    },
    stop() {
      queue.stop();
    },
  };
}

// Re-export schema for users who want to extend or inspect the database schema
export type { MysqlRedisWorldConfig } from './config.js';
export type { MysqlRedisHealthResult } from './health.js';
export { getHealth } from './health.js';
export { withDeadlockRetry, isDeadlockError } from './util.js';
export * from './schema.js';

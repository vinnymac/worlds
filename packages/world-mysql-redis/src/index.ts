import type { HealthCheckable } from '@fantasticfour/shared';
import type { World } from '@workflow/world';
import { drizzle } from 'drizzle-orm/mysql2';
import { Redis } from 'ioredis';
import mysql from 'mysql2/promise';
import type { MysqlRedisWorldConfig } from './config.js';
import { getHealth, type MysqlRedisHealthResult } from './health.js';
import { startOutboxRelay } from './outbox.js';
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
  const storage = createStorage(db as any);
  const streamer = createStreamer(db as any);

  let outboxAbort: AbortController | undefined;

  return {
    ...storage,
    ...streamer,
    ...queue,
    async health(): Promise<MysqlRedisHealthResult> {
      return getHealth(db as any, redis);
    },
    async start() {
      await queue.start();

      // Start the outbox relay loop to drain pending outbox messages to Redis
      outboxAbort = startOutboxRelay(
        db as any,
        async (payload, messageId) => {
          // Relay outbox messages through the queue's push mechanism
          const queueName = (payload as any)?.queueName;
          const message = (payload as any)?.message;
          if (queueName && message) {
            await queue.queue(queueName, message, { idempotencyKey: messageId });
          }
        },
        {
          pollIntervalMs: config.outboxPollIntervalMs,
          batchSize: config.outboxBatchSize,
        },
      );
    },
    stop() {
      outboxAbort?.abort();
    },
  };
}

// Re-export schema for users who want to extend or inspect the database schema
export type { MysqlRedisWorldConfig } from './config.js';
export type { MysqlRedisHealthResult } from './health.js';
export { getHealth } from './health.js';
export { withDeadlockRetry, isDeadlockError } from './util.js';
export { insertOutboxMessage, relayOutbox, getOutboxStats, startOutboxRelay } from './outbox.js';
export * from './schema.js';

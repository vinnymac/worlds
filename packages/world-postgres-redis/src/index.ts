import type { Storage, World } from '@workflow/world';
import { Redis } from 'ioredis';
import createPostgres from 'postgres';
import type { PostgresWorldConfig } from './config.js';
import { createClient, type Drizzle } from './drizzle/index.js';
import { createQueue } from './queue.js';
import {
  createEventsStorage,
  createHooksStorage,
  createRunsStorage,
  createStepsStorage,
} from './storage.js';
import { createStreamer } from './streamer.js';

function createStorage(drizzle: Drizzle): Storage {
  return {
    runs: createRunsStorage(drizzle),
    events: createEventsStorage(drizzle),
    hooks: createHooksStorage(drizzle),
    steps: createStepsStorage(drizzle),
  };
}

export function createWorld(
  config: PostgresWorldConfig = {
    connectionString:
      process.env.WORKFLOW_POSTGRES_URL ||
      'postgres://world:world@localhost:5432/world',
    redis:
      process.env.WORKFLOW_REDIS_URL ||
      process.env.REDIS_URL ||
      'redis://localhost:6379',
    jobPrefix: process.env.WORKFLOW_POSTGRES_JOB_PREFIX,
    queueConcurrency:
      Number.parseInt(
        process.env.WORKFLOW_POSTGRES_WORKER_CONCURRENCY || '10',
        10
      ) || 10,
  }
): World & { start(): Promise<void> } {
  // Create Redis client for queue
  const redis =
    typeof config.redis === 'string'
      ? new Redis(config.redis)
      : new Redis(config.redis);

  const postgres = createPostgres(config.connectionString);
  const drizzle = createClient(postgres);
  const queue = createQueue(redis, config);
  const storage = createStorage(drizzle);
  const streamer = createStreamer(postgres, drizzle);

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
export type { PostgresWorldConfig } from './config.js';
export * from './drizzle/schema.js';

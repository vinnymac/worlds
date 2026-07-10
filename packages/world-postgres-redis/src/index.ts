import type { Storage, World } from '@workflow/world';
import { reenqueueActiveRuns, SPEC_VERSION_CURRENT } from '@workflow/world';
import { Redis } from 'ioredis';
import createPostgres from 'postgres';
import type { PostgresWorldConfig } from './config.js';
import { createClient, type Drizzle } from './drizzle/index.js';
import { createHealthCheck, type PostgresRedisHealthResult } from './health.js';
import { createRunUpdateSubscriber, type RunUpdateListener } from './notify.js';
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
      process.env.WORKFLOW_POSTGRES_URL || 'postgres://world:world@localhost:5432/world',
    redis: process.env.WORKFLOW_REDIS_URL || process.env.REDIS_URL || 'redis://localhost:6379',
    jobPrefix: process.env.WORKFLOW_POSTGRES_JOB_PREFIX,
    queueConcurrency:
      Number.parseInt(process.env.WORKFLOW_POSTGRES_WORKER_CONCURRENCY || '10', 10) || 10,
  },
): World & {
  start(): Promise<void>;
  close(): Promise<void>;
  getHealth(): Promise<PostgresRedisHealthResult>;
  subscribeToRunUpdates(listener: RunUpdateListener): () => void;
} {
  // Create Redis client for queue
  const redis =
    typeof config.redis === 'string' ? new Redis(config.redis) : new Redis(config.redis);

  const postgres = createPostgres(config.connectionString);
  const drizzle = createClient(postgres);
  const queue = createQueue(redis, drizzle, config);
  const storage = createStorage(drizzle);
  const streamer = createStreamer(postgres, drizzle);

  // Health check (Enhancement 3)
  const getHealth = createHealthCheck(drizzle, redis, queue.outboxRelay);

  // LISTEN/NOTIFY subscription for real-time run updates (Enhancement 2)
  const runUpdateSubscriber = createRunUpdateSubscriber(postgres);

  return {
    // Declares support for the current spec (CBOR queue transport +
    // resilient-start runInput bootstrap). Without this, core creates runs at
    // the baseline spec and never sends runInput through the queue, so a
    // transiently failed run_created can never be recovered.
    specVersion: SPEC_VERSION_CURRENT,
    ...storage,
    ...streamer,
    ...queue,
    getHealth,
    subscribeToRunUpdates: (listener: RunUpdateListener) => runUpdateSubscriber.subscribe(listener),
    async start() {
      await queue.start();
      await reenqueueActiveRuns(storage.runs, queue.queue, 'world-postgres-redis');
    },
    async close() {
      await queue.close();
      await postgres.end({ timeout: 5 });
      await redis.quit().catch(() => {
        redis.disconnect();
      });
    },
  };
}

// Re-export schema for users who want to extend or inspect the database schema
export type { PostgresWorldConfig } from './config.js';
export type { PostgresRedisHealthResult } from './health.js';
export type { RunUpdateListener, RunUpdateNotification } from './notify.js';
export * from './drizzle/schema.js';

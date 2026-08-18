import type { Storage, World } from '@workflow/world';
import { SPEC_VERSION_CURRENT } from '@workflow/world';
import { Redis } from 'ioredis';
import type { RedisWorldConfig } from './config.js';
import { createQueue, type QueueStats } from './queue.js';
import {
  createEventsStorage,
  createHooksStorage,
  createRunsStorage,
  createStepsStorage,
} from './storage.js';
import { createStreamer, type StreamStats } from './streamer.js';

function createStorage(redis: Redis, keyPrefix: string, maxEventsPerRun?: number): Storage {
  const config = { redis, keyPrefix, maxEventsPerRun };
  return {
    runs: createRunsStorage(config),
    events: createEventsStorage(config),
    hooks: createHooksStorage(config),
    steps: createStepsStorage(config),
  };
}

export interface RedisWorld extends World {
  /** Start background queue workers */
  start(): Promise<void>;
  /** Stop background workers and release all Redis connections */
  close(): Promise<void>;
  /** Get queue depth and health metrics for observability */
  getQueueStats(): Promise<QueueStats>;
  /** Get stream health metrics for a specific stream */
  getStreamStats(name: string): Promise<StreamStats>;
}

export function createWorld(
  config: RedisWorldConfig = {
    redis: process.env.WORKFLOW_REDIS_URL || process.env.REDIS_URL || 'redis://localhost:6379',
    jobPrefix: process.env.WORKFLOW_REDIS_JOB_PREFIX,
    queueConcurrency:
      Number.parseInt(process.env.WORKFLOW_REDIS_WORKER_CONCURRENCY || '10', 10) || 10,
    keyPrefix: process.env.WORKFLOW_REDIS_KEY_PREFIX || 'workflow:',
  },
): RedisWorld {
  const redis =
    typeof config.redis === 'string' ? new Redis(config.redis) : new Redis(config.redis);

  const keyPrefix = config.keyPrefix || 'workflow:';

  const storage = createStorage(redis, keyPrefix, config.maxEventsPerRun);
  const streamer = createStreamer({ redis, keyPrefix });

  const queue = createQueue(redis, config);

  return {
    ...storage,
    ...streamer,
    ...queue,
    // Declaring the current spec version enables resilient start: core
    // includes runInput on the first queue delivery, and run_started
    // bootstraps the run when it wins the race against run_created. The
    // queue transport is binary-safe (Uint8Array round-trips), which this
    // spec version requires.
    specVersion: SPEC_VERSION_CURRENT,
    async start() {
      await queue.start();
    },
    async close() {
      await queue.stop();
      await streamer.closeStreamer();
      try {
        await redis.quit();
      } catch {
        redis.disconnect();
      }
    },
  };
}

// Re-export config and stats types for users
export type { RedisWorldConfig } from './config.js';
export type { QueueStats } from './queue.js';
export type { StreamStats } from './streamer.js';

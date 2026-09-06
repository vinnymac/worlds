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
import { createStreamer } from './streamer.js';

function createStorage(redis: Redis, keyPrefix: string, maxEventsPerRun?: number): Storage {
  const config = { redis, keyPrefix, maxEventsPerRun };
  return {
    runs: createRunsStorage(config),
    events: createEventsStorage(config),
    hooks: createHooksStorage(config),
    steps: createStepsStorage(config),
  };
}

export interface RedisBullmqWorld extends World {
  /** Start the background BullMQ worker */
  start(): Promise<void>;
  /** Stop the worker and release all Redis connections */
  close(): Promise<void>;
  /** Get queue depth and health metrics for observability */
  getQueueStats(): Promise<QueueStats>;
}

export function createWorld(
  config: RedisWorldConfig = {
    redis: process.env.WORKFLOW_REDIS_URL || process.env.REDIS_URL || 'redis://localhost:6379',
    jobPrefix: process.env.WORKFLOW_REDIS_JOB_PREFIX,
    queueConcurrency:
      Number.parseInt(process.env.WORKFLOW_REDIS_WORKER_CONCURRENCY || '10', 10) || 10,
    keyPrefix: process.env.WORKFLOW_REDIS_KEY_PREFIX || 'workflow:',
  },
): RedisBullmqWorld {
  // Batches commands issued in the same event-loop tick into one write. Does
  // nothing for a single serial run, but collapses syscalls under concurrency:
  // measured 1.75x at 256 concurrent invocations, 1.15x at 32, a slight loss
  // at 1. BullMQ's blocking worker connections opt out in queue.ts.
  const autoPipelining = config.enableAutoPipelining ?? true;
  const redis =
    typeof config.redis === 'string'
      ? new Redis(config.redis, { enableAutoPipelining: autoPipelining })
      : new Redis({ enableAutoPipelining: autoPipelining, ...config.redis });

  const keyPrefix = config.keyPrefix || 'workflow:';

  const queue = createQueue(redis, config);
  const storage = createStorage(redis, keyPrefix, config.maxEventsPerRun);
  const streamer = createStreamer({ redis, keyPrefix });

  return {
    ...storage,
    ...streamer,
    ...queue,
    // Event ids are slot-numbered and allocated at the commit inside the Lua
    // scripts, so this World is current-spec compliant by construction (no
    // pre-assigned positions, no noop sealing needed).
    specVersion: SPEC_VERSION_CURRENT,
    async start() {
      await queue.start();
    },
    async close() {
      await queue.close();
      await streamer.closeStreamer();
      try {
        await redis.quit();
      } catch {
        redis.disconnect();
      }
    },
  };
}

// Re-export config and queue types for consumers
export type { RedisWorldConfig } from './config.js';
export type { QueueStats } from './queue.js';

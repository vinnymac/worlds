import { SPEC_VERSION_CURRENT, type Storage, type World } from '@workflow/world';
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

function createStorage(redis: Redis, keyPrefix: string): Storage {
  const config = { redis, keyPrefix };
  return {
    runs: createRunsStorage(config),
    events: createEventsStorage(config),
    hooks: createHooksStorage(config),
    steps: createStepsStorage(config),
  };
}

export function createWorld(
  config: RedisWorldConfig = {
    redis: process.env.WORKFLOW_REDIS_URL || process.env.REDIS_URL || 'redis://localhost:6379',
    jobPrefix: process.env.WORKFLOW_REDIS_JOB_PREFIX,
    queueConcurrency:
      Number.parseInt(process.env.WORKFLOW_REDIS_WORKER_CONCURRENCY || '10', 10) || 10,
    keyPrefix: process.env.WORKFLOW_REDIS_KEY_PREFIX || 'workflow:',
  },
): World & { start(): Promise<void>; getQueueStats(): Promise<QueueStats> } {
  // Create Redis client
  const redis =
    typeof config.redis === 'string' ? new Redis(config.redis) : new Redis(config.redis);

  const keyPrefix = config.keyPrefix || 'workflow:';

  const queue = createQueue(redis, config);
  const storage = createStorage(redis, keyPrefix);
  const streamer = createStreamer({ redis, keyPrefix });

  return {
    ...storage,
    ...streamer,
    ...queue,
    // Declares support for the CBOR/binary-safe queue transport so core
    // attaches runInput to workflow messages (resilient start). The queue
    // serializes payloads with a tagged-JSON transport that round-trips
    // Uint8Array values through BullMQ job data.
    specVersion: SPEC_VERSION_CURRENT,
    async start() {
      await queue.start();
    },
    async close() {
      await queue.close();
      await streamer.close();
      await redis.quit();
    },
  };
}

// Re-export config and queue types for consumers
export type { RedisWorldConfig } from './config.js';
export type { QueueStats } from './queue.js';

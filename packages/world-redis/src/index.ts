import type { Storage, World } from '@workflow/world';
import { Redis } from 'ioredis';
import type { RedisWorldConfig } from './config.js';
import { createQueue } from './queue.js';
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
    redis:
      process.env.WORKFLOW_REDIS_URL ||
      process.env.REDIS_URL ||
      'redis://localhost:6379',
    jobPrefix: process.env.WORKFLOW_REDIS_JOB_PREFIX,
    queueConcurrency:
      Number.parseInt(
        process.env.WORKFLOW_REDIS_WORKER_CONCURRENCY || '10',
        10
      ) || 10,
    keyPrefix: process.env.WORKFLOW_REDIS_KEY_PREFIX || 'workflow:',
  }
): World & { start(): Promise<void> } {
  const redis =
    typeof config.redis === 'string'
      ? new Redis(config.redis)
      : new Redis(config.redis);

  const keyPrefix = config.keyPrefix || 'workflow:';

  const storage = createStorage(redis, keyPrefix);
  const streamer = createStreamer({ redis, keyPrefix });

  const queue = createQueue(redis, config);

  return {
    ...storage,
    ...streamer,
    ...queue,
    async start() {
      await queue.start();
    },
  };
}

// Re-export config for users
export type { RedisWorldConfig } from './config.js';

import type { Storage, World } from '@workflow/world';
import { Redis } from '@upstash/redis';
import type { UpstashWorldConfig } from './config.js';
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

export function createWorld(config: UpstashWorldConfig = {}): World {
  const redisUrl = config.redisUrl || process.env.UPSTASH_REDIS_REST_URL;
  const redisToken = config.redisToken || process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!redisUrl || !redisToken) {
    throw new Error(
      'Upstash Redis credentials are required. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN environment variables.',
    );
  }

  const redis = new Redis({
    url: redisUrl,
    token: redisToken,
  });

  const keyPrefix = config.keyPrefix || 'workflow:';

  const queue = createQueue({
    token: config.qstashToken,
    targetUrl: config.qstashTargetUrl,
  });

  const storage = createStorage(redis, keyPrefix);
  const streamer = createStreamer({ redis, keyPrefix });

  return {
    ...storage,
    ...streamer,
    ...queue,
  };
}

export type { UpstashWorldConfig } from './config.js';

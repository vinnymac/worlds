import type { Storage, World } from '@workflow/world';
import { SPEC_VERSION_CURRENT } from '@workflow/world';
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
import { instrumentRedis } from './util.js';

function createStorage(
  redis: Redis,
  keyPrefix: string,
  maxEventsPerRun?: number,
  claimTtlSeconds?: number,
): Storage {
  const config = { redis, keyPrefix, maxEventsPerRun, claimTtlSeconds };
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

  const rawRedis = new Redis({
    url: redisUrl,
    token: redisToken,
  });

  // Enhancement 4: Instrument Redis client for HTTP request budget monitoring
  const storageRedis = instrumentRedis(rawRedis, 'storage');
  const streamerRedis = instrumentRedis(rawRedis, 'streamer');

  const keyPrefix = config.keyPrefix || 'workflow:';

  const queue = createQueue({
    token: config.qstashToken,
    targetUrl: config.qstashTargetUrl,
    currentSigningKey: config.qstashCurrentSigningKey,
    nextSigningKey: config.qstashNextSigningKey,
    enableDeduplication: config.enableDeduplication,
    retries: config.qstashRetries,
    queueMode: config.queueMode,
    loopbackConcurrency: config.loopbackConcurrency,
  });

  const storage = createStorage(
    storageRedis,
    keyPrefix,
    config.maxEventsPerRun,
    config.claimTtlSeconds,
  );
  const streamer = createStreamer({ redis: streamerRedis, keyPrefix });

  return {
    // Declare the supported spec version so core creates runs at the
    // current spec (enabling resilient start: runInput rides the queue
    // message and run_started can bootstrap the run). The queue transport
    // uses the tagged-JSON codec, so Uint8Array payloads survive.
    specVersion: SPEC_VERSION_CURRENT,
    ...storage,
    ...streamer,
    ...queue,
  };
}

export { getRequestStats, resetRequestStats } from './util.js';
export type { UpstashWorldConfig } from './config.js';

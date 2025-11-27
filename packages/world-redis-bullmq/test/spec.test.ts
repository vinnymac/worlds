import { RedisContainer } from '@testcontainers/redis';
import { createTestSuite } from '@workflow/world-testing';
import { afterAll, beforeAll, test } from 'vitest';

// Skip these tests on Windows since it relies on a docker container
if (process.platform === 'win32') {
  test.skip('skipped on Windows since it relies on a docker container', () => {});
} else {
  let container: Awaited<ReturnType<RedisContainer['start']>>;

  beforeAll(async () => {
    container = await new RedisContainer('redis:7-alpine').start();
    const redisUrl = container.getConnectionUrl();
    process.env.WORKFLOW_REDIS_URL = redisUrl;
    process.env.REDIS_URL = redisUrl;
  }, 120_000);

  afterAll(async () => {
    if (container) {
      await container.stop();
    }
  });

  test('smoke', () => {});
  createTestSuite('@fantasticfour/world-redis-bullmq');
}

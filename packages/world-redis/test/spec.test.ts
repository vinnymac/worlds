import { RedisContainer } from '@testcontainers/redis';
import { createTestSuite } from '@workflow/world-testing';
// Opt-in suite: `createTestSuite` does not include it in 4.1.20, so it has to
// be deep-imported. It asserts the world honours WORKFLOW_MAX_EVENTS via
// EventResult.maxEvents.
import { eventLimit } from '@workflow/world-testing/dist/src/event-limit.mjs';
import { afterAll, beforeAll, test } from 'vitest';

// Skip these tests on Windows since it relies on a docker container
if (process.platform === 'win32') {
  test.skip('skipped on Windows since it relies on a docker container', () => {});
} else {
  let container: Awaited<ReturnType<RedisContainer['start']>>;

  beforeAll(async () => {
    container = await new RedisContainer('redis:7-alpine').start();
    const host = container.getHost();
    const port = container.getFirstMappedPort();
    const redisUrl = `redis://${host}:${port}`;
    process.env.WORKFLOW_REDIS_URL = redisUrl;
    process.env.REDIS_URL = redisUrl;
    console.log('[test beforeAll] Redis container started');
    console.log('[test beforeAll] host=', host, 'port=', port);
    console.log('[test beforeAll] redisUrl=', redisUrl);
    console.log('[test beforeAll] process.env.PORT=', process.env.PORT);
  }, 120_000);

  afterAll(async () => {
    if (container) {
      await container.stop();
    }
  });

  test('smoke', () => {});
  createTestSuite('@fantasticfour/world-redis');
  eventLimit('@fantasticfour/world-redis');
}

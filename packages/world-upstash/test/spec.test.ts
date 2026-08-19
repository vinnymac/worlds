import { RedisContainer } from '@testcontainers/redis';
import { createTestSuite } from '@workflow/world-testing';
// `eventLimit` is deliberately not part of `createTestSuite`, and the package
// publishes no `exports` map, so the dist path is the only way to opt in.
import { eventLimit } from '@workflow/world-testing/dist/src/event-limit.mjs';
import {
  GenericContainer,
  Network,
  type StartedNetwork,
  type StartedTestContainer,
} from 'testcontainers';
import { afterAll, beforeAll, test } from 'vitest';

// Skip these tests on Windows since it relies on docker containers
if (process.platform === 'win32') {
  test.skip('skipped on Windows since it relies on docker containers', () => {});
} else {
  let network: StartedNetwork;
  let redisContainer: StartedTestContainer;
  let srhContainer: StartedTestContainer;

  const SRH_TOKEN = 'test-token';

  beforeAll(async () => {
    // Redis + serverless-redis-http give the world a real Upstash-compatible
    // REST endpoint; see test/storage.test.ts for the same arrangement.
    network = await new Network().start();
    redisContainer = await new RedisContainer('redis:7-alpine')
      .withNetwork(network)
      .withNetworkAliases('redis')
      .start();
    srhContainer = await new GenericContainer('ghcr.io/vinnymac/serverless-redis-http:latest')
      .withNetwork(network)
      .withEnvironment({
        SRH_MODE: 'env',
        SRH_TOKEN,
        SRH_CONNECTION_STRING: 'redis://redis:6379',
      })
      .withExposedPorts(80)
      .start();

    const srhUrl = `http://${srhContainer.getHost()}:${srhContainer.getMappedPort(80)}`;
    process.env.UPSTASH_REDIS_REST_URL = srhUrl;
    process.env.UPSTASH_REDIS_REST_TOKEN = SRH_TOKEN;
    // Hosted QStash cannot reach the in-process harness server, so the queue
    // runs in loopback mode: the QStash wire body is POSTed straight to the
    // harness's flow/step routes (see queueMode in src/queue.ts).
    process.env.WORKFLOW_UPSTASH_QUEUE_MODE = 'loopback';

    console.log('[test beforeAll] SRH started at', srhUrl);
  }, 120_000);

  afterAll(async () => {
    await srhContainer?.stop();
    await redisContainer?.stop();
    await network?.stop();
  });

  test('smoke', () => {});
  createTestSuite('@fantasticfour/world-upstash');
  eventLimit('@fantasticfour/world-upstash');
}

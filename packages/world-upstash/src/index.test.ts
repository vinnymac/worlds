import { describe, expect, it } from 'vitest';
import { createWorld } from './index.js';

describe('createWorld', () => {
  it('throws error when Redis credentials are missing', () => {
    expect(() => createWorld({})).toThrow(
      'Upstash Redis credentials are required. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN environment variables.',
    );
  });

  it('throws error when QStash token is missing', () => {
    expect(() =>
      createWorld({
        redisUrl: 'https://test.upstash.io',
        redisToken: 'test-token',
      }),
    ).toThrow('QStash token is required. Set QSTASH_TOKEN environment variable.');
  });

  it('creates world with valid configuration', () => {
    const world = createWorld({
      redisUrl: 'https://test.upstash.io',
      redisToken: 'test-token',
      qstashToken: 'test-qstash-token',
      qstashTargetUrl: 'https://test.com/api/workflow',
    });

    expect(world).toBeDefined();
    expect(world.runs).toBeDefined();
    expect(world.events).toBeDefined();
    expect(world.steps).toBeDefined();
    expect(world.hooks).toBeDefined();
    expect(world.queue).toBeDefined();
    expect(world.getDeploymentId).toBeDefined();
    expect(world.createQueueHandler).toBeDefined();
    expect(world.streams.write).toBeDefined();
    expect(world.streams.close).toBeDefined();
    expect(world.streams.get).toBeDefined();
  });
});

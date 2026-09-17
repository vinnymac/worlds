import type { Redis } from 'ioredis';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createQueue } from '../src/queue.js';

/** A Redis stand-in whose BLMOVE blocks until disconnect, like the real one. */
function fakeRedis() {
  const workers: { set: ReturnType<typeof vi.fn> }[] = [];
  const redis = {
    options: {},
    eval: vi.fn(async () => 0),
    scan: vi.fn(async () => ['0', []]),
    duplicate: vi.fn(() => {
      const pending: ((value: null) => void)[] = [];
      const worker = {
        set: vi.fn(async () => 'OK'),
        blmove: vi.fn(() => new Promise<null>((resolve) => pending.push(resolve))),
        disconnect: vi.fn(() => {
          for (const resolve of pending.splice(0)) resolve(null);
        }),
      };
      workers.push(worker);
      return worker;
    }),
  } as unknown as Redis;
  return { redis, workers };
}

describe('createQueue heartbeat', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test.each([
    { config: {}, ttl: 90_000, refresh: 30_000 },
    { config: { heartbeatTtlMs: 330_000 }, ttl: 330_000, refresh: 110_000 },
    { config: { heartbeatTtlMs: 15_000 }, ttl: 15_000, refresh: 5_000 },
  ])('uses a $ttl ms TTL refreshed every $refresh ms', async ({ config, ttl, refresh }) => {
    const setInterval = vi.spyOn(globalThis, 'setInterval');
    const { redis, workers } = fakeRedis();
    const queue = createQueue(redis, { redis: '', queueConcurrency: 1, ...config });
    await queue.start();
    await vi.waitFor(() => expect(workers.every((w) => w.set.mock.calls.length > 0)).toBe(true));

    expect(workers).toHaveLength(2);
    const heartbeatDelays = setInterval.mock.calls.map(([, delay]) => delay);
    expect(heartbeatDelays).toEqual([refresh, refresh]);

    // Fire each refresh once: the loop-top SET and the refresh must both use PX.
    for (const [refreshHeartbeat] of setInterval.mock.calls) refreshHeartbeat();
    const write = [expect.stringMatching(/:owner$/), '1', 'PX', ttl];
    for (const worker of workers) {
      expect(worker.set.mock.calls).toEqual([write, write]);
    }
    await queue.stop();
  });

  test.each([0, -1, 1.5, 14_999, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects heartbeatTtlMs %s',
    (heartbeatTtlMs) => {
      const { redis } = fakeRedis();
      expect(() => createQueue(redis, { redis: '', heartbeatTtlMs })).toThrow(RangeError);
    },
  );
});

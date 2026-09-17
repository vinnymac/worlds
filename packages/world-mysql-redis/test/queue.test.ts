import { setTimeout as delay } from 'node:timers/promises';
import type { Redis } from 'ioredis';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { stringify } from '@fantasticfour/shared';
import { createQueue } from '../src/queue.js';

const NOW = 1_000_000;

const item = stringify({
  messageId: 'msg_01',
  queueName: '__wkf_step_test',
  attempt: 1,
  message: {},
});

/** One popped item per worker, then idle; records every claim deadline. */
function mockRedis() {
  const leases: number[] = [];
  const redis = {
    eval: vi.fn(async () => 0),
    duplicate: vi.fn(() => {
      let popped = false;
      return {
        brpoplpush: vi.fn(async () => {
          // Yield like a real blocking pop so the worker loop cannot starve timers.
          if (popped) return delay(10, null);
          popped = true;
          return item;
        }),
        // CLAIM_SCRIPT passes (processing, claims, reclaims, leases, item, token, deadline).
        eval: vi.fn(async (_script: string, numKeys: number, ...args: string[]) => {
          if (numKeys === 4) leases.push(Number(args[6]));
          return 1;
        }),
        quit: vi.fn(async () => 'OK'),
      };
    }),
  };
  return { redis: redis as unknown as Redis, leases };
}

describe('createQueue lease', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  test.each([
    { config: {}, expected: 330_000 },
    { config: { httpTimeoutMs: 10_000 }, expected: 40_000 },
    { config: { visibilityTimeoutMs: 900_000 }, expected: 900_000 },
    { config: { httpTimeoutMs: 10_000, visibilityTimeoutMs: 10_000 }, expected: 10_000 },
  ])('leases popped items for $expected ms', async ({ config, expected }) => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ ok: true })),
    );
    const { redis, leases } = mockRedis();
    const queue = createQueue(redis, {
      databaseUrl: 'mysql://localhost',
      redis: 'redis://localhost',
      queueConcurrency: 1,
      ...config,
    });
    await queue.start();
    await vi.waitFor(() => expect(leases).toHaveLength(2));
    queue.stop();
    expect(leases).toEqual([NOW + expected, NOW + expected]);
  });

  test.each([
    { visibilityTimeoutMs: Number.NaN },
    { visibilityTimeoutMs: Number.POSITIVE_INFINITY },
    { visibilityTimeoutMs: 0 },
    { visibilityTimeoutMs: -1 },
    { visibilityTimeoutMs: 1.5 },
    // Above httpTimeoutMs, so only the integer check rejects these.
    { visibilityTimeoutMs: 300_000.5 },
    { httpTimeoutMs: 10_000, visibilityTimeoutMs: 10_000.5 },
    { visibilityTimeoutMs: 299_999 },
    { httpTimeoutMs: 60_000, visibilityTimeoutMs: 59_999 },
  ])('rejects %o', (config) => {
    const { redis } = mockRedis();
    expect(() =>
      createQueue(redis, {
        databaseUrl: 'mysql://localhost',
        redis: 'redis://localhost',
        ...config,
      }),
    ).toThrow(RangeError);
  });
});

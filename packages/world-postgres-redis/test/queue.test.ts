import { setTimeout as delay } from 'node:timers/promises';
import type { Redis } from 'ioredis';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { PostgresWorldConfig } from '../src/config.js';
import type { Drizzle } from '../src/drizzle/index.js';

vi.mock('../src/outbox.js', () => ({
  createOutboxRelay: () => ({ start: () => () => {} }),
}));
vi.mock('../src/storage.js', () => ({ createEventsStorage: () => ({}) }));

const { createQueue } = await import('../src/queue.js');

const NOW = 1_000_000;
const drizzle = {} as Drizzle;
const baseConfig = {
  connectionString: 'postgres://localhost/test',
  redis: 'redis://localhost:6379',
  baseUrl: 'http://localhost:3000',
  queueConcurrency: 1,
} satisfies PostgresWorldConfig;

function createRedis() {
  const item = JSON.stringify({
    messageId: 'msg_1',
    queueName: '__wkf_step_x',
    attempt: 1,
    message: {},
  });
  let delivered = false;
  const worker = {
    brpoplpush: vi.fn(async (source: string) => {
      if (!delivered && source.endsWith('steps')) {
        delivered = true;
        return item;
      }
      await delay(5);
      return null;
    }),
    // Both the claim (reclaim count) and settle scripts report 0 here.
    eval: vi.fn(async (..._args: (string | number)[]) => 0),
    quit: vi.fn(async () => 'OK'),
  };
  const redis = {
    duplicate: () => worker,
    rpoplpush: vi.fn(async () => null),
    // MOVE_DUE_SCRIPT reports { moved, uncounted }.
    eval: vi.fn(async () => [0, 0]),
  };
  return { redis: redis as unknown as Redis, worker };
}

describe('createQueue visibility timeout', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  test.each([
    { config: {}, expected: 360_000 },
    { config: { httpTimeoutMs: 10_000 }, expected: 70_000 },
    { config: { visibilityTimeoutMs: 900_000 }, expected: 900_000 },
    { config: { httpTimeoutMs: 10_000, visibilityTimeoutMs: 10_000 }, expected: 10_000 },
    // Only an explicit visibilityTimeoutMs has to be an integer.
    { config: { httpTimeoutMs: 1_500.5 }, expected: 61_500.5 },
  ])('claims in-flight items for $expected ms with $config', async ({ config, expected }) => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ ok: true })),
    );
    const { redis, worker } = createRedis();
    const queue = createQueue(redis, drizzle, { ...baseConfig, ...config });
    await queue.start();
    await vi.waitFor(() => expect(worker.eval).toHaveBeenCalledTimes(2));
    await queue.close();

    // CLAIM_SCRIPT: script, numkeys, processing, inflight, reclaims, item, deadline, claim.
    const [claim] = worker.eval.mock.calls;
    expect(claim?.[3]).toMatch(/:inflight$/);
    expect(claim?.[6]).toBe(String(NOW + expected));
  });

  test.each([
    { visibilityTimeoutMs: 0 },
    { visibilityTimeoutMs: -1 },
    { visibilityTimeoutMs: Number.NaN },
    { visibilityTimeoutMs: Number.POSITIVE_INFINITY },
    { visibilityTimeoutMs: 299_999 },
    { visibilityTimeoutMs: 400_000.5 },
  ])('rejects visibilityTimeoutMs $visibilityTimeoutMs', ({ visibilityTimeoutMs }) => {
    const { redis } = createRedis();
    expect(() => createQueue(redis, drizzle, { ...baseConfig, visibilityTimeoutMs })).toThrow(
      RangeError,
    );
  });
});

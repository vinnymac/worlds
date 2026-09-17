import type { WorkerOptions } from 'bullmq';
import type { Redis } from 'ioredis';
import { afterEach, describe, expect, test, vi } from 'vitest';

const { Worker } = vi.hoisted(() => ({
  Worker: vi.fn(function (_name: string, _processor: unknown, _options: WorkerOptions) {
    return { on: vi.fn(), waitUntilReady: vi.fn(async () => {}), close: vi.fn(async () => {}) };
  }),
}));

vi.mock('bullmq', async (importOriginal) => ({
  ...(await importOriginal<typeof import('bullmq')>()),
  Queue: vi.fn(function () {
    return { close: vi.fn(async () => {}) };
  }),
  Worker,
}));

const { createQueue } = await import('../src/queue.js');

const redis = { options: {} } as unknown as Redis;

describe('createQueue workers', () => {
  afterEach(() => {
    Worker.mockClear();
  });

  test.each([
    { config: {}, expected: undefined },
    { config: { lockDuration: 330_000 }, expected: 330_000 },
    { config: { lockDuration: 2_147_483_647 }, expected: 2_147_483_647 },
  ])('passes lockDuration $expected to every worker', async ({ config, expected }) => {
    const queue = createQueue(redis, { redis: 'redis://localhost:6379', ...config });
    await queue.start();
    expect(Worker).toHaveBeenCalledTimes(2);
    for (const [, , options] of Worker.mock.calls) {
      // An own `undefined` key would override BullMQ's default via Object.assign.
      expect('lockDuration' in options).toBe(expected !== undefined);
      expect(options.lockDuration).toBe(expected);
    }
    await queue.close();
  });

  test.each([0, -1, 1.5, 2_147_483_648, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects lockDuration %s',
    (lockDuration) => {
      expect(() => createQueue(redis, { redis: 'redis://localhost:6379', lockDuration })).toThrow(
        RangeError,
      );
    },
  );
});

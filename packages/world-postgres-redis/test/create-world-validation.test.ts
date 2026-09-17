import { expect, test, vi } from 'vitest';

const { Redis, createPostgres } = vi.hoisted(() => ({ Redis: vi.fn(), createPostgres: vi.fn() }));
vi.mock('ioredis', () => ({ Redis }));
vi.mock('postgres', () => ({ default: createPostgres }));

const { createWorld } = await import('../src/index.js');

test('rejects a bad visibilityTimeoutMs before opening any connection', () => {
  expect(() =>
    createWorld({
      connectionString: 'postgres://localhost/test',
      redis: 'redis://localhost:6379',
      visibilityTimeoutMs: 1,
    }),
  ).toThrow(RangeError);
  expect(Redis).not.toHaveBeenCalled();
  expect(createPostgres).not.toHaveBeenCalled();
});

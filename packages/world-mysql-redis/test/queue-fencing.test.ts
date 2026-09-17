import { setTimeout as delay } from 'node:timers/promises';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { parse, stringify } from '@fantasticfour/shared';
import type { StepInvokePayload, ValidQueueName } from '@workflow/world';
import type { MysqlRedisWorldConfig } from '../src/config.js';
import { createQueue } from '../src/queue.js';

const QUEUE_NAME: ValidQueueName = '__wkf_step_test';
const MESSAGE: StepInvokePayload = {
  workflowName: 'wf',
  workflowRunId: 'wrun_01',
  workflowStartedAt: 0,
  stepId: 'step_01',
};

let container: StartedRedisContainer;
let redis: Redis;
const queues: { stop(): void }[] = [];

beforeAll(async () => {
  container = await new RedisContainer('redis:7-alpine').start();
  redis = new Redis(container.getConnectionUrl());
}, 120_000);

afterAll(async () => {
  for (const q of queues) q.stop();
  // Let blocked BRPOPLPUSH calls time out so workers quit cleanly.
  await delay(5_500);
  redis?.disconnect();
  await container?.stop();
}, 30_000);

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

/** Capture the package's gated debug logger, which writes to stderr. */
function captureDebug() {
  vi.stubEnv('WORKFLOW_DEBUG', 'mysql-redis-world');
  const lines: string[] = [];
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    lines.push(String(chunk));
    return true;
  });
  return lines;
}

/** Each fetch waits until the test resolves it with a response. */
function stubFetch() {
  const calls: ((response: Response) => void)[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise<Response>((resolve) => calls.push(resolve))),
  );
  return calls;
}

function start(prefix: string, config: Partial<MysqlRedisWorldConfig> = {}) {
  const queue = createQueue(redis, {
    databaseUrl: 'mysql://localhost',
    redis: 'redis://localhost',
    jobPrefix: prefix,
    queueConcurrency: 2,
    backoffDelayMs: 60_000,
    ...config,
  });
  queues.push(queue);
  return queue;
}

const claimsOf = (prefix: string) => redis.zrange(`${prefix}steps:claims`, '0', '-1');

const outcomes = [
  {
    name: '200',
    mode: 'ack',
    stale: 'ack',
    config: {},
    response: () => Response.json({ ok: true }),
    after: { delayed: 0, dlq: 0, idempotencyKey: 0 },
  },
  {
    name: '500',
    mode: 'retry',
    stale: 'retry',
    config: { maxAttempts: 5 },
    response: () => new Response('boom', { status: 500 }),
    after: { delayed: 1, dlq: 0, idempotencyKey: 1 },
  },
  {
    name: '503 suspension',
    mode: 'retry',
    stale: 'retry',
    config: { maxAttempts: 5 },
    response: () => Response.json({ timeoutSeconds: 60 }, { status: 503 }),
    after: { delayed: 1, dlq: 0, idempotencyKey: 1 },
  },
  {
    name: 'exhausted 500',
    mode: 'dead',
    // The reclaim counts as an attempt, so the stale delivery still had one left.
    stale: 'retry',
    config: { maxAttempts: 2 },
    response: () => new Response('boom', { status: 500 }),
    after: { delayed: 0, dlq: 1, idempotencyKey: 0 },
  },
] as const;

describe('claim fencing', () => {
  test.each(outcomes.map((o, i) => ({ ...o, prefix: `fence${i}_` })))(
    'stale $name settle after redelivery keeps the new claim; owner settle runs $mode',
    async ({ stale, config, response, after, prefix }) => {
      const debug = captureDebug();
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const calls = stubFetch();
      const queue = start(prefix, config);
      await queue.queue(QUEUE_NAME, MESSAGE, { idempotencyKey: 'k' });
      await queue.start();
      await vi.waitFor(() => expect(calls).toHaveLength(1));

      // Expire the first claim so the reclaimer redelivers it to worker B.
      const [first] = await claimsOf(prefix);
      await redis.zadd(`${prefix}steps:claims`, 0, first);
      await vi.waitFor(() => expect(calls).toHaveLength(2));
      const [second] = await claimsOf(prefix);
      expect(second).not.toBe(first);
      const deadline = await redis.zscore(`${prefix}steps:claims`, second);

      calls[0](response());
      await vi.waitFor(() =>
        expect(debug.filter((line) => line.includes(`skipped stale ${stale}`))).toHaveLength(1),
      );
      expect(await claimsOf(prefix)).toEqual([second]);
      expect(await redis.zscore(`${prefix}steps:claims`, second)).toBe(deadline);
      expect(await redis.zcard(`${prefix}steps:delayed`)).toBe(0);
      expect(await redis.llen(`${prefix}steps:dlq`)).toBe(0);
      expect(await redis.exists(`${prefix}steps:idempotent:k`)).toBe(1);

      calls[1](response());
      await vi.waitFor(async () => expect(await claimsOf(prefix)).toEqual([]));
      expect(await redis.zcard(`${prefix}steps:delayed`)).toBe(after.delayed);
      expect(await redis.llen(`${prefix}steps:dlq`)).toBe(after.dlq);
      expect(await redis.exists(`${prefix}steps:idempotent:k`)).toBe(after.idempotencyKey);
      expect(debug.filter((line) => line.includes('skipped stale'))).toHaveLength(1);
      queue.stop();
    },
    30_000,
  );

  test('dead-letters a delivery whose lease keeps expiring', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const debug = captureDebug();
    const prefix = 'reclaims_';
    const calls = stubFetch();
    const queue = start(prefix, { maxAttempts: 2, queueConcurrency: 3 });
    await queue.queue(QUEUE_NAME, MESSAGE, { idempotencyKey: 'k' });
    await queue.start();

    // Each hung delivery's lease expires, so its fenced retry can never land.
    for (const delivered of [1, 2]) {
      await vi.waitFor(() => expect(calls).toHaveLength(delivered));
      const [claim] = await claimsOf(prefix);
      await redis.zadd(`${prefix}steps:claims`, 0, claim);
    }
    await vi.waitFor(async () => expect(await redis.llen(`${prefix}steps:dlq`)).toBe(1));
    await vi.waitFor(() =>
      expect(error).toHaveBeenCalledWith(expect.stringContaining('lease expired 2 time(s)')),
    );
    // The DLQ entry carries the counted attempt, not the enqueued one.
    const [dead] = await redis.lrange(`${prefix}steps:dlq`, 0, -1);
    expect(parse<{ attempt: number }>(dead).attempt).toBe(3);
    expect(calls).toHaveLength(2);
    expect(await claimsOf(prefix)).toEqual([]);
    expect(await redis.exists(`${prefix}steps:reclaims`)).toBe(0);
    expect(await redis.exists(`${prefix}steps:idempotent:k`)).toBe(0);

    // The second delivery ran at maxAttempts, so its stale settle is a dead-letter.
    for (const resolve of calls) resolve(new Response('boom', { status: 500 }));
    await vi.waitFor(() =>
      expect(debug.filter((line) => line.includes('skipped stale'))).toHaveLength(2),
    );
    expect(debug.filter((line) => line.includes('skipped stale dead'))).toHaveLength(1);
    const deadLetterLogs = error.mock.calls.filter(([m]) => String(m).includes('dead-lettering'));
    expect(deadLetterLogs).toHaveLength(1);
    expect(await redis.llen(`${prefix}steps:dlq`)).toBe(1);
    expect(await redis.zcard(`${prefix}steps:delayed`)).toBe(0);
    queue.stop();
  }, 30_000);

  test('dispatches a retry above a lowered maxAttempts that never lost a lease', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const prefix = 'lowered_';
    // A retry payload scheduled before maxAttempts was lowered to 2.
    const item = stringify({
      messageId: 'msg_01LOWERED',
      queueName: QUEUE_NAME,
      attempt: 5,
      message: {},
    });
    await redis.lpush(`${prefix}steps`, item);

    const calls = stubFetch();
    const queue = start(prefix, { maxAttempts: 2 });
    await queue.start();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(await redis.llen(`${prefix}steps:dlq`)).toBe(0);
    expect(error).not.toHaveBeenCalled();

    // Its failure is what dead-letters it, with the payload untouched.
    calls[0](new Response('boom', { status: 500 }));
    await vi.waitFor(async () =>
      expect(await redis.lrange(`${prefix}steps:dlq`, 0, -1)).toEqual([item]),
    );
    await vi.waitFor(() =>
      expect(error).toHaveBeenCalledWith(expect.stringContaining('after 5 attempts')),
    );
    expect(await redis.zcard(`${prefix}steps:delayed`)).toBe(0);
    queue.stop();
  }, 30_000);

  test('carries reclaims into the retry attempt and clears the count', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const prefix = 'reclaim_retry_';
    const calls = stubFetch();
    const queue = start(prefix, { maxAttempts: 5 });
    await queue.queue(QUEUE_NAME, MESSAGE);
    await queue.start();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const [claim] = await claimsOf(prefix);
    await redis.zadd(`${prefix}steps:claims`, 0, claim);
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(await redis.hlen(`${prefix}steps:reclaims`)).toBe(1);

    calls[1](new Response('boom', { status: 500 }));
    await vi.waitFor(async () => expect(await redis.zcard(`${prefix}steps:delayed`)).toBe(1));
    const [retry] = await redis.zrange(`${prefix}steps:delayed`, '0', '-1');
    expect(parse<{ attempt: number }>(retry).attempt).toBe(3);
    expect(await redis.hlen(`${prefix}steps:reclaims`)).toBe(0);
    calls[0](new Response('boom', { status: 500 }));
    queue.stop();
  }, 30_000);

  test('claiming an item drops the raw lease an earlier adoption left', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const prefix = 'phantom_';
    const item = stringify({
      messageId: 'msg_01PHANTOM',
      queueName: QUEUE_NAME,
      attempt: 1,
      message: {},
    });
    // The state orphan adoption leaves behind: a raw lease on bytes still queued.
    // Its deadline is far out, so only the claim can remove it.
    await redis.zadd(`${prefix}steps:leases`, Date.now() + 600_000, item);
    await redis.lpush(`${prefix}steps`, item);

    const calls = stubFetch();
    const queue = start(prefix);
    await queue.start();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(await claimsOf(prefix)).toHaveLength(1);
    // Left behind, this lease would later reclaim whichever delivery holds the
    // same bytes, counting a phantom reclaim against it.
    expect(await redis.zcard(`${prefix}steps:leases`)).toBe(0);

    // A suspension re-pushes identical bytes; nothing may count a reclaim.
    calls[0](Response.json({ timeoutSeconds: 0 }, { status: 503 }));
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(await redis.hlen(`${prefix}steps:reclaims`)).toBe(0);

    calls[1](Response.json({ ok: true }));
    await vi.waitFor(async () => expect(await claimsOf(prefix)).toEqual([]));
    queue.stop();
  }, 30_000);

  test('a suspension after a reclaim keeps the counted attempt', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const prefix = 'reclaim_suspend_';
    const calls = stubFetch();
    const queue = start(prefix, { maxAttempts: 5 });
    await queue.queue(QUEUE_NAME, MESSAGE);
    await queue.start();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const [claim] = await claimsOf(prefix);
    await redis.zadd(`${prefix}steps:claims`, 0, claim);
    await vi.waitFor(() => expect(calls).toHaveLength(2));

    // Suspension leaves the attempt alone, but the reclaim it already spent stays counted.
    calls[1](Response.json({ timeoutSeconds: 60 }, { status: 503 }));
    await vi.waitFor(async () => expect(await redis.zcard(`${prefix}steps:delayed`)).toBe(1));
    const [suspended] = await redis.zrange(`${prefix}steps:delayed`, '0', '-1');
    expect(parse<{ attempt: number }>(suspended).attempt).toBe(2);
    expect(await redis.hlen(`${prefix}steps:reclaims`)).toBe(0);

    calls[0](Response.json({ ok: true }));
    queue.stop();
  }, 30_000);

  test('reclaims legacy leases and survives a pre-fencing worker ack', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const prefix = 'legacy_';
    const item = stringify({
      messageId: 'msg_01LEGACY',
      queueName: QUEUE_NAME,
      attempt: 1,
      message: {},
    });
    // An expired raw-item lease written by the previous version.
    await redis.lpush(`${prefix}steps:processing`, item);
    await redis.zadd(`${prefix}steps:leases`, 0, item);

    const calls = stubFetch();
    const queue = start(prefix);
    await queue.start();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(await redis.zcard(`${prefix}steps:leases`)).toBe(0);
    expect(await claimsOf(prefix)).toHaveLength(1);

    // The previous version's ack from the stalled original execution.
    await redis
      .multi()
      .lrem(`${prefix}steps:processing`, 1, item)
      .zrem(`${prefix}steps:leases`, item)
      .exec();
    expect(await claimsOf(prefix)).toHaveLength(1);

    calls[0](Response.json({ ok: true }));
    await vi.waitFor(async () => expect(await claimsOf(prefix)).toEqual([]));
    expect(await redis.llen(`${prefix}steps:processing`)).toBe(0);
    expect(await redis.llen(`${prefix}steps`)).toBe(0);
    expect(calls).toHaveLength(1);
    queue.stop();
  }, 30_000);

  test('adopts a processing entry that has no lease, then reclaims it', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const prefix = 'orphan_';
    const item = stringify({
      messageId: 'msg_01ORPHAN',
      queueName: QUEUE_NAME,
      attempt: 1,
      message: {},
    });
    // A worker died between its pop and its lease.
    await redis.lpush(`${prefix}steps:processing`, item);

    const calls = stubFetch();
    const queue = start(prefix);
    await queue.start();
    await vi.waitFor(async () =>
      expect(await redis.zrange(`${prefix}steps:leases`, '0', '-1')).toEqual([item]),
    );
    expect(calls).toHaveLength(0);

    await redis.zadd(`${prefix}steps:leases`, 0, item);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(await redis.hvals(`${prefix}steps:reclaims`)).toEqual(['1']);
    expect(await claimsOf(prefix)).toHaveLength(1);
    expect(await redis.zcard(`${prefix}steps:leases`)).toBe(0);
    expect(await redis.llen(`${prefix}steps:processing`)).toBe(0);

    calls[0](Response.json({ ok: true }));
    await vi.waitFor(async () => expect(await claimsOf(prefix)).toEqual([]));
    expect(await redis.exists(`${prefix}steps:reclaims`)).toBe(0);
    queue.stop();
  }, 30_000);

  test('a claim whose processing entry is gone writes nothing', async () => {
    const debug = captureDebug();
    const prefix = 'unclaimed_';
    const calls = stubFetch();
    // Empty the processing list in the pop-to-claim window, as a reclaim would.
    const duplicate = redis.duplicate.bind(redis);
    vi.spyOn(redis, 'duplicate').mockImplementation((options) => {
      const worker = duplicate(options);
      const pop = worker.brpoplpush.bind(worker);
      vi.spyOn(worker, 'brpoplpush').mockImplementation(async (source, destination, timeout) => {
        const popped = await pop(source, destination, timeout);
        if (popped) await redis.del(`${prefix}steps:processing`);
        return popped;
      });
      return worker;
    });

    const queue = start(prefix);
    await queue.queue(QUEUE_NAME, MESSAGE);
    await queue.start();
    await vi.waitFor(() =>
      expect(debug.filter((line) => line.includes('reclaimed before its claim'))).toHaveLength(1),
    );
    expect(await claimsOf(prefix)).toEqual([]);
    expect(await redis.exists(`${prefix}steps:reclaims`)).toBe(0);
    expect(await redis.zcard(`${prefix}steps:leases`)).toBe(0);
    expect(calls).toHaveLength(0);
    queue.stop();
  }, 30_000);
});

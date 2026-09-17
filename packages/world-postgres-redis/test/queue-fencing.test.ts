import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import type { PostgresWorldConfig } from '../src/config.js';
import type { Drizzle } from '../src/drizzle/index.js';

const createEvent = vi.fn(async () => ({}));
vi.mock('../src/outbox.js', () => ({
  createOutboxRelay: () => ({ start: () => () => {} }),
}));
vi.mock('../src/storage.js', () => ({ createEventsStorage: () => ({ create: createEvent }) }));

const { createQueue, CLAIM_PREFIX } = await import('../src/queue.js');
const drizzle = {} as Drizzle;

interface PendingFetch {
  messageId: string | null;
  attempt: string | null;
  resolve: (response: Response) => void;
}

/** Every stubbed fetch of the running test, so afterEach can release them. */
const stubbedFetches: PendingFetch[] = [];

function stubFetch(): PendingFetch[] {
  const calls: PendingFetch[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (_url: URL, init: RequestInit) =>
        new Promise<Response>((resolve) => {
          const headers = new Headers(init.headers);
          const call = {
            messageId: headers.get('x-vqs-message-id'),
            attempt: headers.get('x-vqs-message-attempt'),
            resolve,
          };
          calls.push(call);
          stubbedFetches.push(call);
        }),
    ),
  );
  return calls;
}

function envelope(messageId: string, idempotencyKey?: string): string {
  return JSON.stringify({
    messageId,
    idempotencyKey,
    queueName: '__wkf_step_x',
    attempt: 1,
    // Must satisfy QueuePayloadSchema, or the dead-letter path never fails the run.
    message: {
      workflowRunId: 'wrun_1',
      workflowName: 'wf',
      workflowStartedAt: 1,
      stepId: 'step_1',
    },
  });
}

if (process.platform === 'win32') {
  test.skip('skipped on Windows since it relies on a docker container', () => {});
} else {
  describe('queue claim fencing', () => {
    let container: StartedRedisContainer;
    let url: string;
    const clients: Redis[] = [];
    const queues: { close(): Promise<void> }[] = [];

    beforeAll(async () => {
      container = await new RedisContainer('redis:7-alpine').start();
      url = `redis://${container.getHost()}:${container.getFirstMappedPort()}`;
    }, 120_000);

    afterAll(async () => {
      await container?.stop();
    });

    afterEach(async () => {
      // Finish any stalled delivery, or close() waits on its worker forever.
      for (const call of stubbedFetches.splice(0)) call.resolve(Response.json({ ok: true }));
      await Promise.all(queues.splice(0).map((queue) => queue.close()));
      await Promise.all(clients.splice(0).map((client) => client.quit()));
      vi.unstubAllGlobals();
      createEvent.mockClear();
    });

    /** A world-side client whose worker connections record settle results. */
    function connect() {
      const client = new Redis(url);
      clients.push(client);
      const settles: Promise<unknown>[] = [];
      const duplicate = client.duplicate.bind(client);
      vi.spyOn(client, 'duplicate').mockImplementation((options) => {
        const worker = duplicate(options);
        // Workers eval to claim (3 keys) and to settle (4 keys).
        const evaluate = worker.eval.bind(worker);
        vi.spyOn(worker, 'eval').mockImplementation((...args: Parameters<Redis['eval']>) => {
          const result = evaluate(...args);
          if (args[1] === 4) settles.push(result);
          return result;
        });
        return worker;
      });
      return { client, settles };
    }

    /**
     * Expire the one claim in `inflightKey` and wait for the promote loop to
     * take it, so the next assertion sees the redelivery, not the old claim.
     */
    async function expireClaim(
      admin: Redis,
      inflightKey: string,
      { settled = false }: { settled?: boolean } = {},
    ) {
      const [claim] = await admin.zrange(inflightKey, '0', '-1');
      if (!claim) throw new Error('claim missing');
      await admin.zadd(inflightKey, '0', claim);
      await vi.waitFor(async () => expect(await admin.zscore(inflightKey, claim)).toBeNull(), {
        timeout: 5_000,
      });
      // A redelivery that settles leaves nothing behind; otherwise a new claim lands.
      await vi.waitFor(async () => expect(await admin.zcard(inflightKey)).toBe(settled ? 0 : 1), {
        timeout: 5_000,
      });
    }

    function start(client: Redis, config: Partial<PostgresWorldConfig>) {
      const queue = createQueue(client, drizzle, {
        connectionString: 'postgres://localhost/test',
        redis: url,
        baseUrl: 'http://localhost:3000',
        queueConcurrency: 1,
        ...config,
      });
      queues.push(queue);
      return queue;
    }

    test.each([
      { outcome: 'success', status: 200, maxAttempts: 5 },
      { outcome: 'retry', status: 500, maxAttempts: 5 },
      { outcome: 'dead-letter', status: 500, maxAttempts: 1 },
    ])(
      'stale $outcome settle after redelivery leaves the new claim intact',
      async ({ status, maxAttempts }) => {
        const jobPrefix = `fence_${randomUUID()}_`;
        const listKey = `${jobPrefix}steps`;
        const inflightKey = `${listKey}:inflight`;
        const dedupKey = `${listKey}:dedup:k`;
        const calls = stubFetch();
        const admin = new Redis(url);
        clients.push(admin);
        await admin.set(dedupKey, 'msg_1');
        await admin.lpush(listKey, envelope('msg_1', 'k'));

        const stale = connect();
        const owner = connect();
        await start(stale.client, { jobPrefix, maxAttempts }).start();
        await vi.waitFor(() => expect(calls).toHaveLength(1));
        await start(owner.client, { jobPrefix, visibilityTimeoutMs: 600_000 }).start();
        // Expire the stale claim so it is promoted and reclaimed by the owner.
        await expireClaim(admin, inflightKey);
        await vi.waitFor(() => expect(calls).toHaveLength(2), { timeout: 5_000 });
        const [ownerClaim, ownerDeadline] = await admin.zrange(
          inflightKey,
          '0',
          '-1',
          'WITHSCORES',
        );
        expect(ownerClaim?.startsWith(CLAIM_PREFIX)).toBe(true);

        calls[0]?.resolve(Response.json({ error: 'late' }, { status }));
        await vi.waitFor(() => expect(stale.settles).toHaveLength(1));
        expect(await stale.settles[0]).toBe(0);
        expect(await admin.zrange(inflightKey, '0', '-1', 'WITHSCORES')).toEqual([
          ownerClaim,
          ownerDeadline,
        ]);
        expect(await admin.zcard(`${listKey}:delayed`)).toBe(0);
        expect(await admin.exists(dedupKey)).toBe(1);
        expect(createEvent).not.toHaveBeenCalled();

        calls[1]?.resolve(Response.json({ ok: true }));
        await vi.waitFor(() => expect(owner.settles).toHaveLength(1));
        expect(await owner.settles[0]).toBe(1);
        expect(await admin.zcard(inflightKey)).toBe(0);
        expect(await admin.exists(dedupKey)).toBe(0);
        expect(await admin.exists(`${listKey}:reclaims:msg_1`)).toBe(0);
      },
      15_000,
    );

    test('dead-letters a delivery whose claim keeps expiring before it settles', async ({
      onTestFinished,
    }) => {
      const jobPrefix = `reclaim_${randomUUID()}_`;
      const listKey = `${jobPrefix}steps`;
      const inflightKey = `${listKey}:inflight`;
      const calls = stubFetch();
      const admin = new Redis(url);
      clients.push(admin);
      vi.spyOn(console, 'error').mockImplementation(() => {});
      onTestFinished(() => {
        vi.restoreAllMocks();
      });
      await admin.lpush(listKey, envelope('msg_reclaim'));

      // maxAttempts 2: the first delivery plus one reclaim is the budget.
      const stale = connect();
      await start(stale.client, { jobPrefix, maxAttempts: 2 }).start();
      await vi.waitFor(() => expect(calls).toHaveLength(1));

      const owner = connect();
      await start(owner.client, { jobPrefix, maxAttempts: 2, queueConcurrency: 2 }).start();
      await expireClaim(admin, inflightKey);
      // Reclaimed once: redelivered as attempt 2, the last one allowed.
      await vi.waitFor(() => expect(calls).toHaveLength(2), { timeout: 5_000 });
      expect(calls[1]?.attempt).toBe('2');
      expect(await admin.get(`${listKey}:reclaims:msg_reclaim`)).toBe('1');

      // Reclaimed twice: past the budget, so it is dead-lettered undispatched.
      await expireClaim(admin, inflightKey, { settled: true });
      await vi.waitFor(
        () =>
          expect(console.error).toHaveBeenCalledWith(
            expect.stringContaining('dropping msg_reclaim after 2 attempts'),
          ),
        { timeout: 5_000 },
      );
      expect(createEvent).toHaveBeenCalledExactlyOnceWith(
        'wrun_1',
        expect.objectContaining({ eventType: 'run_failed' }),
      );
      expect(calls).toHaveLength(2);
      expect(await admin.zcard(inflightKey)).toBe(0);
      expect(await admin.llen(listKey)).toBe(0);
      expect(await admin.zcard(`${listKey}:delayed`)).toBe(0);
      expect(await admin.exists(`${listKey}:reclaims:msg_reclaim`)).toBe(0);
    }, 20_000);

    test('keeps an exhausted claim when the run cannot be failed', async ({ onTestFinished }) => {
      const jobPrefix = `keep_${randomUUID()}_`;
      const listKey = `${jobPrefix}steps`;
      const inflightKey = `${listKey}:inflight`;
      const calls = stubFetch();
      const admin = new Redis(url);
      clients.push(admin);
      vi.spyOn(console, 'error').mockImplementation(() => {});
      onTestFinished(() => {
        vi.restoreAllMocks();
      });
      createEvent.mockRejectedValueOnce(new Error('postgres is down'));
      await admin.lpush(listKey, envelope('msg_keep'));

      const owner = connect();
      await start(owner.client, { jobPrefix, maxAttempts: 1 }).start();
      await vi.waitFor(() => expect(calls).toHaveLength(1));
      calls[0]?.resolve(Response.json({ error: 'boom' }, { status: 500 }));

      // The run_failed write threw, so the claim survives unsettled.
      await vi.waitFor(() =>
        expect(console.error).toHaveBeenCalledWith(
          expect.stringContaining('could not fail run for msg_keep'),
          expect.any(Error),
        ),
      );
      expect(await admin.zcard(inflightKey)).toBe(1);
      expect(owner.settles).toHaveLength(0);

      // Its expiry redelivers, and the dead-letter succeeds this time.
      await expireClaim(admin, inflightKey, { settled: true });
      expect(createEvent).toHaveBeenCalledTimes(2);
      expect(calls).toHaveLength(1);
      expect(await admin.exists(`${listKey}:reclaims:msg_keep`)).toBe(0);
    }, 20_000);

    test('a duplicate held while the original runs does not consume an attempt', async () => {
      const jobPrefix = `hold_${randomUUID()}_`;
      const listKey = `${jobPrefix}steps`;
      const inflightKey = `${listKey}:inflight`;
      const reclaimsKey = `${listKey}:reclaims:msg_hold`;
      const calls = stubFetch();
      const admin = new Redis(url);
      clients.push(admin);
      await admin.set(`${listKey}:dedup:k`, 'msg_hold');
      await admin.lpush(listKey, envelope('msg_hold', 'k'));

      // One process, maxAttempts 2: a held duplicate would exhaust the
      // budget before the message is ever dispatched a second time.
      const { client } = connect();
      await start(client, { jobPrefix, queueConcurrency: 2, maxAttempts: 2 }).start();
      await vi.waitFor(() => expect(calls).toHaveLength(1));

      // The claim expires; the redelivery only holds the claim, since the
      // original is still executing in this process.
      await expireClaim(admin, inflightKey);
      await vi.waitFor(async () => expect(await admin.exists(reclaimsKey)).toBe(0), {
        timeout: 5_000,
      });
      expect(calls).toHaveLength(1);

      // The original fails after losing its claim, so the held claim's own
      // redelivery is the message's second attempt, not its third.
      calls[0]?.resolve(new Response('boom', { status: 500 }));
      await expireClaim(admin, inflightKey);
      await vi.waitFor(() => expect(calls).toHaveLength(2), { timeout: 5_000 });
      expect(calls[1]?.attempt).toBe('2');

      calls[1]?.resolve(Response.json({ ok: true }));
      await vi.waitFor(async () => expect(await admin.zcard(inflightKey)).toBe(0), {
        timeout: 5_000,
      });
    }, 20_000);

    test('promotes an expired claim with no readable messageId and says so', async () => {
      const jobPrefix = `unreadable_${randomUUID()}_`;
      const listKey = `${jobPrefix}steps`;
      const inflightKey = `${listKey}:inflight`;
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      stubFetch();
      const admin = new Redis(url);
      clients.push(admin);
      // A claim whose body has no messageId cannot be counted, but blocking
      // the batch on it would stall every message behind it.
      await admin.zadd(inflightKey, 0, `${CLAIM_PREFIX}${randomUUID()}","junk":1}`);

      await start(connect().client, { jobPrefix }).start();
      await vi.waitFor(
        () =>
          expect(errors).toHaveBeenCalledWith(
            expect.stringContaining('carry no readable messageId'),
          ),
        { timeout: 5_000 },
      );
      expect(await admin.zcard(inflightKey)).toBe(0);
    }, 20_000);

    test('a 503 suspension keeps the reclaim count', async () => {
      const jobPrefix = `suspend_${randomUUID()}_`;
      const listKey = `${jobPrefix}steps`;
      const inflightKey = `${listKey}:inflight`;
      const reclaimsKey = `${listKey}:reclaims:msg_suspend`;
      const calls = stubFetch();
      const admin = new Redis(url);
      clients.push(admin);
      await admin.lpush(listKey, envelope('msg_suspend'));

      const stale = connect();
      await start(stale.client, { jobPrefix }).start();
      await vi.waitFor(() => expect(calls).toHaveLength(1));
      const owner = connect();
      await start(owner.client, { jobPrefix, visibilityTimeoutMs: 600_000 }).start();

      // One reclaim, then the redelivery suspends: the count must survive,
      // so a message that stalls between sleeps still exhausts its attempts.
      await expireClaim(admin, inflightKey);
      await vi.waitFor(() => expect(calls).toHaveLength(2), { timeout: 5_000 });
      expect(await admin.get(reclaimsKey)).toBe('1');

      calls[1]?.resolve(Response.json({ timeoutSeconds: 60 }, { status: 503 }));
      await vi.waitFor(() => expect(owner.settles).toHaveLength(1));
      expect(await owner.settles[0]).toBe(1);
      expect(await admin.zcard(`${listKey}:delayed`)).toBe(1);
      expect(await admin.get(reclaimsKey)).toBe('1');
      expect(await admin.pttl(reclaimsKey)).toBeGreaterThan(0);

      calls[0]?.resolve(Response.json({ ok: true }));
    }, 20_000);

    test.each([
      { held: 'msg_dedup', name: 'its own', expected: 0 },
      { held: 'msg_newer', name: "a newer enqueue's", expected: 1 },
    ])(
      'a stalled success releases $name dedup key',
      async ({ held, expected }) => {
        const jobPrefix = `dedup_${randomUUID()}_`;
        const listKey = `${jobPrefix}steps`;
        const inflightKey = `${listKey}:inflight`;
        const dedupKey = `${listKey}:dedup:k`;
        const calls = stubFetch();
        const admin = new Redis(url);
        clients.push(admin);
        await admin.set(dedupKey, 'msg_dedup');
        await admin.lpush(listKey, envelope('msg_dedup', 'k'));

        // One process: the duplicate delivery hits the completed-key cache.
        const { client } = connect();
        await start(client, { jobPrefix, queueConcurrency: 2 }).start();
        await vi.waitFor(() => expect(calls).toHaveLength(1));
        // The claim expires and is redelivered while the original still runs.
        await expireClaim(admin, inflightKey);

        // The original succeeds, but its release is fenced: the key survives.
        calls[0]?.resolve(Response.json({ ok: true }));
        await delay(200);
        expect(await admin.exists(dedupKey)).toBe(1);

        await admin.set(dedupKey, held);
        // The duplicate's claim expires too; its redelivery hits the completed cache.
        await expireClaim(admin, inflightKey, { settled: true });
        expect(calls).toHaveLength(1);
        expect(await admin.exists(dedupKey)).toBe(expected);
      },
      20_000,
    );

    test('skips an item the startup recovery requeued before it was claimed', async () => {
      const jobPrefix = `recover_${randomUUID()}_`;
      const listKey = `${jobPrefix}steps`;
      const processingKey = `${listKey}:processing`;
      const calls = stubFetch();
      const admin = new Redis(url);
      clients.push(admin);
      await admin.lpush(listKey, envelope('msg_recover'));

      // Another process recovers the processing list between pop and claim.
      const client = new Redis(url);
      clients.push(client);
      let stolen = false;
      const duplicate = client.duplicate.bind(client);
      vi.spyOn(client, 'duplicate').mockImplementation((options) => {
        const worker = duplicate(options);
        const pop = worker.brpoplpush.bind(worker);
        vi.spyOn(worker, 'brpoplpush').mockImplementation(async (...args) => {
          const item = await pop(...args);
          if (item && !stolen) {
            stolen = true;
            await admin.rpoplpush(processingKey, listKey);
          }
          return item;
        });
        return worker;
      });
      await start(client, { jobPrefix, queueConcurrency: 1 }).start();

      await vi.waitFor(() => expect(calls).toHaveLength(1), { timeout: 5_000 });
      await delay(300);
      // Delivered once: the stolen pop claimed nothing.
      expect(calls).toHaveLength(1);
      expect(await admin.llen(listKey)).toBe(0);
      expect(await admin.llen(processingKey)).toBe(0);
      expect(await admin.zcard(`${listKey}:inflight`)).toBe(1);

      calls[0]?.resolve(Response.json({ ok: true }));
    }, 20_000);

    test.each([
      { format: 'legacy untokened in-flight member', legacy: true },
      { format: 'tokened item pushed by a pre-fencing promoter', legacy: false },
    ])(
      'delivers and acks a $format',
      async ({ legacy }) => {
        const jobPrefix = `fence_${randomUUID()}_`;
        const listKey = `${jobPrefix}steps`;
        const inflightKey = `${listKey}:inflight`;
        const calls = stubFetch();
        const admin = new Redis(url);
        clients.push(admin);
        const item = envelope('msg_legacy');
        if (legacy) {
          await admin.zadd(inflightKey, '1', item);
        } else {
          await admin.lpush(listKey, `${CLAIM_PREFIX}${randomUUID()}",${item.slice(1)}`);
        }

        const { client, settles } = connect();
        await start(client, { jobPrefix }).start();
        await vi.waitFor(() => expect(calls).toHaveLength(1), { timeout: 5_000 });
        expect(calls[0]?.messageId).toBe('msg_legacy');
        const [claim] = await admin.zrange(inflightKey, '0', '-1');
        expect(claim?.startsWith(CLAIM_PREFIX)).toBe(true);
        expect(claim?.endsWith(item.slice(1))).toBe(true);

        calls[0]?.resolve(Response.json({ ok: true }));
        await vi.waitFor(() => expect(settles).toHaveLength(1));
        expect(await settles[0]).toBe(1);
        expect(await admin.zcard(inflightKey)).toBe(0);
        expect(await admin.llen(listKey)).toBe(0);
      },
      15_000,
    );
  });
}

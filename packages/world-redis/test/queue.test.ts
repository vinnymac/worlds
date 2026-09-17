import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { RedisContainer } from '@testcontainers/redis';
import type { QueuePayload, ValidQueueName } from '@workflow/world';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it, test, vi } from 'vitest';
import { createQueue } from '../src/queue.js';
import { stringifyWithUint8Array } from '../src/util.js';

interface ReceivedMessage {
  body: QueuePayload;
  attempt: number;
}

describe('Queue (Redis integration)', () => {
  if (process.platform === 'win32') {
    test.skip('skipped on Windows since it relies on a docker container', () => {});
    return;
  }

  let container: Awaited<ReturnType<RedisContainer['start']>>;
  let redis: Redis;
  let server: Server;
  let baseUrl: string;

  const received: ReceivedMessage[] = [];
  /** Per-test response override: return a status to short-circuit. */
  let respond: (
    attempt: number,
  ) =>
    | { status: number; body?: string }
    | undefined
    | Promise<{ status: number; body?: string } | undefined> = () => undefined;

  const queues: ReturnType<typeof createQueue>[] = [];
  let prefixCounter = 0;

  function makeQueue(overrides?: { queueConcurrency?: number }) {
    prefixCounter += 1;
    const q = createQueue(redis, {
      redis: '',
      jobPrefix: `qtest${prefixCounter}_${Date.now()}_`,
      queueConcurrency: overrides?.queueConcurrency ?? 2,
      baseUrl,
      backoffType: 'fixed',
      backoffDelayMs: 200,
      maxAttempts: 5,
    });
    queues.push(q);
    return q;
  }

  /** Reuse the same job prefix as another queue (simulates a restarted process). */
  function makeQueueSharingPrefix(other: { jobPrefix: string }) {
    const q = createQueue(redis, {
      redis: '',
      jobPrefix: other.jobPrefix,
      queueConcurrency: 2,
      baseUrl,
      backoffType: 'fixed',
      backoffDelayMs: 200,
      maxAttempts: 5,
    });
    queues.push(q);
    return q;
  }

  beforeAll(async () => {
    container = await new RedisContainer('redis:7-alpine').start();
    redis = new Redis(container.getConnectionUrl());

    // The HTTP server routes requests through a real createQueueHandler so
    // both transport directions (worker serialize -> handler revive) are
    // exercised end to end.
    server = createServer((req, res) => {
      let data = '';
      req.on('data', (chunk: Buffer) => {
        data += chunk.toString();
      });
      req.on('end', () => {
        void (async () => {
          const attempt = Number.parseInt(String(req.headers['x-vqs-message-attempt']), 10);
          const override = await respond(attempt);
          if (override) {
            res.statusCode = override.status;
            res.setHeader('content-type', 'application/json');
            res.end(override.body ?? '{}');
            return;
          }

          const headers = new Headers();
          for (const [key, value] of Object.entries(req.headers)) {
            if (typeof value === 'string') headers.set(key, value);
          }
          const handlerQueue = queues.at(-1);
          if (!handlerQueue) {
            res.statusCode = 500;
            res.end('{}');
            return;
          }
          const handler = handlerQueue.createQueueHandler('__wkf_workflow_', async (body, meta) => {
            received.push({ body: body as QueuePayload, attempt: meta.attempt });
          });
          const response = await handler(
            new Request(`http://127.0.0.1${req.url}`, { method: 'POST', headers, body: data }),
          );
          res.statusCode = response.status;
          res.setHeader('content-type', 'application/json');
          res.end(await response.text());
        })();
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 120_000);

  afterEach(async () => {
    await Promise.all(queues.map((q) => q.stop()));
    queues.length = 0;
    received.length = 0;
    respond = () => undefined;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    await redis.quit();
    await container.stop();
  });

  const queueName = '__wkf_workflow_test' as ValidQueueName;
  const payload: QueuePayload = { runId: 'wrun_queue_test' };

  it('delivers an immediate message and round-trips Uint8Array payloads', async () => {
    const q = makeQueue();
    await q.start();

    const input = new Uint8Array([1, 2, 3, 250]);
    await q.queue(queueName, {
      runId: 'wrun_binary',
      runInput: {
        input,
        deploymentId: 'redis',
        workflowName: 'wf',
        specVersion: 3,
      },
    });

    await vi.waitFor(() => expect(received).toHaveLength(1), { timeout: 10_000 });
    const message = received[0].body;
    if (!('runId' in message) || !message.runInput) {
      throw new Error('expected a workflow payload with runInput');
    }
    expect(message.runInput.input).toBeInstanceOf(Uint8Array);
    expect(Array.from(message.runInput.input as Uint8Array)).toEqual([1, 2, 3, 250]);
  }, 30_000);

  it('parks delaySeconds messages durably and delivers them after a restart', async () => {
    const jobPrefix = `qtestdurable_${Date.now()}_`;
    const producer = createQueue(redis, {
      redis: '',
      jobPrefix,
      baseUrl,
    });
    queues.push(producer);

    // Enqueue with a delay but NEVER start this instance; the message must
    // be durable in Redis, not held by an in-process timer.
    await producer.queue(queueName, payload, { delaySeconds: 1 });
    const delayed = await redis.zcard(`${jobPrefix}flows:delayed`);
    expect(delayed).toBe(1);
    expect(received).toHaveLength(0);

    // A fresh instance (a "restarted process") picks it up.
    const consumer = makeQueueSharingPrefix({ jobPrefix });
    await consumer.start();

    await vi.waitFor(() => expect(received).toHaveLength(1), { timeout: 10_000 });
    expect(await redis.zcard(`${jobPrefix}flows:delayed`)).toBe(0);
  }, 30_000);

  it('defers 503 { timeoutSeconds } responses via the delayed set without consuming attempts', async () => {
    let calls = 0;
    respond = () => {
      calls += 1;
      if (calls === 1) {
        return { status: 503, body: JSON.stringify({ timeoutSeconds: 1 }) };
      }
      return undefined;
    };

    const q = makeQueue();
    await q.start();
    await q.queue(queueName, payload);

    await vi.waitFor(() => expect(received).toHaveLength(1), { timeout: 15_000 });
    // Soft retry must not increment the attempt counter
    expect(received[0].attempt).toBe(1);
  }, 30_000);

  it('retries hard failures with backoff and increments attempts', async () => {
    respond = (attempt) => (attempt < 3 ? { status: 500, body: '{}' } : undefined);

    const q = makeQueue();
    await q.start();
    await q.queue(queueName, payload);

    await vi.waitFor(() => expect(received).toHaveLength(1), { timeout: 15_000 });
    expect(received[0].attempt).toBe(3);
  }, 30_000);

  it('deduplicates by idempotency key and releases the key after success', async () => {
    const q = makeQueue();
    await q.start();

    await q.queue(queueName, payload, { idempotencyKey: 'step-abc' });
    await q.queue(queueName, payload, { idempotencyKey: 'step-abc' });

    await vi.waitFor(() => expect(received).toHaveLength(1), { timeout: 10_000 });
    // Give the duplicate a moment to (incorrectly) arrive if dedup failed
    await new Promise((resolve) => global.setTimeout(resolve, 500));
    expect(received).toHaveLength(1);

    // After successful completion the reservation is released, so the same
    // key can be enqueued again.
    await vi.waitFor(
      async () => {
        await q.queue(queueName, payload, { idempotencyKey: 'step-abc' });
        expect(received.length).toBeGreaterThanOrEqual(2);
      },
      { timeout: 10_000 },
    );
  }, 30_000);

  it('reclaims messages stranded in a dead worker processing list', async () => {
    const jobPrefix = `qtestreclaim_${Date.now()}_`;

    // Simulate a worker that crashed between BLMOVE and dispatch: the
    // envelope sits in its processing list and its owner heartbeat is gone.
    const envelope = {
      messageId: 'msg_dead',
      queueName,
      attempt: 1,
      message: payload,
    };
    await redis.lpush(
      `${jobPrefix}flows:processing:dead-host-1-abc`,
      stringifyWithUint8Array(envelope),
    );

    const q = makeQueueSharingPrefix({ jobPrefix });
    await q.start();

    await vi.waitFor(() => expect(received).toHaveLength(1), { timeout: 15_000 });
    expect(await redis.llen(`${jobPrefix}flows:processing:dead-host-1-abc`)).toBe(0);
  }, 30_000);

  /**
   * Stalls worker A mid-dispatch, expires its owner key, and lets worker B
   * reclaim and hold the redelivery, then settles A with `staleResult`.
   */
  async function reclaimWhileStalled(staleResult: { status: number; body?: string }) {
    const jobPrefix = `qtestfence_${Date.now()}_`;
    const settlers: ((result: { status: number; body?: string }) => void)[] = [];
    respond = () => new Promise((resolve) => settlers.push(resolve));
    const config = { redis: '', jobPrefix, queueConcurrency: 1, baseUrl };
    // A huge TTL means A only writes its owner key at the top of each loop.
    const a = createQueue(redis, { ...config, heartbeatTtlMs: 3_000_000 });
    queues.push(a);
    await a.start();
    await a.queue(queueName, payload, { idempotencyKey: 'fenced' });
    await vi.waitFor(() => expect(settlers).toHaveLength(1), { timeout: 10_000 });

    const owners = await redis.keys(`${jobPrefix}flows:processing:*:owner`);
    expect(owners).toHaveLength(1);
    const ownerKey = owners[0];
    await redis.del(ownerKey);

    const b = createQueue(redis, config);
    queues.push(b);
    await b.start();
    await vi.waitFor(() => expect(settlers).toHaveLength(2), { timeout: 10_000 });

    settlers[0](staleResult);
    // A rewrites its owner key only after the settle call returns.
    await vi.waitFor(async () => expect(await redis.exists(ownerKey)).toBe(1), { timeout: 10_000 });
    return { jobPrefix, settlers, settleRedelivery: settlers[1] };
  }

  it('ignores a stale ack after its message was reclaimed', async () => {
    const { jobPrefix, settlers, settleRedelivery } = await reclaimWhileStalled({
      status: 200,
      body: '{}',
    });
    const reservation = `${jobPrefix}flows:idempotent:fenced`;
    // The redelivery still runs, so the key stays reserved and dedups.
    expect(await redis.exists(reservation)).toBe(1);
    await queues[0].queue(queueName, payload, { idempotencyKey: 'fenced' });
    await new Promise((resolve) => global.setTimeout(resolve, 500));
    expect(settlers).toHaveLength(2);

    settleRedelivery({ status: 200, body: '{}' });
    await vi.waitFor(async () => expect(await redis.exists(reservation)).toBe(0), {
      timeout: 10_000,
    });
  }, 30_000);

  it('ignores a stale defer after its message was reclaimed', async () => {
    const { jobPrefix, settlers, settleRedelivery } = await reclaimWhileStalled({
      status: 503,
      body: JSON.stringify({ timeoutSeconds: 60 }),
    });
    const delayed = `${jobPrefix}flows:delayed`;
    expect(await redis.zcard(delayed)).toBe(0);
    await new Promise((resolve) => global.setTimeout(resolve, 500));
    expect(settlers).toHaveLength(2);

    settleRedelivery({ status: 503, body: JSON.stringify({ timeoutSeconds: 60 }) });
    await vi.waitFor(async () => expect(await redis.zcard(delayed)).toBe(1), { timeout: 10_000 });
  }, 30_000);
});

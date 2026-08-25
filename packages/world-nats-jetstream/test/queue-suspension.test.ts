import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import type { Queue } from '@workflow/world';
import { ValidQueueName } from '@workflow/world';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { createWorld } from '../src/index.js';

const asQueueMessage = (message: unknown) => message as Parameters<Queue['queue']>[1];

/** What the fake workflow handler should do with a given delivery. */
type Reply = { kind: 'suspend'; timeoutSeconds: number } | { kind: 'fail' } | { kind: 'ok' };

/**
 * `{ timeoutSeconds }` is core's control-flow signal (sleep(), step retry
 * backoff, TooEarlyError, and `{ timeoutSeconds: 0 }` re-invocations from the
 * stateUpdatedAt guard), not a failed delivery. JetStream's only durable
 * redelivery timer is `nak(delay)`, which always increments `num_delivered`, so
 * the world has to subtract suspensions back out before reporting `attempt`.
 * Otherwise a run that merely suspends often enough trips core's
 * MAX_QUEUE_DELIVERIES (48) cap and is killed as a runaway.
 */
describe('Queue suspensions vs failed deliveries (NATS JetStream integration)', () => {
  if (process.platform === 'win32') {
    test.skip('skipped on Windows since it relies on a docker container', () => {});
    return;
  }

  let container: StartedTestContainer;
  let world: ReturnType<typeof createWorld>;
  let server: Server;

  /** The attempt each delivery reported, in order. */
  let attempts: number[] = [];
  /** Per-test policy: decide the reply for the Nth (1-based) delivery. */
  let policy: (delivery: number) => Reply = () => ({ kind: 'ok' });
  let queueCounter = 0;

  beforeAll(async () => {
    container = await new GenericContainer('nats:2.10-alpine')
      .withExposedPorts(4222)
      .withCommand(['-js'])
      .start();

    server = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        attempts.push(Number(req.headers['x-vqs-message-attempt']));
        const reply = policy(attempts.length);
        if (reply.kind === 'suspend') {
          res.writeHead(503, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ timeoutSeconds: reply.timeoutSeconds }));
        } else if (reply.kind === 'fail') {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'transient failure' }));
        } else {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as AddressInfo).port;

    world = createWorld({
      nats: `${container.getHost()}:${container.getMappedPort(4222)}`,
      keyPrefix: 'susp_',
      jobPrefix: 'susp_',
      baseUrl: `http://localhost:${port}`,
    });
    await world.start();
  }, 180_000);

  afterAll(async () => {
    await world?.close();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    await container?.stop();
  });

  beforeEach(() => {
    attempts = [];
  });

  /** Each test needs its own queue id so deliveries never interleave. */
  function nextQueueName(): ValidQueueName {
    queueCounter += 1;
    return ValidQueueName.parse(`__wkf_step_susp-${queueCounter}`);
  }

  async function waitForDeliveries(count: number) {
    await vi.waitFor(() => expect(attempts.length).toBeGreaterThanOrEqual(count), {
      timeout: 60_000,
      interval: 100,
    });
  }

  test('keeps attempt flat across repeated suspensions', async () => {
    const suspensions = 12;
    policy = (n) => (n <= suspensions ? { kind: 'suspend', timeoutSeconds: 0 } : { kind: 'ok' });

    await world.queue(nextQueueName(), asQueueMessage({ hello: 'world' }));
    await waitForDeliveries(suspensions + 1);

    // Every delivery here is a suspension, so nothing has actually failed.
    // Before the fix this read [1, 2, 3, ... 13].
    expect(attempts.slice(0, suspensions + 1)).toEqual(Array(suspensions + 1).fill(1));
  }, 120_000);

  test('still counts genuine failed deliveries', async () => {
    policy = (n) => (n <= 2 ? { kind: 'fail' } : { kind: 'ok' });

    await world.queue(nextQueueName(), asQueueMessage({ hello: 'world' }));
    await waitForDeliveries(3);

    // Hard failures must keep climbing so core's poison-pill escalation fires.
    expect(attempts.slice(0, 3)).toEqual([1, 2, 3]);
  }, 120_000);

  test('counts only the failures when suspensions and failures interleave', async () => {
    // fail, suspend, fail, suspend, then succeed.
    const script: Reply[] = [
      { kind: 'fail' },
      { kind: 'suspend', timeoutSeconds: 0 },
      { kind: 'fail' },
      { kind: 'suspend', timeoutSeconds: 0 },
      { kind: 'ok' },
    ];
    policy = (n) => script[n - 1] ?? { kind: 'ok' };

    await world.queue(nextQueueName(), asQueueMessage({ hello: 'world' }));
    await waitForDeliveries(5);

    // Delivery 1 is the first attempt; the two failures advance it to 2 then 3,
    // and the suspensions in between leave it where it was.
    expect(attempts.slice(0, 5)).toEqual([1, 2, 2, 3, 3]);
  }, 120_000);
});

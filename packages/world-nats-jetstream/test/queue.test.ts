import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { ValidQueueName } from '@workflow/world';
import { afterAll, beforeAll, describe, expect, it, test, vi } from 'vitest';
import { createWorld } from '../src/index.js';

describe('Queue (NATS JetStream integration)', () => {
  if (process.platform === 'win32') {
    test.skip('skipped on Windows since it relies on a docker container', () => {});
    return;
  }

  let container: StartedTestContainer;
  let world: ReturnType<typeof createWorld>;
  let server: Server;

  const received: { attempt: number; queueName: string }[] = [];

  beforeAll(async () => {
    container = await new GenericContainer('nats:2.10-alpine')
      .withExposedPorts(4222)
      .withCommand(['-js'])
      .start();

    server = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        received.push({
          attempt: Number(req.headers['x-vqs-message-attempt']),
          queueName: String(req.headers['x-vqs-queue-name']),
        });
        // Fail the first delivery so JetStream redelivers; succeed after.
        if (received.length === 1) {
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

    const host = container.getHost();
    const natsPort = container.getMappedPort(4222);
    world = createWorld({
      nats: `${host}:${natsPort}`,
      keyPrefix: 'qtest_',
      jobPrefix: 'qtest_',
      baseUrl: `http://localhost:${port}`,
    });
    await world.start();
  }, 120_000);

  afterAll(async () => {
    await world?.close();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    await container?.stop();
  });

  it('derives the attempt header from JetStream delivery count and redelivers after nak backoff', async () => {
    const queueName = ValidQueueName.parse('__wkf_step_attempt-demo');
    await world.queue(queueName, { hello: 'world' });

    // First delivery fails (500) -> nak with 5s backoff -> redelivery.
    await vi.waitFor(() => expect(received.length).toBeGreaterThanOrEqual(2), {
      timeout: 30_000,
      interval: 250,
    });

    expect(received[0]).toEqual({ attempt: 1, queueName });
    expect(received[1]).toEqual({ attempt: 2, queueName });
  }, 60_000);
});

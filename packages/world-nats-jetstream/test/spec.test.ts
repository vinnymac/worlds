import { GenericContainer, Wait } from 'testcontainers';
import { createTestSuite } from '@workflow/world-testing';
// `eventLimit` ships in world-testing 4.1.18 but is deliberately not part of
// `createTestSuite`; opting in via the deep import is the only way to gate the
// `EventResult.maxEvents` contract. The package publishes no `exports` map, so
// the dist path is the public entry point for it.
import { eventLimit } from '@workflow/world-testing/dist/src/event-limit.mjs';
import { afterAll, beforeAll, test } from 'vitest';

// Skip these tests on Windows since it relies on a docker container
if (process.platform === 'win32') {
  test.skip('skipped on Windows since it relies on a docker container', () => {});
} else {
  let container: Awaited<ReturnType<GenericContainer['start']>>;

  beforeAll(async () => {
    container = await new GenericContainer('nats:2.10-alpine')
      .withCommand(['-js', '-m', '8222'])
      .withExposedPorts(4222, 8222)
      .withWaitStrategy(Wait.forLogMessage('Server is ready'))
      .start();

    const host = container.getHost();
    const port = container.getMappedPort(4222);
    const natsUrl = `nats://${host}:${port}`;

    process.env.WORKFLOW_NATS_URL = natsUrl;
    process.env.NATS_URL = natsUrl;

    console.log('[test beforeAll] NATS container started');
    console.log('[test beforeAll] host=', host, 'port=', port);
    console.log('[test beforeAll] natsUrl=', natsUrl);
    console.log('[test beforeAll] process.env.PORT=', process.env.PORT);
  }, 120_000);

  afterAll(async () => {
    if (container) {
      await container.stop();
    }
  });

  test('smoke', () => {});
  createTestSuite('@fantasticfour/world-nats-jetstream');
  eventLimit('@fantasticfour/world-nats-jetstream');
}

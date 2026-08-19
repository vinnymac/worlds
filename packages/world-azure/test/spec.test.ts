import { createTestSuite } from '@workflow/world-testing';
// Opt-in suite: `eventLimit` is not in createTestSuite and the package has no
// exports map, so the deep import is the only way in.
import { eventLimit } from '@workflow/world-testing/dist/src/event-limit.mjs';
import { afterAll, beforeAll, describe, test } from 'vitest';

// Using official @testcontainers/azure-cosmosdb-emulator module
// Provides optimized configuration and wait strategies for the Cosmos DB Linux emulator
// Note: The emulator is large (~2GB) and slow to start (2-5 minutes)
if (process.platform === 'win32') {
  test.skip('skipped on Windows since it relies on a docker container', () => {});
} else {
  let container: import('@testcontainers/azure-cosmosdb-emulator').StartedAzureCosmosDbEmulatorContainer;

  beforeAll(async () => {
    const { AzureCosmosDbEmulatorContainer } =
      await import('@testcontainers/azure-cosmosdb-emulator');

    // Start Cosmos DB Linux emulator using official testcontainer
    // The module handles proper configuration, wait strategies, and port binding
    container = await new AzureCosmosDbEmulatorContainer(
      'mcr.microsoft.com/cosmosdb/linux/azure-cosmos-emulator:vnext-preview',
    ).start();

    const endpoint = container.getEndpoint();
    const emulatorKey = container.getKey();

    // Set environment variables for the world factory
    process.env.COSMOS_ENDPOINT = endpoint;
    process.env.COSMOS_KEY = emulatorKey;
    process.env.COSMOS_DATABASE = 'workflow-test';

    // Ensure no Service Bus connection (forces embedded mode)
    delete process.env.SERVICE_BUS_CONNECTION_STRING;

    console.log('[test beforeAll] Cosmos DB emulator container started');
    console.log('[test beforeAll] endpoint=', endpoint);
  }, 420_000); // 7 minute timeout - emulator can take 5+ minutes to start

  afterAll(async () => {
    if (container) {
      await container.stop();
    }
  });

  test('smoke', () => {});

  // Wrap createTestSuite in a describe block with extended timeout
  describe('@fantasticfour/world-azure spec tests', { timeout: 120_000 }, () => {
    createTestSuite('@fantasticfour/world-azure');
    eventLimit('@fantasticfour/world-azure');
  });
}

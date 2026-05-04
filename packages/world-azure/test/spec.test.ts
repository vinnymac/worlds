import { createTestSuite } from '@workflow/world-testing';
import { afterAll, beforeAll, describe, test } from 'vitest';

// The Cosmos DB emulator is large (~2GB) and slow to start (2-5 minutes).
// For CI, we use the Azure Cosmos DB Linux emulator container.
// Skip tests on Windows (no Linux container support without WSL2 Docker).
if (process.platform === 'win32') {
  test.skip('skipped on Windows since it relies on a docker container', () => {});
} else {
  let container: import('testcontainers').StartedTestContainer;

  beforeAll(async () => {
    const { GenericContainer, Wait } = await import('testcontainers');

    // Start Cosmos DB Linux emulator
    // Uses the official Microsoft Azure Cosmos DB emulator for Linux
    // Note: Using :vnext-preview tag for ARM64 support (Apple Silicon + newer CI runners)
    container = await new GenericContainer(
      'mcr.microsoft.com/cosmosdb/linux/azure-cosmos-emulator:vnext-preview'
    )
      .withExposedPorts(8081, 10251, 10252, 10253, 10254)
      .withEnvironment({
        AZURE_COSMOS_EMULATOR_PARTITION_COUNT: '10',
        AZURE_COSMOS_EMULATOR_ENABLE_DATA_PERSISTENCE: 'false',
      })
      .withWaitStrategy(Wait.forListeningPorts())
      .withStartupTimeout(300_000) // 5 minutes for emulator startup
      .start();

    // Add 1-second delay for SSL initialization stability
    await new Promise((resolve) => setTimeout(resolve, 1000));

    const endpoint = `https://${container.getHost()}:${container.getMappedPort(8081)}/`;

    // The emulator uses a well-known key
    const emulatorKey =
      'C2y6yDjf5/R+ob0N8A7Cgv30VRDJIWEHLM+4QDU5DE2nQ9nDuVTqobD4b8mGGyPMbIZnqyMsEcaGQy67XIw/Jw==';

    // Set environment variables for the world factory
    process.env.COSMOS_ENDPOINT = endpoint;
    process.env.COSMOS_KEY = emulatorKey;
    process.env.COSMOS_DATABASE = 'workflow-test';

    // Ensure no Service Bus connection (forces embedded mode)
    delete process.env.SERVICE_BUS_CONNECTION_STRING;

    console.log('[test beforeAll] Cosmos DB emulator container started');
    console.log('[test beforeAll] endpoint=', endpoint);
  }, 300_000); // 5 minute timeout for emulator startup

  afterAll(async () => {
    if (container) {
      await container.stop();
    }
  });

  test('smoke', () => {});

  // Wrap createTestSuite in a describe block with extended timeout
  describe(
    '@fantasticfour/world-azure spec tests',
    () => {
      createTestSuite('@fantasticfour/world-azure');
    },
    { timeout: 120_000 }
  );
}

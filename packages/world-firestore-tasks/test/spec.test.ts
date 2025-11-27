import { Firestore } from '@google-cloud/firestore';
import type { StartedFirestoreEmulatorContainer } from '@testcontainers/gcloud';
import { FirestoreEmulatorContainer } from '@testcontainers/gcloud';
import { createTestSuite } from '@workflow/world-testing';
import { afterAll, beforeAll, test } from 'vitest';

// Skip these tests on Windows since it relies on a docker container
if (process.platform === 'win32') {
  test.skip('skipped on Windows since it relies on a docker container', () => {});
} else {
  let container: StartedFirestoreEmulatorContainer;
  let firestore: Firestore;

  beforeAll(async () => {
    // Use official FirestoreEmulatorContainer API
    container = await new FirestoreEmulatorContainer(
      'gcr.io/google.com/cloudsdktool/google-cloud-cli:441.0.0-emulators'
    ).start();

    const emulatorHost = container.getEmulatorEndpoint();
    process.env.FIRESTORE_EMULATOR_HOST = emulatorHost;
    process.env.FIRESTORE_PROJECT_ID = 'test-project';

    // Remove Cloud Tasks specific environment variables
    delete process.env.CLOUD_TASKS_EMULATOR_HOST;
    delete process.env.CLOUD_TASKS_PROJECT_ID;
    delete process.env.CLOUD_TASKS_LOCATION;
    delete process.env.CLOUD_TASKS_QUEUE;
    delete process.env.CLOUD_TASKS_TARGET_URL;

    console.log('[test beforeAll] Firestore emulator container started');
    console.log('[test beforeAll] emulatorHost=', emulatorHost);

    firestore = new Firestore({
      projectId: 'test-project',
      host: emulatorHost,
      ssl: false,
      customHeaders: {
        Authorization: 'Bearer owner',
      },
    });
    firestore.settings({
      ignoreUndefinedProperties: true,
    });
  }, 120_000); // 2 minute timeout for consistency with other worlds

  afterAll(async () => {
    if (container) {
      await container.stop();
    }
  });

  test('smoke', () => {});

  createTestSuite('@fantasticfour/world-firestore-tasks');
}

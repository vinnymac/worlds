import { Firestore } from '@google-cloud/firestore';
import type { StartedFirestoreEmulatorContainer } from '@testcontainers/gcloud';
import { FirestoreEmulatorContainer } from '@testcontainers/gcloud';
import { createTestSuite } from '@workflow/world-testing';
// Opt-in suite: world-testing 4.1.18 ships `eventLimit` but does not include it
// in createTestSuite, and the package has no exports map — deep import is the
// only way in. It asserts the world reports EventResult.maxEvents on
// run_started and honours WORKFLOW_MAX_EVENTS.
import { eventLimit } from '@workflow/world-testing/dist/src/event-limit.mjs';
import { afterAll, beforeAll, describe, test } from 'vitest';

// Skip these tests on Windows since it relies on a docker container
if (process.platform === 'win32') {
  test.skip('skipped on Windows since it relies on a docker container', () => {});
} else {
  let container: StartedFirestoreEmulatorContainer;
  let firestore: Firestore;

  beforeAll(async () => {
    // Use official FirestoreEmulatorContainer API
    container = await new FirestoreEmulatorContainer(
      'gcr.io/google.com/cloudsdktool/google-cloud-cli:441.0.0-emulators',
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

  // Wrap createTestSuite in a describe block with extended timeout
  // to handle slow CI environments (especially Firestore emulator)
  describe('@fantasticfour/world-firestore-tasks spec tests', { timeout: 120_000 }, () => {
    createTestSuite('@fantasticfour/world-firestore-tasks');
    eventLimit('@fantasticfour/world-firestore-tasks');
  });
}

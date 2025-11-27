import type { Firestore } from '@google-cloud/firestore';
import { Firestore as FirestoreClass } from '@google-cloud/firestore';
import type { CloudTasksClient } from '@google-cloud/tasks';
import { CloudTasksClient as CloudTasksClientClass } from '@google-cloud/tasks';
import type { World } from '@workflow/world';
import { createQueue } from './queue.js';
import { createStorage } from './storage.js';
import { createStreamer } from './streamer.js';

export interface FirestoreTasksWorldConfig {
  firestore?: Firestore;
  tasksClient?: CloudTasksClient;
  project?: string;
  location?: string;
  queueName?: string;
  targetUrl?: string;
  deploymentId?: string;
}

export function createFirestoreTasksWorld(
  config: FirestoreTasksWorldConfig = {}
): World & { start(): Promise<void> } {
  // Use provided config or fall back to environment variables
  const projectId =
    config.project ||
    process.env.FIRESTORE_PROJECT_ID ||
    process.env.GCP_PROJECT ||
    'test-project';
  const locationId =
    config.location || process.env.CLOUD_TASKS_LOCATION || 'us-central1';
  const queueId =
    config.queueName || process.env.CLOUD_TASKS_QUEUE || 'workflow-queue';
  const target =
    config.targetUrl ||
    process.env.CLOUD_TASKS_TARGET_URL ||
    'http://localhost:3000';
  const deploymentId =
    config.deploymentId ||
    process.env.WORKFLOW_DEPLOYMENT_ID ||
    'firestore-tasks-default';

  // Initialize Firestore if not provided
  const firestoreInstance =
    config.firestore ||
    new FirestoreClass({
      projectId,
      ignoreUndefinedProperties: true, // Required for handling discriminated unions with optional fields
      ...(process.env.FIRESTORE_EMULATOR_HOST
        ? {
            host: process.env.FIRESTORE_EMULATOR_HOST,
            ssl: false,
            customHeaders: {
              Authorization: 'Bearer owner',
            },
          }
        : {}),
    });

  // Initialize Cloud Tasks client if not provided
  let tasksClientInstance: CloudTasksClient | undefined;
  if (config.tasksClient) {
    tasksClientInstance = config.tasksClient;
  } else if (process.env.CLOUD_TASKS_EMULATOR_HOST) {
    tasksClientInstance = new CloudTasksClientClass({
      projectId,
      apiEndpoint: process.env.CLOUD_TASKS_EMULATOR_HOST,
    });
  }

  const storage = createStorage({
    firestore: firestoreInstance,
    deploymentId,
  });

  const queue = createQueue({
    client: tasksClientInstance,
    project: projectId,
    location: locationId,
    queueName: queueId,
    targetUrl: target,
    deploymentId,
  });

  const streamer = createStreamer({
    firestore: firestoreInstance,
  });

  return {
    ...storage,
    ...queue,
    ...streamer,
    async start() {
      // Explicitly call queue.start() to ensure embedded world starts in test mode
      if (queue.start) {
        await queue.start();
      }
    },
  };
}

// Export createWorld as an alias for compatibility with @workflow/world
export { createFirestoreTasksWorld as createWorld };

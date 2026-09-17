import type { Firestore } from '@google-cloud/firestore';
import { Firestore as FirestoreClass } from '@google-cloud/firestore';
import type { CloudTasksClient } from '@google-cloud/tasks';
import { CloudTasksClient as CloudTasksClientClass } from '@google-cloud/tasks';
import type { World } from '@workflow/world';
import { SPEC_VERSION_CURRENT } from '@workflow/world';
import { createQueue } from './queue.js';
import { createStorage } from './storage.js';
import { createStreamer } from './streamer.js';
export type { FirestoreStreamerConfig } from './streamer.js';

export interface FirestoreTasksWorldConfig {
  firestore?: Firestore;
  tasksClient?: CloudTasksClient;
  project?: string;
  location?: string;
  queueName?: string;
  targetUrl?: string;
  deploymentId?: string;
  /**
   * Streaming strategy for readFromStream:
   * - 'listener' (default): Firestore real-time listeners (lowest latency, higher cost)
   * - 'polling': Periodic polling (higher latency, lower cost)
   */
  streamerMode?: 'listener' | 'polling';
  /**
   * Polling interval (ms) when streamerMode is 'polling'. Default: 1000
   */
  streamerPollIntervalMs?: number;
  /** Per-run event ceiling reported on `run_started`
   * (`EventResult.maxEvents`). Defaults to `WORKFLOW_MAX_EVENTS`, then 25,000. */
  maxEventsPerRun?: number;
  /**
   * How long Cloud Tasks waits for a task's response (ms) before failing the
   * attempt and retrying it while the first request may still run. Integer in
   * [15_000, 1_800_000], else construction throws. Cloud Tasks only; the test
   * pump keeps its 300_000 HTTP timeout. Default: Cloud Tasks' own, 600_000 (10 minutes)
   */
  dispatchDeadlineMs?: number;
}

export function createFirestoreTasksWorld(
  config: FirestoreTasksWorldConfig = {},
): World & { start(): Promise<void> } {
  // Use provided config or fall back to environment variables
  const projectId =
    config.project || process.env.FIRESTORE_PROJECT_ID || process.env.GCP_PROJECT || 'test-project';
  const locationId = config.location || process.env.CLOUD_TASKS_LOCATION || 'us-central1';
  const queueId = config.queueName || process.env.CLOUD_TASKS_QUEUE || 'workflow-queue';
  const target = config.targetUrl || process.env.CLOUD_TASKS_TARGET_URL || 'http://localhost:3000';
  const deploymentId =
    config.deploymentId || process.env.WORKFLOW_DEPLOYMENT_ID || 'firestore-tasks-default';

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
    maxEventsPerRun: config.maxEventsPerRun,
  });

  const queue = createQueue({
    client: tasksClientInstance,
    firestore: firestoreInstance,
    project: projectId,
    location: locationId,
    queueName: queueId,
    targetUrl: target,
    deploymentId,
    dispatchDeadlineMs: config.dispatchDeadlineMs,
  });

  const streamer = createStreamer({
    firestore: firestoreInstance,
    mode: config.streamerMode,
    pollIntervalMs: config.streamerPollIntervalMs,
  });

  return {
    ...storage,
    ...queue,
    ...streamer,
    // Declaring the current spec version enables resilient start: core
    // attaches runInput to workflow queue messages so run_started can
    // bootstrap the run when run_created lost the race. Requires the
    // binary-safe (tagged-JSON) queue transport in queue.ts.
    specVersion: SPEC_VERSION_CURRENT,
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

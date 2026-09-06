import { SPEC_VERSION_CURRENT, type World } from '@workflow/world';
import { type CloudflareQueueConfig, createQueue } from './queue.js';
import { type CloudflareStorageConfig, createStorage } from './storage.js';
import { type CloudflareStreamerConfig, createStreamer } from './streamer.js';

export interface CloudflareWorldConfig {
  env?: {
    WORKFLOW_DB: CloudflareStorageConfig['env']['WORKFLOW_DB'] &
      CloudflareQueueConfig['env']['WORKFLOW_DB'];
    WORKFLOW_INDEX: CloudflareStorageConfig['env']['WORKFLOW_INDEX'];
    WORKFLOW_QUEUE: CloudflareQueueConfig['env']['WORKFLOW_QUEUE'];
    WORKFLOW_STREAMS: CloudflareStreamerConfig['env']['WORKFLOW_STREAMS'];
  };
  deploymentId?: string;
  /** Per-run event ceiling reported on `run_started`
   * (`EventResult.maxEvents`). Defaults to `WORKFLOW_MAX_EVENTS`, then 25,000. */
  maxEventsPerRun?: CloudflareStorageConfig['maxEventsPerRun'];
}

export function createWorld(config?: CloudflareWorldConfig): World {
  // Check for global test environment first (for @workflow/world-testing)
  let env = config?.env;
  if (!env) {
    const globalEnv = (globalThis as { CLOUDFLARE_ENV?: CloudflareWorldConfig['env'] })
      .CLOUDFLARE_ENV;
    if (globalEnv) {
      env = globalEnv;
    }
  }

  if (!env) {
    throw new Error(
      'Cloudflare environment not configured. ' +
        'Must provide config.env with WORKFLOW_DB, WORKFLOW_INDEX, WORKFLOW_QUEUE, WORKFLOW_STREAMS',
    );
  }

  const deploymentId =
    config?.deploymentId || process.env.CLOUDFLARE_DEPLOYMENT_ID || 'cloudflare-default';

  const storage = createStorage({
    env: {
      WORKFLOW_DB: env.WORKFLOW_DB,
      WORKFLOW_INDEX: env.WORKFLOW_INDEX,
    },
    deploymentId,
    maxEventsPerRun: config?.maxEventsPerRun,
  });

  const queue = createQueue({
    env: {
      WORKFLOW_QUEUE: env.WORKFLOW_QUEUE,
      WORKFLOW_DB: env.WORKFLOW_DB,
    },
    deploymentId,
  });

  const streamer = createStreamer({
    env: {
      WORKFLOW_STREAMS: env.WORKFLOW_STREAMS,
    },
  });

  return {
    ...storage,
    ...queue,
    ...streamer,
    // Event ids are slot-numbered and allocated at the commit inside the DO
    // storage transaction, so this world is current-spec compliant by
    // construction (no pre-assigned positions, no noop sealing needed).
    specVersion: SPEC_VERSION_CURRENT,
  };
}

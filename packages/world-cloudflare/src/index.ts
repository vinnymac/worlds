import type { World } from '@workflow/world';
import { type CloudflareQueueConfig, createQueue } from './queue.js';
import { type CloudflareStorageConfig, createStorage } from './storage.js';
import { type CloudflareStreamerConfig, createStreamer } from './streamer.js';

export interface CloudflareWorldConfig {
  env?: {
    WORKFLOW_DB: CloudflareStorageConfig['env']['WORKFLOW_DB'];
    WORKFLOW_INDEX: CloudflareStorageConfig['env']['WORKFLOW_INDEX'];
    WORKFLOW_QUEUE: CloudflareQueueConfig['env']['WORKFLOW_QUEUE'];
    WORKFLOW_STREAMS: CloudflareStreamerConfig['env']['WORKFLOW_STREAMS'];
  };
  deploymentId?: string;
}

export function createCloudflareWorld(config?: CloudflareWorldConfig): World {
  // Check for global test environment first (for @workflow/world-testing)
  let env = config?.env;
  if (!env && (globalThis as any).CLOUDFLARE_ENV) {
    env = (globalThis as any).CLOUDFLARE_ENV;
  }

  if (!env) {
    throw new Error(
      'Cloudflare environment not configured. ' +
        'Must provide config.env with WORKFLOW_DB, WORKFLOW_INDEX, WORKFLOW_QUEUE, WORKFLOW_STREAMS'
    );
  }

  const deploymentId =
    config?.deploymentId ||
    process.env.CLOUDFLARE_DEPLOYMENT_ID ||
    'cloudflare-default';

  const storage = createStorage({
    env: {
      WORKFLOW_DB: env.WORKFLOW_DB,
      WORKFLOW_INDEX: env.WORKFLOW_INDEX,
    },
    deploymentId,
  });

  const queue = createQueue({
    env: {
      WORKFLOW_QUEUE: env.WORKFLOW_QUEUE,
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
  };
}

// Export createWorld as an alias for compatibility with @workflow/world
export { createCloudflareWorld as createWorld };

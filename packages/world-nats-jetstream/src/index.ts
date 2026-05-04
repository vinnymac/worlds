import type { Storage, World } from '@workflow/world';
import { connect, type NatsConnection, type JetStreamClient } from 'nats';
import type { NatsJetStreamWorldConfig } from './config.js';
import { createQueue } from './queue.js';
import {
  createEventsStorage,
  createHooksStorage,
  createRunsStorage,
  createStepsStorage,
} from './storage.js';
import { createStreamer } from './streamer.js';

function createStorage(
  getJetStream: () => Promise<JetStreamClient>,
  keyPrefix: string
): Storage {
  const config = { getJetStream, keyPrefix };
  return {
    runs: createRunsStorage(config),
    events: createEventsStorage(config),
    hooks: createHooksStorage(config),
    steps: createStepsStorage(config),
  };
}

export function createWorld(
  config: NatsJetStreamWorldConfig = {
    nats:
      process.env.WORKFLOW_NATS_URL ||
      process.env.NATS_URL ||
      'nats://localhost:4222',
    jobPrefix: process.env.WORKFLOW_NATS_JOB_PREFIX,
    queueConcurrency:
      Number.parseInt(
        process.env.WORKFLOW_NATS_WORKER_CONCURRENCY || '10',
        10
      ) || 10,
    keyPrefix: process.env.WORKFLOW_NATS_KEY_PREFIX || 'workflow_',
  }
): World & { start(): Promise<void>; close(): Promise<void> } {
  let nc: NatsConnection | undefined;
  let jetstream: JetStreamClient | undefined;
  let connectionPromise: Promise<NatsConnection> | undefined;

  const getJetStream = async (): Promise<JetStreamClient> => {
    if (!jetstream) {
      // Lazy connection - only connect on first access
      if (!connectionPromise) {
        connectionPromise =
          typeof config.nats === 'string'
            ? connect({ servers: config.nats })
            : connect(config.nats);
      }
      nc = await connectionPromise;
      jetstream = nc.jetstream();
    }
    return jetstream;
  };

  const keyPrefix = config.keyPrefix || 'workflow_';

  const storage = createStorage(getJetStream, keyPrefix);
  const streamer = createStreamer({ getJetStream, keyPrefix });
  const queue = createQueue(getJetStream, config);

  return {
    ...storage,
    ...streamer,
    ...queue,
    async start() {
      // Ensure connection is established
      await getJetStream();
      await queue.start();
    },
    async close() {
      if (nc) {
        await nc.drain();
        await nc.close();
      }
    },
  };
}

// Re-export config for users
export type { NatsJetStreamWorldConfig } from './config.js';

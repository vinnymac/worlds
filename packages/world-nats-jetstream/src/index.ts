import { mintedSpecVersion, type SpecVersion, type Storage, type World } from '@workflow/world';
import { connect, type NatsConnection } from '@nats-io/transport-node';
import { jetstream, type JetStreamClient } from '@nats-io/jetstream';
import type { NatsJetStreamWorldConfig } from './config.js';
import { createQueue, type WorkerHealth } from './queue.js';
import {
  compactTerminalRuns,
  createEventsStorage,
  createHooksStorage,
  createRunsStorage,
  createStepsStorage,
} from './storage.js';
import { createStreamer } from './streamer.js';

function createStorage(
  getJetStream: () => Promise<JetStreamClient>,
  keyPrefix: string,
  specVersion: SpecVersion,
  terminalRunTTLMs?: number,
  maxEventsPerRun?: number,
): Storage {
  const config = { getJetStream, keyPrefix, specVersion, terminalRunTTLMs, maxEventsPerRun };
  return {
    runs: createRunsStorage(config),
    events: createEventsStorage(config),
    hooks: createHooksStorage(config),
    steps: createStepsStorage(config),
  };
}

export function createWorld(
  config: NatsJetStreamWorldConfig = {
    nats: process.env.WORKFLOW_NATS_URL || process.env.NATS_URL || 'nats://localhost:4222',
    jobPrefix: process.env.WORKFLOW_NATS_JOB_PREFIX,
    queueConcurrency:
      Number.parseInt(process.env.WORKFLOW_NATS_WORKER_CONCURRENCY || '10', 10) || 10,
    keyPrefix: process.env.WORKFLOW_NATS_KEY_PREFIX || 'workflow_',
  },
): World & {
  start(): Promise<void>;
  close(): Promise<void>;
  getHealth(): WorkerHealth;
  compactTerminalRuns(): Promise<number>;
} {
  let nc: NatsConnection | undefined;
  let js: JetStreamClient | undefined;
  let connectionPromise: Promise<NatsConnection> | undefined;

  const getJetStream = async (): Promise<JetStreamClient> => {
    if (!js) {
      // Lazy connection - only connect on first access
      if (!connectionPromise) {
        connectionPromise =
          typeof config.nats === 'string'
            ? connect({ servers: config.nats })
            : connect(config.nats);
      }
      nc = await connectionPromise;
      js = jetstream(nc);
    }
    return js;
  };

  const keyPrefix = config.keyPrefix || 'workflow_';

  // The version stamped on new runs: 8 by default, or the slot-identity
  // version when WORKFLOW_SEALED_LOG=0. Read per world, not at module load.
  // Events are allocated at the commit, so a run's log never has a hole and
  // this World never writes a `noop`.
  const specVersion = mintedSpecVersion();

  const storage = createStorage(
    getJetStream,
    keyPrefix,
    specVersion,
    config.terminalRunTTLMs,
    config.maxEventsPerRun,
  );
  const streamer = createStreamer({ getJetStream, keyPrefix });
  const queue = createQueue(getJetStream, config);

  return {
    // `start()` includes the run input in the queue message, which enables
    // the resilient-start path in `events.create('run_started')`. That path
    // is required for correctness here: the runtime creates `run_created`
    // and enqueues the workflow message in parallel, and JetStream delivers
    // to the in-process worker fast enough that `run_started` can win the
    // race.
    specVersion,
    ...storage,
    ...streamer,
    ...queue,
    async start() {
      // Ensure connection is established
      await getJetStream();
      await queue.start();
    },
    async close() {
      // Workers first: a pull issued on a draining connection throws, and the
      // drain flushes the acks of the deliveries this waits for.
      await queue.close();
      if (nc) {
        await nc.drain();
        await nc.close();
      }
    },
    getHealth() {
      return queue.getHealth();
    },
    async compactTerminalRuns() {
      return compactTerminalRuns({
        getJetStream,
        keyPrefix,
        terminalRunTTLMs: config.terminalRunTTLMs,
      });
    },
  };
}

// Re-export config for users
export type { NatsJetStreamWorldConfig } from './config.js';
export type { WorkerHealth } from './queue.js';

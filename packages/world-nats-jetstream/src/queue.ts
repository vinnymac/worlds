import { setTimeout } from 'node:timers/promises';
import { JsonTransport } from '@vercel/queue';
import {
  MessageId,
  type Queue,
  QueuePayloadSchema,
  type QueuePrefix,
  type ValidQueueName,
} from '@workflow/world';
import { createLocalWorld } from '@workflow/world-local';
import type { JetStreamClient } from 'nats';
import { AckPolicy, DeliverPolicy, DiscardPolicy, RetentionPolicy } from 'nats';
import { monotonicFactory } from 'ulid';
import type { NatsJetStreamWorldConfig } from './config.js';

interface MessageData {
  id: string;
  data: string; // base64-encoded
  idempotencyKey?: string;
  messageId: string;
  attempt: number;
}

/**
 * The NATS JetStream queue uses JetStream streams with work queue consumers.
 * Each queue type (workflows, steps) gets its own stream and consumer group.
 *
 * Deduplication is handled via Nats-Msg-Id header (2-minute window).
 * Workers use durable consumers in work queue mode for load balancing.
 */
export function createQueue(
  getJetStream: () => Promise<JetStreamClient>,
  config: NatsJetStreamWorldConfig
): Queue & { start(): Promise<void> } {
  const port = process.env.PORT ? Number(process.env.PORT) : undefined;
  const embeddedWorld = createLocalWorld({ dataDir: undefined, port });

  const transport = new JsonTransport();
  const generateMessageId = monotonicFactory();

  const prefix = config.jobPrefix || 'workflow_';
  const Streams = {
    __wkf_workflow_: `${prefix}flows`,
    __wkf_step_: `${prefix}steps`,
  } as const satisfies Record<QueuePrefix, string>;

  const createQueueHandler = embeddedWorld.createQueueHandler;

  const getDeploymentId: Queue['getDeploymentId'] = async () => {
    return 'nats-jetstream';
  };

  // Initialize streams and consumers
  let initialized = false;
  const initStreams = async () => {
    if (initialized) return;

    const jetstream = await getJetStream();
    const jsm = await jetstream.jetstreamManager();

    // Create streams for each queue type
    for (const streamName of Object.values(Streams)) {
      try {
        await jsm.streams.add({
          name: streamName,
          subjects: [`${streamName}.>`],
          retention: RetentionPolicy.Workqueue,
          discard: DiscardPolicy.Old,
          max_msgs: 100000,
          max_age: 7 * 24 * 60 * 60 * 1_000_000_000, // 7 days in nanoseconds
          duplicate_window: 120 * 1_000_000_000, // 2 minutes in nanoseconds
        });
      } catch (err: any) {
        // Stream might already exist
        if (!err.message?.includes('already in use')) {
          throw err;
        }
      }
    }

    initialized = true;
  };

  const queue: Queue['queue'] = async (queueName, message, opts) => {
    await initStreams();

    const [qPrefix, id] = parseQueueName(queueName);
    const streamName = Streams[qPrefix];
    const subject = `${streamName}.${id}`;
    const body = transport.serialize(message);
    const messageId = MessageId.parse(`msg_${generateMessageId()}`);

    const idempotencyKey = opts?.idempotencyKey ?? messageId;

    const messageData: MessageData = {
      id,
      data: Buffer.from(body).toString('base64'),
      idempotencyKey: opts?.idempotencyKey,
      messageId,
      attempt: 1,
    };

    const payload = JSON.stringify(messageData);

    // Publish to JetStream with deduplication via Nats-Msg-Id
    const js = await getJetStream();
    await js.publish(subject, new TextEncoder().encode(payload), {
      msgID: idempotencyKey,
    });

    return { messageId };
  };

  async function worker(workerQueuePrefix: QueuePrefix, streamName: string) {
    try {
      const jetstream = await getJetStream();
      const jsm = await jetstream.jetstreamManager();
      const consumerName = `${streamName}_worker`;

      // Ensure consumer exists via JetStreamManager
      try {
        await jsm.consumers.add(streamName, {
          durable_name: consumerName,
          ack_policy: AckPolicy.Explicit,
          deliver_policy: DeliverPolicy.All,
          max_deliver: 3,
          ack_wait: 30 * 1_000_000_000, // 30 seconds in nanoseconds
          filter_subject: `${streamName}.>`,
        });
      } catch (err: any) {
        // Consumer might already exist -- that's fine
        if (!err.message?.includes('already in use')) {
          throw err;
        }
      }

      // Get consumer handle via JetStreamClient.consumers API
      const consumer = await jetstream.consumers.get(streamName, consumerName);
      const messages = await consumer.consume();

      for await (const msg of messages) {
        try {
          const data = new TextDecoder().decode(msg.data);
          const parsed: MessageData = JSON.parse(data);
          const body = Buffer.from(parsed.data, 'base64');
          const decoded = await transport.deserialize(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(body);
                controller.close();
              },
            })
          );
          const message = QueuePayloadSchema.parse(decoded);
          const queueName =
            `${workerQueuePrefix}${parsed.id}` as ValidQueueName;

          // Process via embedded world
          await embeddedWorld.queue(queueName, message, {
            idempotencyKey: parsed.idempotencyKey,
          });

          // Acknowledge successful processing
          msg.ack();
        } catch (error) {
          console.error(
            `[world-nats-jetstream worker] Error processing message from ${streamName}:`,
            error
          );

          // Negative acknowledge to trigger redelivery
          msg.nak();
        }
      }
    } catch (error) {
      console.error(
        `[world-nats-jetstream worker] Error in worker for ${streamName}:`,
        error
      );

      // Wait before retrying
      await setTimeout(5000);

      // Restart worker
      void worker(workerQueuePrefix, streamName);
    }
  }

  async function startWorkers() {
    await initStreams();

    const concurrency = config.queueConcurrency || 10;
    const entries = Object.entries(Streams) as [QueuePrefix, string][];

    // Start workers (they run forever)
    for (const [queuePrefix, streamName] of entries) {
      for (let i = 0; i < concurrency; i++) {
        void worker(queuePrefix, streamName);
      }
    }
  }

  return {
    createQueueHandler,
    getDeploymentId,
    queue,
    async start() {
      void startWorkers();
    },
  };
}

const parseQueueName = (name: ValidQueueName): [QueuePrefix, string] => {
  const prefixes: QueuePrefix[] = ['__wkf_step_', '__wkf_workflow_'];
  for (const prefix of prefixes) {
    if (name.startsWith(prefix)) {
      return [prefix, name.slice(prefix.length)];
    }
  }
  throw new Error(`Invalid queue name: ${name}`);
};

import type { Streamer } from '@workflow/world';
import type { JetStreamClient } from 'nats';
import {
  AckPolicy,
  DeliverPolicy,
  RetentionPolicy,
  DiscardPolicy,
  headers as createHeaders,
} from 'nats';

interface StreamerConfig {
  getJetStream: () => Promise<JetStreamClient>;
  keyPrefix: string;
}

/**
 * Create a streamer implementation using NATS JetStream native streams.
 *
 * This is significantly simpler than Redis Streams because:
 * - No need for EventEmitter coordination
 * - No manual sequence tracking
 * - Built-in replay via DeliverPolicy
 * - Native push/pull consumer models
 */
export function createStreamer(config: StreamerConfig): Streamer {
  const { getJetStream, keyPrefix } = config;

  // Track initialized streams
  const initializedStreams = new Set<string>();

  async function ensureStream(streamId: string): Promise<void> {
    if (initializedStreams.has(streamId)) return;

    const jetstream = await getJetStream();
    const jsm = await jetstream.jetstreamManager();
    const streamName = `${keyPrefix}stream_${streamId}`;

    try {
      await jsm.streams.add({
        name: streamName,
        subjects: [`${streamName}.data`],
        retention: RetentionPolicy.Interest,
        discard: DiscardPolicy.Old,
        max_msgs: 10000,
        max_age: 24 * 60 * 60 * 1_000_000_000, // 24 hours in nanoseconds
      });
    } catch (err: any) {
      // Stream might already exist
      if (!err.message?.includes('already in use')) {
        throw err;
      }
    }

    initializedStreams.add(streamId);
  }

  return {
    async writeToStream(
      name: string,
      _runId: string | Promise<string>,
      chunk: string | Uint8Array
    ): Promise<void> {
      // Await runId if it's a promise
      await _runId;

      await ensureStream(name);

      const streamName = `${keyPrefix}stream_${name}`;
      const subject = `${streamName}.data`;

      const data =
        chunk instanceof Uint8Array ? chunk : new TextEncoder().encode(chunk);

      // Publish chunk to JetStream with headers
      const h = createHeaders();
      h.set('X-Content-Type', 'application/octet-stream');
      h.set('X-EOF', 'false');
      const jetstream = await getJetStream();
      await jetstream.publish(subject, data, { headers: h });
    },

    async closeStream(
      name: string,
      _runId: string | Promise<string>
    ): Promise<void> {
      // Await runId if it's a promise
      await _runId;

      await ensureStream(name);

      const streamName = `${keyPrefix}stream_${name}`;
      const subject = `${streamName}.data`;

      // Publish EOF marker
      const h = createHeaders();
      h.set('X-Content-Type', 'application/octet-stream');
      h.set('X-EOF', 'true');
      const jetstream = await getJetStream();
      await jetstream.publish(subject, new Uint8Array(0), { headers: h });
    },

    async readFromStream(
      name: string,
      startIndex?: number
    ): Promise<ReadableStream<Uint8Array>> {
      await ensureStream(name);

      const streamName = `${keyPrefix}stream_${name}`;
      const consumerName = `${streamName}_reader_${Date.now()}`;

      return new ReadableStream<Uint8Array>({
        async start(controller) {
          try {
            const jetstream = await getJetStream();
            const jsm = await jetstream.jetstreamManager();

            // Create ephemeral consumer for this reader
            const consumerInfo = await jsm.consumers.add(streamName, {
              name: consumerName,
              ack_policy: AckPolicy.Explicit,
              deliver_policy:
                startIndex && startIndex > 0
                  ? DeliverPolicy.StartSequence
                  : DeliverPolicy.All,
              opt_start_seq:
                startIndex && startIndex > 0 ? startIndex : undefined,
              filter_subject: `${streamName}.data`,
              inactive_threshold: 30 * 1_000_000_000, // 30 seconds
            });

            // Get the consumer via JetStreamClient.consumers API
            const consumer = await jetstream.consumers.get(
              streamName,
              consumerInfo.name
            );
            const messages = await consumer.consume();

            let chunkIndex = 0;

            for await (const msg of messages) {
              try {
                // Check for EOF marker
                const isEof = msg.headers?.get('X-EOF') === 'true';

                if (isEof) {
                  msg.ack();
                  controller.close();
                  messages.close();
                  break;
                }

                // Skip chunks before startIndex
                if (startIndex && chunkIndex < startIndex) {
                  chunkIndex++;
                  msg.ack();
                  continue;
                }

                // Enqueue the chunk
                if (msg.data.byteLength > 0) {
                  controller.enqueue(new Uint8Array(msg.data));
                }

                chunkIndex++;
                msg.ack();
              } catch (error) {
                console.error(
                  '[world-nats-jetstream streamer] Error processing chunk:',
                  error
                );
                msg.nak();
              }
            }

            // Clean up consumer
            try {
              await jsm.consumers.delete(streamName, consumerName);
            } catch {
              // Ignore cleanup errors
            }
          } catch (error) {
            controller.error(error);
          }
        },
        async cancel() {
          // Cleanup handled in start() after iteration completes
        },
      });
    },
  } as any as Streamer;
}

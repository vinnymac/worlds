import type {
  GetChunksOptions,
  StreamChunk,
  StreamChunksResponse,
  StreamInfoResponse,
  Streamer,
} from '@workflow/world';
import type {
  ConsumerMessages,
  JetStreamClient,
  JetStreamManager,
  StoredMsg,
} from '@nats-io/jetstream';
import { AckPolicy, DeliverPolicy, DiscardPolicy, RetentionPolicy } from '@nats-io/jetstream';
import type { KV } from '@nats-io/kv';
import { Kvm } from '@nats-io/kv';
import { headers as createHeaders } from '@nats-io/transport-node';

interface StreamerConfig {
  getJetStream: () => Promise<JetStreamClient>;
  keyPrefix: string;
}

/** Pagination bounds for streams.getChunks (contract: default 100, max 1000). */
const DEFAULT_CHUNK_LIMIT = 100;
const MAX_CHUNK_LIMIT = 1000;

function isEofMessage(msg: StoredMsg): boolean {
  return msg.header.get('X-EOF') === 'true';
}

/** Encode a getChunks cursor (base64 JSON, matching world-local). */
function encodeCursor(index: number): string {
  return Buffer.from(JSON.stringify({ i: index })).toString('base64');
}

/** Decode a getChunks cursor; malformed cursors restart from 0. */
function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const decoded = JSON.parse(Buffer.from(cursor, 'base64').toString('utf-8')) as { i?: unknown };
    return typeof decoded.i === 'number' && decoded.i >= 0 ? decoded.i : 0;
  } catch {
    return 0;
  }
}

/**
 * Create a streamer implementation using NATS JetStream native streams.
 *
 * A workflow stream is scoped to its run: two runs writing the same stream
 * name never share chunks (v5 keys every streams.* call by `(runId, name)`).
 * Each maps to a JetStream stream with Limits retention: chunks are retained
 * (bounded by max_msgs/max_age) regardless of consumer presence, so readers
 * that attach after the writer (the normal flow) can replay every chunk from
 * the beginning. Chunk index `i` corresponds to stream sequence `i + 1`
 * (each stream carries a single subject).
 *
 * Stream-to-run associations are recorded in a KV bucket so that
 * `streams.list(runId)` can enumerate streams without scanning JetStream.
 */
export function createStreamer(config: StreamerConfig): Streamer {
  const { getJetStream, keyPrefix } = config;

  // Track initialized streams and registered run associations (per-session caches)
  const initializedStreams = new Set<string>();
  const registeredStreams = new Set<string>();

  let streamsByRunBucket: KV | undefined;

  function streamNameFor(runId: string, name: string): string {
    // Stream names may contain characters that are invalid in JetStream
    // stream names or subjects; base64url only emits [A-Za-z0-9_-].
    const encodedName = Buffer.from(name).toString('base64url');
    return `${keyPrefix}stream_${runId}_${encodedName}`;
  }

  async function getManager(): Promise<JetStreamManager> {
    const jetstream = await getJetStream();
    return jetstream.jetstreamManager();
  }

  async function getStreamsByRunBucket(): Promise<KV> {
    if (!streamsByRunBucket) {
      const jetstream = await getJetStream();
      streamsByRunBucket = await new Kvm(jetstream).create(`${keyPrefix}streams_by_run`, {
        history: 1,
      });
    }
    return streamsByRunBucket;
  }

  /** Record the runId <> stream name association for streams.list. */
  async function registerStreamForRun(runId: string, name: string): Promise<void> {
    const cacheKey = `${runId}:${name}`;
    if (registeredStreams.has(cacheKey)) return;

    const bucket = await getStreamsByRunBucket();
    const encodedName = Buffer.from(name).toString('base64url');
    await bucket.put(`${runId}.${encodedName}`, name);
    registeredStreams.add(cacheKey);
  }

  async function ensureStream(runId: string, name: string): Promise<string> {
    const streamName = streamNameFor(runId, name);
    if (initializedStreams.has(streamName)) return streamName;

    const jsm = await getManager();

    const streamConfig = {
      name: streamName,
      subjects: [`${streamName}.data`],
      // Limits retention is required: readers attach after chunks are
      // written and replay from the beginning. Interest retention would
      // discard every chunk published before the first reader appears.
      retention: RetentionPolicy.Limits,
      discard: DiscardPolicy.Old,
      max_msgs: 10000,
      max_age: 24 * 60 * 60 * 1_000_000_000, // 24 hours in nanoseconds
    };

    try {
      await jsm.streams.add(streamConfig);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes('already in use')) {
        throw err;
      }
    }

    initializedStreams.add(streamName);
    return streamName;
  }

  /**
   * Snapshot the tail state of a stream: how many data chunks exist and
   * whether the EOF marker has been written. The EOF marker is always the
   * last message when present, so a single last-message lookup suffices.
   */
  async function getTailState(streamName: string): Promise<{ dataCount: number; done: boolean }> {
    const jsm = await getManager();
    const info = await jsm.streams.info(streamName);
    const messages = info.state.messages;
    if (messages === 0) {
      return { dataCount: 0, done: false };
    }
    const last = await jsm.streams.getMessage(streamName, {
      last_by_subj: `${streamName}.data`,
    });
    if (!last) {
      // messages > 0 guarantees a message on `.data`, so null means inconsistent stream state.
      throw new Error(`Stream "${streamName}" reports ${messages} messages but has none`);
    }
    const done = isEofMessage(last);
    return { dataCount: done ? messages - 1 : messages, done };
  }

  async function publishChunk(
    streamName: string,
    data: Uint8Array,
    eof: boolean,
  ): Promise<void> {
    const h = createHeaders();
    h.set('X-Content-Type', 'application/octet-stream');
    h.set('X-EOF', eof ? 'true' : 'false');
    const jetstream = await getJetStream();
    await jetstream.publish(`${streamName}.data`, data, { headers: h });
  }

  async function write(runId: string, name: string, chunk: string | Uint8Array): Promise<void> {
    const streamName = await ensureStream(runId, name);
    await registerStreamForRun(runId, name);
    const data = chunk instanceof Uint8Array ? chunk : new TextEncoder().encode(chunk);
    await publishChunk(streamName, data, false);
  }

  return {
    streams: {
      write,

      async writeMulti(
        runId: string,
        name: string,
        chunks: (string | Uint8Array)[],
      ): Promise<void> {
        for (const chunk of chunks) {
          await write(runId, name, chunk);
        }
      },

      async close(runId: string, name: string): Promise<void> {
        const streamName = await ensureStream(runId, name);
        await registerStreamForRun(runId, name);
        await publishChunk(streamName, new Uint8Array(0), true);
      },

      async list(runId: string): Promise<string[]> {
        const bucket = await getStreamsByRunBucket();
        // Drain the key listing before issuing gets: the keys() iterator drops
        // buffered keys when the consumer awaits unrelated work between reads.
        const keys: string[] = [];
        const iter = await bucket.keys(`${runId}.>`);
        for await (const key of iter) {
          keys.push(key);
        }
        const names: string[] = [];
        for (const key of keys) {
          const entry = await bucket.get(key);
          if (!entry || entry.operation !== 'PUT') continue;
          names.push(
            typeof entry.value === 'string' ? entry.value : new TextDecoder().decode(entry.value),
          );
        }
        return names;
      },

      async getInfo(runId: string, name: string): Promise<StreamInfoResponse> {
        const streamName = await ensureStream(runId, name);
        const { dataCount, done } = await getTailState(streamName);
        return { tailIndex: dataCount - 1, done };
      },

      async getChunks(
        runId: string,
        name: string,
        options?: GetChunksOptions,
      ): Promise<StreamChunksResponse> {
        const streamName = await ensureStream(runId, name);

        const limit = Math.min(options?.limit ?? DEFAULT_CHUNK_LIMIT, MAX_CHUNK_LIMIT);
        const startIndex = decodeCursor(options?.cursor);

        const jsm = await getManager();

        const chunks: StreamChunk[] = [];
        let done = false;
        let hasMore = false;

        // Chunk index i lives at stream sequence i + 1. Walk from the cursor,
        // collecting up to `limit` data chunks, then peek one further message
        // to distinguish "more chunks" from "EOF" from "end of written data".
        for (let index = startIndex; ; index++) {
          const msg = await jsm.streams.getMessage(streamName, { seq: index + 1 });
          if (!msg) break;

          if (isEofMessage(msg)) {
            done = true;
            break;
          }

          if (chunks.length >= limit) {
            hasMore = true;
            break;
          }

          chunks.push({ index, data: new Uint8Array(msg.data) });
        }

        const nextCursor = hasMore ? encodeCursor(startIndex + chunks.length) : null;

        return {
          data: chunks,
          cursor: nextCursor,
          hasMore,
          done,
        };
      },

      async get(
        runId: string,
        name: string,
        startIndex?: number,
      ): Promise<ReadableStream<Uint8Array>> {
        const streamName = await ensureStream(runId, name);

        const consumerName = `${streamName}_reader_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

        // Resolve negative startIndex ("start that many chunks before the
        // current end") against the tail before creating the consumer.
        let resolvedStartIndex = startIndex ?? 0;
        if (resolvedStartIndex < 0) {
          const { dataCount } = await getTailState(streamName);
          resolvedStartIndex = Math.max(0, dataCount + resolvedStartIndex);
        }

        let messages: ConsumerMessages | null = null;

        return new ReadableStream<Uint8Array>({
          async start(controller) {
            try {
              const jetstream = await getJetStream();
              const jsm = await jetstream.jetstreamManager();

              // Create ephemeral consumer for this reader. Chunk index i is
              // stream sequence i + 1, so starting at resolvedStartIndex means
              // opt_start_seq = resolvedStartIndex + 1; this is the single
              // skip mechanism (no additional client-side skipping).
              const consumerInfo = await jsm.consumers.add(streamName, {
                name: consumerName,
                ack_policy: AckPolicy.Explicit,
                deliver_policy:
                  resolvedStartIndex > 0 ? DeliverPolicy.StartSequence : DeliverPolicy.All,
                opt_start_seq: resolvedStartIndex > 0 ? resolvedStartIndex + 1 : undefined,
                filter_subject: `${streamName}.data`,
                inactive_threshold: 30 * 1_000_000_000, // 30 seconds
              });

              // Get the consumer via JetStreamClient.consumers API
              const consumer = await jetstream.consumers.get(streamName, consumerInfo.name);
              const iter = await consumer.consume();
              messages = iter;

              for await (const msg of iter) {
                // Check for EOF marker
                const isEof = msg.headers?.get('X-EOF') === 'true';

                if (isEof) {
                  msg.ack();
                  controller.close();
                  iter.close();
                  break;
                }

                // Enqueue the chunk
                if (msg.data.byteLength > 0) {
                  controller.enqueue(new Uint8Array(msg.data));
                }

                msg.ack();
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
            // Stop the consume loop; the start() epilogue deletes the consumer.
            messages?.close();
          },
        });
      },
    },
  };
}

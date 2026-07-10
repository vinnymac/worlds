import type {
  GetChunksOptions,
  StreamChunk,
  StreamChunksResponse,
  StreamInfoResponse,
  Streamer,
} from '@workflow/world';
import type { ConsumerMessages, JetStreamClient, JetStreamManager, KV, StoredMsg } from 'nats';
import {
  AckPolicy,
  DeliverPolicy,
  DiscardPolicy,
  RetentionPolicy,
  headers as createHeaders,
} from 'nats';

interface StreamerConfig {
  getJetStream: () => Promise<JetStreamClient>;
  keyPrefix: string;
}

/** Pagination bounds for getStreamChunks (contract: default 100, max 1000). */
const DEFAULT_CHUNK_LIMIT = 100;
const MAX_CHUNK_LIMIT = 1000;

/** True when a JetStream API error means "no message at that sequence". */
function isNoMessageFound(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const apiError = (err as Error & { api_error?: { err_code?: number } }).api_error;
  return apiError?.err_code === 10037 || err.message.includes('no message found');
}

function isEofMessage(msg: StoredMsg): boolean {
  return msg.header.get('X-EOF') === 'true';
}

/** Encode a getStreamChunks cursor (base64 JSON, matching world-local). */
function encodeCursor(index: number): string {
  return Buffer.from(JSON.stringify({ i: index })).toString('base64');
}

/** Decode a getStreamChunks cursor; malformed cursors restart from 0. */
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
 * Each workflow stream maps to a JetStream stream with Limits retention:
 * chunks are retained (bounded by max_msgs/max_age) regardless of consumer
 * presence, so readers that attach after the writer — the normal flow —
 * can replay every chunk from the beginning. Chunk index `i` corresponds
 * to stream sequence `i + 1` (each stream carries a single subject).
 *
 * Stream-to-run associations are recorded in a KV bucket so that
 * `listStreamsByRunId` can enumerate streams without scanning JetStream.
 */
export function createStreamer(config: StreamerConfig): Streamer {
  const { getJetStream, keyPrefix } = config;

  // Track initialized streams and registered run associations (per-session caches)
  const initializedStreams = new Set<string>();
  const registeredStreams = new Set<string>();

  let streamsByRunBucket: KV | undefined;

  function streamNameFor(streamId: string): string {
    return `${keyPrefix}stream_${streamId}`;
  }

  async function getManager(): Promise<JetStreamManager> {
    const jetstream = await getJetStream();
    return jetstream.jetstreamManager();
  }

  async function getStreamsByRunBucket(): Promise<KV> {
    if (!streamsByRunBucket) {
      const jetstream = await getJetStream();
      streamsByRunBucket = await jetstream.views.kv(`${keyPrefix}streams_by_run`, {
        history: 1,
      });
    }
    return streamsByRunBucket;
  }

  /** Record the runId <> streamId association for listStreamsByRunId. */
  async function registerStreamForRun(runId: string, name: string): Promise<void> {
    const cacheKey = `${runId}:${name}`;
    if (registeredStreams.has(cacheKey)) return;

    const bucket = await getStreamsByRunBucket();
    // Stream names may contain characters that are invalid in KV keys;
    // base64url only emits [A-Za-z0-9_-], all valid key characters.
    const encodedName = Buffer.from(name).toString('base64url');
    await bucket.put(`${runId}.${encodedName}`, name);
    registeredStreams.add(cacheKey);
  }

  async function ensureStream(streamId: string): Promise<void> {
    if (initializedStreams.has(streamId)) return;

    const jsm = await getManager();
    const streamName = streamNameFor(streamId);

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
      // The stream exists with a different configuration. Retention policy
      // cannot be updated in place; streams created by pre-fix versions used
      // Interest retention (which retains nothing without consumers), so
      // recreating them is lossless and migrates them to Limits.
      const info = await jsm.streams.info(streamName);
      if (info.config.retention !== RetentionPolicy.Limits) {
        try {
          await jsm.streams.delete(streamName);
        } catch {
          // A concurrent worker may have already deleted it.
        }
        try {
          await jsm.streams.add(streamConfig);
        } catch (recreateErr) {
          const recreateMessage =
            recreateErr instanceof Error ? recreateErr.message : String(recreateErr);
          if (!recreateMessage.includes('already in use')) {
            throw recreateErr;
          }
        }
      }
    }

    initializedStreams.add(streamId);
  }

  /**
   * Snapshot the tail state of a stream: how many data chunks exist and
   * whether the EOF marker has been written. The EOF marker is always the
   * last message when present, so a single last-message lookup suffices.
   */
  async function getTailState(streamId: string): Promise<{ dataCount: number; done: boolean }> {
    const jsm = await getManager();
    const streamName = streamNameFor(streamId);
    const info = await jsm.streams.info(streamName);
    const messages = info.state.messages;
    if (messages === 0) {
      return { dataCount: 0, done: false };
    }
    const last = await jsm.streams.getMessage(streamName, {
      last_by_subj: `${streamName}.data`,
    });
    const done = isEofMessage(last);
    return { dataCount: done ? messages - 1 : messages, done };
  }

  return {
    async writeToStream(
      name: string,
      _runId: string | Promise<string>,
      chunk: string | Uint8Array,
    ): Promise<void> {
      // Await runId if it's a promise
      const runId = await _runId;

      await ensureStream(name);
      await registerStreamForRun(runId, name);

      const streamName = streamNameFor(name);
      const subject = `${streamName}.data`;

      const data = chunk instanceof Uint8Array ? chunk : new TextEncoder().encode(chunk);

      // Publish chunk to JetStream with headers
      const h = createHeaders();
      h.set('X-Content-Type', 'application/octet-stream');
      h.set('X-EOF', 'false');
      const jetstream = await getJetStream();
      await jetstream.publish(subject, data, { headers: h });
    },

    async closeStream(name: string, _runId: string | Promise<string>): Promise<void> {
      // Await runId if it's a promise
      const runId = await _runId;

      await ensureStream(name);
      await registerStreamForRun(runId, name);

      const streamName = streamNameFor(name);
      const subject = `${streamName}.data`;

      // Publish EOF marker
      const h = createHeaders();
      h.set('X-Content-Type', 'application/octet-stream');
      h.set('X-EOF', 'true');
      const jetstream = await getJetStream();
      await jetstream.publish(subject, new Uint8Array(0), { headers: h });
    },

    async listStreamsByRunId(runId: string): Promise<string[]> {
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

    async getStreamInfo(name: string, _runId: string): Promise<StreamInfoResponse> {
      await ensureStream(name);
      const { dataCount, done } = await getTailState(name);
      return { tailIndex: dataCount - 1, done };
    },

    async getStreamChunks(
      name: string,
      _runId: string,
      options?: GetChunksOptions,
    ): Promise<StreamChunksResponse> {
      await ensureStream(name);

      const limit = Math.min(options?.limit ?? DEFAULT_CHUNK_LIMIT, MAX_CHUNK_LIMIT);
      const startIndex = decodeCursor(options?.cursor);

      const jsm = await getManager();
      const streamName = streamNameFor(name);

      const chunks: StreamChunk[] = [];
      let done = false;
      let hasMore = false;

      // Chunk index i lives at stream sequence i + 1. Walk from the cursor,
      // collecting up to `limit` data chunks, then peek one further message
      // to distinguish "more chunks" from "EOF" from "end of written data".
      for (let index = startIndex; ; index++) {
        let msg: StoredMsg;
        try {
          msg = await jsm.streams.getMessage(streamName, { seq: index + 1 });
        } catch (err) {
          if (isNoMessageFound(err)) break;
          throw err;
        }

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

    async readFromStream(name: string, startIndex?: number): Promise<ReadableStream<Uint8Array>> {
      await ensureStream(name);

      const streamName = streamNameFor(name);
      const consumerName = `${streamName}_reader_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

      // Resolve negative startIndex ("start that many chunks before the
      // current end") against the tail before creating the consumer.
      let resolvedStartIndex = startIndex ?? 0;
      if (resolvedStartIndex < 0) {
        const { dataCount } = await getTailState(name);
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
            // opt_start_seq = resolvedStartIndex + 1 — this is the single
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
  };
}

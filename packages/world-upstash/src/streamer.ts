import type {
  GetChunksOptions,
  StreamChunksResponse,
  StreamInfoResponse,
  Streamer,
} from '@workflow/world';
import type { Redis } from '@upstash/redis';
import { debug } from './util.js';

interface UpstashStreamerConfig {
  redis: Redis;
  keyPrefix: string;
  /**
   * Default polling interval in milliseconds for streams.get.
   * Upstash Redis HTTP API does not support long-lived SUBSCRIBE/BLPOP,
   * so streams.get polls at this interval.
   * @default 500
   */
  pollIntervalMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Encode a chunk for storage. Both string and binary chunks are stored
 * base64-encoded so reads can decode unconditionally; Node's base64 decoder
 * never throws on invalid input (it silently skips non-alphabet characters),
 * so a "decode, fall back to utf-8" strategy silently corrupts string chunks.
 */
function encodeChunk(chunk: string | Uint8Array): string {
  const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf-8') : Buffer.from(chunk);
  return buffer.toString('base64');
}

/**
 * Decode a stored chunk back to bytes.
 *
 * The `String()` coercion guards against @upstash/redis auto-deserialization:
 * a base64 value that happens to parse as JSON (e.g. "1234" or "true") comes
 * back as a number/boolean; the client only auto-parses numbers whose
 * canonical string form matches the raw value, so coercion restores the
 * original base64 text exactly.
 */
function decodeChunk(raw: unknown): Uint8Array {
  return new Uint8Array(Buffer.from(String(raw), 'base64'));
}

/** Read the stream-closed marker, tolerating auto-deserialization ('1' -> 1). */
async function readClosedFlag(redis: Redis, closedKey: string): Promise<boolean> {
  const value = await redis.get(closedKey);
  return value != null && String(value) === '1';
}

/**
 * Create a streamer for Upstash world using Redis lists as storage.
 *
 * Because Upstash Redis is HTTP-based, there is no long-lived connection for
 * SUBSCRIBE or BLPOP. streams.get uses polling with a configurable interval.
 * For serverless environments where long-running responses are not practical,
 * prefer streams.getChunks() for explicit polling from the client side.
 */
export function createStreamer(config: UpstashStreamerConfig): Streamer {
  const { redis, keyPrefix } = config;
  const defaultPollIntervalMs = config.pollIntervalMs ?? 500;

  const streamChunksKey = (runId: string, name: string) =>
    `${keyPrefix}stream:${runId}:${name}:chunks`;
  const streamClosedKey = (runId: string, name: string) =>
    `${keyPrefix}stream:${runId}:${name}:closed`;
  const streamsByRunKey = (runId: string) => `${keyPrefix}streams:by_run:${runId}`;

  /** RPUSH chunks and index the stream under its run on the first write.
   * Gating the SADD on the first chunk keeps the steady-state cost at one
   * billed request per write. */
  async function pushChunks(runId: string, name: string, chunks: (string | Uint8Array)[]) {
    const key = streamChunksKey(runId, name);
    const [first, ...rest] = chunks.map(encodeChunk);
    const length = await redis.rpush(key, first, ...rest);
    if (length === chunks.length) {
      await redis.sadd(streamsByRunKey(runId), name);
    }
  }

  return {
    // Deliberate coalescing: every flush is a billed HTTP request on this
    // transport, so trade 10ms of first-chunk latency for batched writeMulti.
    streamFlushIntervalMs: 10,

    streams: {
      async write(runId: string, name: string, chunk: string | Uint8Array): Promise<void> {
        await pushChunks(runId, name, [chunk]);
      },

      async writeMulti(
        runId: string,
        name: string,
        chunks: (string | Uint8Array)[],
      ): Promise<void> {
        if (chunks.length === 0) {
          return;
        }
        await pushChunks(runId, name, chunks);
      },

      async close(runId: string, name: string): Promise<void> {
        await redis.set(streamClosedKey(runId, name), '1');
        // A stream closed before any chunk was written still needs its run
        // index entry, or streams.list would never surface it.
        await redis.sadd(streamsByRunKey(runId), name);
      },

      async get(
        runId: string,
        name: string,
        startIndex?: number,
      ): Promise<ReadableStream<Uint8Array>> {
        // Polling-based ReadableStream: the Upstash Redis HTTP API has no
        // SUBSCRIBE or BLPOP, so poll at a configurable interval until the
        // stream is closed.
        const pollInterval = defaultPollIntervalMs;
        const chunksKey = streamChunksKey(runId, name);
        const closedKey = streamClosedKey(runId, name);
        let currentIndex: number | undefined;

        return new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              if (currentIndex === undefined) {
                // Resolve a negative startIndex relative to the current end of
                // the stream (interface contract: -3 on a 10-chunk stream
                // starts at 7, clamped to 0). LRANGE would otherwise interpret
                // negative indices end-relative per chunk fetch, duplicating/
                // skipping chunks as the index is incremented.
                if (startIndex !== undefined && startIndex < 0) {
                  const length = await redis.llen(chunksKey);
                  currentIndex = Math.max(0, length + startIndex);
                } else {
                  currentIndex = startIndex ?? 0;
                }
              }

              // Poll until we get new data or the stream is closed
              for (;;) {
                const rawChunks = await redis.lrange<string>(
                  chunksKey,
                  currentIndex,
                  currentIndex + 99,
                );

                if (rawChunks.length > 0) {
                  for (const chunk of rawChunks) {
                    controller.enqueue(decodeChunk(chunk));
                    currentIndex++;
                  }
                  // Yield control after enqueuing a batch
                  return;
                }

                // No new data -- check if stream is closed
                if (await readClosedFlag(redis, closedKey)) {
                  controller.close();
                  return;
                }

                // Wait before next poll
                await sleep(pollInterval);
              }
            } catch (err) {
              debug('streams.get poll error:', err);
              controller.error(err);
              return;
            }
          },
        });
      },

      async list(runId: string): Promise<string[]> {
        const streams = await redis.smembers<string[]>(streamsByRunKey(runId));
        return streams || [];
      },

      async getChunks(
        runId: string,
        name: string,
        options?: GetChunksOptions,
      ): Promise<StreamChunksResponse> {
        const limit = Math.min(options?.limit ?? 100, 1000);
        const fromIndex = options?.cursor ? Number.parseInt(options.cursor, 10) : 0;

        const chunksKey = streamChunksKey(runId, name);
        const closedKey = streamClosedKey(runId, name);

        const rawChunks = await redis.lrange<string>(chunksKey, fromIndex, fromIndex + limit - 1);
        const isClosed = await readClosedFlag(redis, closedKey);
        const totalLength = await redis.llen(chunksKey);

        // Decode base64 back to Uint8Array and create StreamChunk objects
        const data = (rawChunks || []).map((chunk: string, offset: number) => ({
          index: fromIndex + offset,
          data: decodeChunk(chunk),
        }));

        const hasMore = fromIndex + rawChunks.length < totalLength;
        const nextCursor = hasMore ? String(fromIndex + rawChunks.length) : null;

        return {
          data,
          cursor: nextCursor,
          hasMore,
          done: isClosed && !hasMore,
        };
      },

      async getInfo(runId: string, name: string): Promise<StreamInfoResponse> {
        const chunksKey = streamChunksKey(runId, name);
        const closedKey = streamClosedKey(runId, name);

        const length = await redis.llen(chunksKey);
        const isClosed = await readClosedFlag(redis, closedKey);

        return {
          tailIndex: length - 1,
          done: isClosed,
        };
      },
    },
  };
}

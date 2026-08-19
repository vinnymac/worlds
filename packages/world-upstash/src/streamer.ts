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
   * Default polling interval in milliseconds for readFromStream.
   * Upstash Redis HTTP API does not support long-lived SUBSCRIBE/BLPOP,
   * so readFromStream polls at this interval.
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
 * The Streamer contract, plus the Upstash-specific `runId` parameter on
 * `readFromStream` (chunk lists are keyed by run, so polling requires it).
 */
export interface UpstashStreamer extends Omit<Streamer, 'readFromStream'> {
  readFromStream(
    name: string,
    startIndex?: number,
    runId?: string,
  ): Promise<ReadableStream<Uint8Array>>;
}

/**
 * Create a streamer for Upstash world using Redis as storage.
 *
 * Because Upstash Redis is HTTP-based, there is no long-lived connection for
 * SUBSCRIBE or BLPOP. readFromStream uses polling with a configurable interval.
 * For serverless environments where long-running responses are not practical,
 * prefer getStreamChunks() for explicit polling from the client side.
 */
export function createStreamer(config: UpstashStreamerConfig): UpstashStreamer {
  const { redis, keyPrefix } = config;
  const defaultPollIntervalMs = config.pollIntervalMs ?? 500;

  const streamChunksKey = (name: string, runId: string) =>
    `${keyPrefix}stream:${runId}:${name}:chunks`;
  const streamClosedKey = (name: string, runId: string) =>
    `${keyPrefix}stream:${runId}:${name}:closed`;
  const streamsByRunKey = (runId: string) => `${keyPrefix}streams:by_run:${runId}`;
  // name -> runId mapping. Chunk keys are run-scoped, but core's
  // serialization layer reads with `readFromStream(name, startIndex)` only
  // (stream names, `strm_<ulid>`, are globally unique), so name-only readers
  // resolve the owning run through this key.
  const streamRunKey = (name: string) => `${keyPrefix}stream:run_of:${name}`;

  return {
    streamFlushIntervalMs: 10,

    async writeToStream(name: string, runId: string, chunk: string | Uint8Array): Promise<void> {
      const key = streamChunksKey(name, runId);
      const length = await redis.rpush(key, encodeChunk(chunk));
      if (length === 1) {
        // First chunk: index the stream under its run and record the
        // name -> runId mapping name-only readers depend on. Gating on the
        // first chunk keeps the steady-state cost at one request per write.
        await redis.set(streamRunKey(name), runId);
        await redis.sadd(streamsByRunKey(runId), name);
      }
    },

    async closeStream(name: string, runId: string): Promise<void> {
      await redis.set(streamClosedKey(name, runId), '1');
      // A stream closed before any chunk was written still needs the
      // name -> runId mapping, or a name-only reader could never observe
      // the close and would poll forever.
      await redis.set(streamRunKey(name), runId);
    },

    async readFromStream(
      name: string,
      startIndex?: number,
      runId?: string,
    ): Promise<ReadableStream<Uint8Array>> {
      // Polling-based ReadableStream: the Upstash Redis HTTP API has no
      // SUBSCRIBE or BLPOP, so poll at a configurable interval until the
      // stream is closed.
      //
      // When no runId is supplied (core's calling convention), the owning
      // run is resolved from the name -> runId mapping written with the
      // stream's first chunk (and on close). A reader may attach before the
      // writer, so the mapping is polled like chunk data; returning an
      // empty stream here would silently truncate every consumer read.
      const pollInterval = defaultPollIntervalMs;
      let resolvedRunId = runId;
      let currentIndex: number | undefined;

      return new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            while (resolvedRunId === undefined) {
              const mapped = await redis.get(streamRunKey(name));
              if (mapped != null) {
                resolvedRunId = String(mapped);
                break;
              }
              await sleep(pollInterval);
            }
            const chunksKey = streamChunksKey(name, resolvedRunId);
            const closedKey = streamClosedKey(name, resolvedRunId);

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
            // eslint-disable-next-line no-constant-condition
            while (true) {
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
            debug('readFromStream poll error:', err);
            controller.error(err);
            return;
          }
        },
      });
    },

    async listStreamsByRunId(runId: string): Promise<string[]> {
      const streams = await redis.smembers<string[]>(streamsByRunKey(runId));
      return streams || [];
    },

    async getStreamChunks(
      name: string,
      runId: string,
      options?: GetChunksOptions,
    ): Promise<StreamChunksResponse> {
      const limit = Math.min(options?.limit ?? 100, 1000);
      const fromIndex = options?.cursor ? Number.parseInt(options.cursor, 10) : 0;

      const chunksKey = streamChunksKey(name, runId);
      const closedKey = streamClosedKey(name, runId);

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

    async getStreamInfo(name: string, runId: string): Promise<StreamInfoResponse> {
      const chunksKey = streamChunksKey(name, runId);
      const closedKey = streamClosedKey(name, runId);

      const length = await redis.llen(chunksKey);
      const isClosed = await readClosedFlag(redis, closedKey);

      return {
        tailIndex: Math.max(0, length - 1),
        done: isClosed,
      };
    },
  };
}

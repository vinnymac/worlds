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
 * Create a streamer for Upstash world using Redis as storage.
 *
 * Because Upstash Redis is HTTP-based, there is no long-lived connection for
 * SUBSCRIBE or BLPOP. readFromStream uses polling with a configurable interval.
 * For serverless environments where long-running responses are not practical,
 * prefer getStreamChunks() for explicit polling from the client side.
 */
export function createStreamer(config: UpstashStreamerConfig): Streamer {
  const { redis, keyPrefix } = config;
  const defaultPollIntervalMs = config.pollIntervalMs ?? 500;

  const streamChunksKey = (name: string, runId: string) =>
    `${keyPrefix}stream:${runId}:${name}:chunks`;
  const streamClosedKey = (name: string, runId: string) =>
    `${keyPrefix}stream:${runId}:${name}:closed`;
  const streamsByRunKey = (runId: string) => `${keyPrefix}streams:by_run:${runId}`;

  return {
    streamFlushIntervalMs: 10,

    async writeToStream(name: string, runId: string, chunk: string | Uint8Array): Promise<void> {
      const key = streamChunksKey(name, runId);
      const value = chunk instanceof Uint8Array ? Buffer.from(chunk).toString('base64') : chunk;
      await redis.rpush(key, value);

      // Track stream name for this run
      await redis.sadd(streamsByRunKey(runId), name);
    },

    async closeStream(name: string, runId: string): Promise<void> {
      const key = streamClosedKey(name, runId);
      await redis.set(key, '1');
    },

    async readFromStream(
      name: string,
      startIndex?: number,
      runId?: string,
    ): Promise<ReadableStream<Uint8Array>> {
      // Enhancement 7: Polling-based ReadableStream implementation.
      // Upstash Redis HTTP API does not support SUBSCRIBE or BLPOP, so we poll
      // at a configurable interval until the stream is closed.
      //
      // If no runId is provided, fall back to an empty stream (cannot poll without it).
      if (!runId) {
        debug('readFromStream called without runId; returning empty stream');
        return new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close();
          },
        });
      }

      const chunksKey = streamChunksKey(name, runId);
      const closedKey = streamClosedKey(name, runId);
      let currentIndex = startIndex ?? 0;
      const pollInterval = defaultPollIntervalMs;

      return new ReadableStream<Uint8Array>({
        async pull(controller) {
          // Poll until we get new data or the stream is closed
          // eslint-disable-next-line no-constant-condition
          while (true) {
            try {
              const rawChunks = (await redis.lrange(
                chunksKey,
                currentIndex,
                currentIndex + 99,
              )) as string[];

              if (rawChunks.length > 0) {
                for (const chunk of rawChunks) {
                  try {
                    controller.enqueue(new Uint8Array(Buffer.from(chunk, 'base64')));
                  } catch {
                    controller.enqueue(new Uint8Array(Buffer.from(chunk, 'utf-8')));
                  }
                  currentIndex++;
                }
                // Yield control after enqueuing a batch
                return;
              }

              // No new data -- check if stream is closed
              const isClosed = (await redis.get(closedKey)) === '1';
              if (isClosed) {
                controller.close();
                return;
              }

              // Wait before next poll
              await sleep(pollInterval);
            } catch (err) {
              debug('readFromStream poll error:', err);
              controller.error(err);
              return;
            }
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

      const rawChunks = (await redis.lrange(
        chunksKey,
        fromIndex,
        fromIndex + limit - 1,
      )) as string[];
      const isClosed = (await redis.get(closedKey)) === '1';
      const totalLength = await redis.llen(chunksKey);

      // Decode base64 back to Uint8Array and create StreamChunk objects
      const data = (rawChunks || []).map((chunk: string, offset: number) => {
        try {
          return {
            index: fromIndex + offset,
            data: new Uint8Array(Buffer.from(chunk, 'base64')),
          };
        } catch {
          // If not base64, treat as text
          return {
            index: fromIndex + offset,
            data: new Uint8Array(Buffer.from(chunk, 'utf-8')),
          };
        }
      });

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
      const isClosed = (await redis.get(closedKey)) === '1';

      return {
        tailIndex: Math.max(0, length - 1),
        done: isClosed,
      };
    },
  };
}

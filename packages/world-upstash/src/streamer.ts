import type {
  GetChunksOptions,
  StreamChunksResponse,
  StreamInfoResponse,
  Streamer,
} from '@workflow/world';
import type { Redis } from '@upstash/redis';

interface UpstashStreamerConfig {
  redis: Redis;
  keyPrefix: string;
}

/**
 * Create a basic streamer for Upstash world using Redis as storage.
 * Note: Real-time streaming via ReadableStream is not fully supported in this serverless implementation.
 * Use getStreamChunks() for polling-based stream access instead.
 */
export function createStreamer(config: UpstashStreamerConfig): Streamer {
  const { redis, keyPrefix } = config;

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

    async readFromStream(_name: string, startIndex?: number): Promise<ReadableStream<Uint8Array>> {
      // Serverless environments don't support long-running ReadableStreams well
      // Return an empty ReadableStream as a placeholder
      // Users should use getStreamChunks() for polling instead
      const chunks: Uint8Array[] = [];
      let currentIndex = startIndex || 0;

      return new ReadableStream<Uint8Array>({
        start(controller) {
          // Immediately close the stream with any available chunks
          for (const chunk of chunks.slice(currentIndex)) {
            controller.enqueue(chunk);
          }
          controller.close();
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

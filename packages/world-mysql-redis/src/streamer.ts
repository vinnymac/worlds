import type {
  GetChunksOptions,
  StreamChunksResponse,
  StreamInfoResponse,
  Streamer,
} from '@workflow/world';
import { and, eq, gt } from 'drizzle-orm';
import type { MySql2Database } from 'drizzle-orm/mysql2';
import { monotonicFactory } from 'ulid';
import * as schema from './schema.js';

const { streams } = schema;

/**
 * MySQL streamer using polling-based approach.
 *
 * Unlike PostgreSQL which uses NOTIFY/LISTEN for real-time push notifications,
 * MySQL lacks native pub/sub. We use a sequence-based polling pattern instead:
 * - Each chunk gets an auto-incrementing sequence number
 * - Readers poll for chunks where sequence > lastSequence
 * - Poll interval of 100ms provides acceptable latency for most use cases
 */
export function createStreamer(drizzle: MySql2Database<typeof schema>): Streamer {
  const ulid = monotonicFactory();

  const genChunkId = () => `chnk_${ulid()}` as const;
  // Use timestamp-based sequence to avoid conflicts across restarts
  const nextSequence = () => Date.now();

  return {
    async writeToStream(
      name: string,
      _runId: string | Promise<string>,
      chunk: string | Uint8Array,
    ) {
      // Await runId if it's a promise to ensure proper flushing
      await _runId;

      const chunkId = genChunkId();
      const buffer =
        typeof chunk === 'string'
          ? Buffer.from(chunk)
          : Buffer.isBuffer(chunk)
            ? chunk
            : Buffer.from(chunk);

      await drizzle.insert(streams).values({
        chunkId,
        streamId: name,
        chunkData: buffer,
        eof: false,
        sequence: nextSequence(),
      });
    },

    async closeStream(name: string, _runId: string | Promise<string>): Promise<void> {
      // Await runId if it's a promise to ensure proper flushing
      await _runId;

      const chunkId = genChunkId();
      await drizzle.insert(streams).values({
        chunkId,
        streamId: name,
        chunkData: Buffer.from([]),
        eof: true,
        sequence: nextSequence(),
      });
    },

    async readFromStream(name: string, startIndex?: number): Promise<ReadableStream<Uint8Array>> {
      let closed = false;
      let lastSequence = startIndex ?? -1;

      return new ReadableStream<Uint8Array>({
        async start(controller) {
          // Use a polling loop in start() rather than pull() because
          // Node.js ReadableStream doesn't reliably re-invoke pull()
          // when it resolves without enqueuing data.
          const poll = async () => {
            while (!closed) {
              const chunks = await drizzle
                .select({
                  sequence: streams.sequence,
                  eof: streams.eof,
                  data: streams.chunkData,
                })
                .from(streams)
                .where(and(eq(streams.streamId, name), gt(streams.sequence, lastSequence)))
                .orderBy(streams.sequence)
                .limit(10);

              if (!chunks.length) {
                await new Promise((resolve) => setTimeout(resolve, 100));
                continue;
              }

              for (const chunk of chunks) {
                lastSequence = chunk.sequence;

                if (chunk.eof) {
                  closed = true;
                  controller.close();
                  return;
                }

                if (chunk.data.byteLength) {
                  controller.enqueue(new Uint8Array(chunk.data));
                }
              }
            }
          };

          poll().catch(() => {
            // Stream cancelled or error - silently close
            if (!closed) {
              closed = true;
              try {
                controller.close();
              } catch {
                // Already closed
              }
            }
          });
        },

        cancel() {
          closed = true;
        },
      });
    },

    async listStreamsByRunId(_runId: string): Promise<string[]> {
      // Not implemented for MySQL-Upstash
      return [];
    },

    async getStreamChunks(
      _name: string,
      _runId: string,
      _options?: GetChunksOptions,
    ): Promise<StreamChunksResponse> {
      // Not implemented for MySQL-Upstash
      return { data: [], hasMore: false, cursor: null, done: true };
    },

    async getStreamInfo(_name: string, _runId: string): Promise<StreamInfoResponse> {
      // Not implemented for MySQL-Upstash
      return { tailIndex: -1, done: false };
    },
  };
}

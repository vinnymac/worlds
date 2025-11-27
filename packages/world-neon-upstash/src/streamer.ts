import type { Streamer } from '@workflow/world';
import { and, asc, eq, gt } from 'drizzle-orm';
import type { NeonHttpDatabase } from 'drizzle-orm/neon-http';
import { monotonicFactory } from 'ulid';
import * as schema from './schema.js';

const { streams } = schema;

export function createStreamer(
  drizzle: NeonHttpDatabase<typeof schema>
): Streamer {
  const ulid = monotonicFactory();

  return {
    async writeToStream(
      name: string,
      _runId: string | Promise<string>,
      chunk: string | Uint8Array
    ) {
      // Await runId if it's a promise to ensure proper flushing
      await _runId;

      const chunkId = `chnk_${ulid()}` as `chnk_${string}`;
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
      });
    },

    async closeStream(name: string, _runId: string | Promise<string>) {
      // Await runId if it's a promise
      await _runId;

      const chunkId = `chnk_${ulid()}` as `chnk_${string}`;
      await drizzle.insert(streams).values({
        chunkId,
        streamId: name,
        chunkData: Buffer.from([]),
        eof: true,
      });
    },

    async readFromStream(streamName: string) {
      // HTTP-based polling implementation (no LISTEN/NOTIFY in Neon HTTP)
      let closed = false;
      let lastChunkId: `chnk_${string}` | undefined;

      const processChunks = (
        chunks: Array<{
          chunkId: `chnk_${string}`;
          chunkData: Buffer;
          eof: boolean;
        }>,
        controller: ReadableStreamDefaultController<Uint8Array>
      ): boolean => {
        for (const chunk of chunks) {
          if (chunk.eof) {
            closed = true;
            controller.close();
            return true;
          }
          controller.enqueue(new Uint8Array(chunk.chunkData));
          lastChunkId = chunk.chunkId;
        }
        return false;
      };

      return new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (closed) {
            controller.close();
            return;
          }

          const whereClause = lastChunkId
            ? and(
                eq(streams.streamId, streamName),
                gt(streams.chunkId, lastChunkId)
              )
            : eq(streams.streamId, streamName);

          const chunks = await drizzle
            .select()
            .from(streams)
            .where(whereClause)
            .orderBy(asc(streams.chunkId))
            .limit(10);

          if (chunks.length === 0) {
            await new Promise((resolve) => setTimeout(resolve, 100));
            return;
          }

          processChunks(chunks, controller);
        },

        cancel() {
          closed = true;
        },
      });
    },
  };
}

import type {
  GetChunksOptions,
  StreamChunk,
  StreamChunksResponse,
  StreamInfoResponse,
  Streamer,
} from '@workflow/world';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { MySql2Database } from 'drizzle-orm/mysql2';
import { monotonicFactory } from 'ulid';
import * as schema from './schema.js';

const { streams } = schema;

/** Opaque pagination cursor for getStreamChunks: last chunkId + running index. */
interface ChunkCursor {
  c: string;
  i: number;
}

function decodeChunkCursor(cursor: string | undefined): ChunkCursor | null {
  if (!cursor) return null;
  try {
    const decoded: unknown = JSON.parse(Buffer.from(cursor, 'base64').toString('utf-8'));
    if (
      decoded !== null &&
      typeof decoded === 'object' &&
      typeof (decoded as ChunkCursor).c === 'string' &&
      typeof (decoded as ChunkCursor).i === 'number'
    ) {
      return decoded as ChunkCursor;
    }
    return null;
  } catch {
    // Invalid cursor, start from beginning
    return null;
  }
}

/**
 * MySQL streamer using polling-based approach.
 *
 * Unlike PostgreSQL which uses NOTIFY/LISTEN for real-time push notifications,
 * MySQL lacks native pub/sub. Readers poll for new chunks instead.
 *
 * Ordering is by the monotonic ULID chunkId, never by timestamp. Chunks
 * written within the same millisecond (the norm for token streaming) would
 * collide on a timestamp sequence and be silently dropped or reordered.
 */
export function createStreamer(drizzle: MySql2Database<typeof schema>): Streamer {
  const ulid = monotonicFactory();

  const genChunkId = () => `chnk_${ulid()}` as const;

  const toBuffer = (chunk: string | Uint8Array): Buffer =>
    typeof chunk === 'string'
      ? Buffer.from(chunk)
      : Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(chunk);

  /** Count of data (non-EOF) chunks in a stream. */
  async function countDataChunks(name: string): Promise<number> {
    const [countResult] = await drizzle
      .select({ count: sql<number>`count(*)` })
      .from(streams)
      .where(and(eq(streams.streamId, name), eq(streams.eof, false)));
    return Number(countResult?.count ?? 0);
  }

  /** Whether the stream has an EOF marker (i.e. is closed). */
  async function isStreamDone(name: string): Promise<boolean> {
    const [eofRow] = await drizzle
      .select({ eof: streams.eof })
      .from(streams)
      .where(and(eq(streams.streamId, name), eq(streams.eof, true)))
      .limit(1);
    return Boolean(eofRow);
  }

  return {
    async writeToStream(
      name: string,
      _runId: string | Promise<string>,
      chunk: string | Uint8Array,
    ) {
      // Await runId if it's a promise to ensure proper flushing
      const runId = await _runId;

      await drizzle.insert(streams).values({
        chunkId: genChunkId(),
        streamId: name,
        runId,
        chunkData: toBuffer(chunk),
        eof: false,
        sequence: Date.now(),
      });
    },

    async closeStream(name: string, _runId: string | Promise<string>): Promise<void> {
      // Await runId if it's a promise to ensure proper flushing
      const runId = await _runId;

      await drizzle.insert(streams).values({
        chunkId: genChunkId(),
        streamId: name,
        runId,
        chunkData: Buffer.from([]),
        eof: true,
        sequence: Date.now(),
      });
    },

    async readFromStream(name: string, startIndex?: number): Promise<ReadableStream<Uint8Array>> {
      let closed = false;

      // startIndex is a chunk index: positive skips that many data chunks
      // from the start, negative starts that many chunks before the end.
      let remainingSkip = startIndex ?? 0;
      if (remainingSkip < 0) {
        const dataCount = await countDataChunks(name);
        remainingSkip = Math.max(0, dataCount + remainingSkip);
      }

      return new ReadableStream<Uint8Array>({
        async start(controller) {
          // Cursor over the monotonic ULID chunkId. The empty string sorts
          // before every ULID, so '' starts at the beginning.
          let lastChunkId = '';

          // Use a polling loop in start() rather than pull() because
          // Node.js ReadableStream doesn't reliably re-invoke pull()
          // when it resolves without enqueuing data.
          const poll = async () => {
            while (!closed) {
              const chunks = await drizzle
                .select({
                  chunkId: streams.chunkId,
                  eof: streams.eof,
                  data: streams.chunkData,
                })
                .from(streams)
                .where(and(eq(streams.streamId, name), sql`${streams.chunkId} > ${lastChunkId}`))
                .orderBy(asc(streams.chunkId))
                .limit(50);

              if (!chunks.length) {
                await new Promise((resolve) => setTimeout(resolve, 100));
                continue;
              }

              for (const chunk of chunks) {
                lastChunkId = chunk.chunkId;

                if (chunk.eof) {
                  closed = true;
                  controller.close();
                  return;
                }

                if (remainingSkip > 0) {
                  remainingSkip--;
                  continue;
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

    async listStreamsByRunId(runId: string): Promise<string[]> {
      const results = await drizzle
        .selectDistinct({ streamId: streams.streamId })
        .from(streams)
        .where(eq(streams.runId, runId));
      return results.map((r) => r.streamId);
    },

    async getStreamChunks(
      name: string,
      _runId: string,
      options?: GetChunksOptions,
    ): Promise<StreamChunksResponse> {
      const limit = options?.limit ?? 100;
      const cursor = decodeChunkCursor(options?.cursor);

      // Fetch only data rows (exclude EOF) with limit + 1 to detect hasMore.
      const rows = await drizzle
        .select({
          chunkId: streams.chunkId,
          data: streams.chunkData,
        })
        .from(streams)
        .where(
          and(
            eq(streams.streamId, name),
            eq(streams.eof, false),
            cursor ? sql`${streams.chunkId} > ${cursor.c}` : undefined,
          ),
        )
        .orderBy(asc(streams.chunkId))
        .limit(limit + 1);

      const hasMore = rows.length > limit;
      const pageRows = rows.slice(0, limit);
      const baseIndex = cursor?.i ?? 0;

      const chunks: StreamChunk[] = pageRows.map((row, i) => ({
        index: baseIndex + i,
        data: new Uint8Array(row.data),
      }));

      const lastRow = pageRows.at(-1);
      const nextCursor =
        hasMore && lastRow
          ? Buffer.from(
              JSON.stringify({
                c: lastRow.chunkId,
                i: baseIndex + pageRows.length,
              } satisfies ChunkCursor),
            ).toString('base64')
          : null;

      return {
        data: chunks,
        cursor: nextCursor,
        hasMore,
        done: await isStreamDone(name),
      };
    },

    async getStreamInfo(name: string, _runId: string): Promise<StreamInfoResponse> {
      const dataCount = await countDataChunks(name);
      return {
        tailIndex: dataCount - 1,
        done: await isStreamDone(name),
      };
    },
  };
}

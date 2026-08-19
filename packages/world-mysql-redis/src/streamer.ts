import type {
  GetChunksOptions,
  StreamChunksResponse,
  StreamInfoResponse,
  Streamer,
} from '@workflow/world';
import { and, eq, gt, or, sql } from 'drizzle-orm';
import type { MySql2Database } from 'drizzle-orm/mysql2';
import { monotonicFactory } from 'ulid';
import * as schema from './schema.js';
import { withDeadlockRetry } from './util.js';

const { streams } = schema;

/** How often readers poll for new chunks (ms). */
const POLL_INTERVAL_MS = 100;

/** Max chunks fetched per reader poll. */
const POLL_BATCH_SIZE = 50;

interface ChunkCursor {
  /** Last seen sequence */
  s?: number;
  /** Last seen chunkId (tiebreaker for legacy same-sequence rows) */
  c?: string;
  /** Running chunk index across pages */
  i?: number;
}

/**
 * MySQL streamer using polling-based approach.
 *
 * Unlike PostgreSQL which uses NOTIFY/LISTEN for real-time push notifications,
 * MySQL lacks native pub/sub. We use a sequence-based polling pattern instead:
 * - Each chunk gets a dense, per-stream monotonic sequence number allocated
 *   inside a transaction (MAX(sequence) + 1 under a FOR UPDATE range lock),
 *   so same-millisecond writes can never collide or reorder.
 * - Readers poll with a composite (sequence, chunkId) cursor; the chunkId
 *   tiebreaker keeps legacy rows (which used wall-clock sequences that could
 *   tie) readable without skipping.
 * - Poll interval of 100ms provides acceptable latency for most use cases.
 */
export function createStreamer(drizzle: MySql2Database<typeof schema>): Streamer {
  const ulid = monotonicFactory();

  const genChunkId = () => `chnk_${ulid()}` as const;

  /**
   * Insert a chunk with the next per-stream sequence. The SELECT ... FOR
   * UPDATE takes a range lock on the (streamId, sequence) index, serializing
   * concurrent writers for the same stream; deadlocks between the range lock
   * and the insert intention lock are retried.
   */
  async function insertChunk(
    streamId: string,
    runId: string | undefined,
    chunkData: Buffer,
    eof: boolean,
  ): Promise<void> {
    const chunkId = genChunkId();
    await withDeadlockRetry(() =>
      drizzle.transaction(async (tx) => {
        const [row] = await tx
          .select({ next: sql<number>`COALESCE(MAX(${streams.sequence}), -1) + 1` })
          .from(streams)
          .where(eq(streams.streamId, streamId))
          .for('update');
        await tx.insert(streams).values({
          chunkId,
          streamId,
          runId,
          chunkData,
          eof,
          sequence: Number(row?.next ?? 0),
        });
      }),
    );
  }

  function decodeCursor(cursor: string | undefined): Required<ChunkCursor> {
    const decoded: Required<ChunkCursor> = { s: -1, c: '', i: 0 };
    if (!cursor) return decoded;
    try {
      const parsed = JSON.parse(Buffer.from(cursor, 'base64').toString('utf-8')) as ChunkCursor;
      if (typeof parsed.s === 'number') decoded.s = parsed.s;
      if (typeof parsed.c === 'string') decoded.c = parsed.c;
      if (typeof parsed.i === 'number') decoded.i = parsed.i;
    } catch {
      // Invalid cursor: start from the beginning
    }
    return decoded;
  }

  /** WHERE clause for "strictly after the (sequence, chunkId) cursor". */
  function afterCursor(sequence: number, chunkId: string) {
    return or(
      gt(streams.sequence, sequence),
      // Raw comparison because the column type is branded (`chnk_${string}`)
      // while the cursor value is a plain string.
      and(eq(streams.sequence, sequence), sql`${streams.chunkId} > ${chunkId}`),
    );
  }

  async function countDataChunks(name: string): Promise<number> {
    const [countRow] = await drizzle
      .select({ count: sql<number>`COUNT(*)` })
      .from(streams)
      .where(and(eq(streams.streamId, name), eq(streams.eof, false)));
    return Number(countRow?.count ?? 0);
  }

  async function hasEof(name: string): Promise<boolean> {
    const [eofRow] = await drizzle
      .select({ eof: streams.eof })
      .from(streams)
      .where(and(eq(streams.streamId, name), eq(streams.eof, true)))
      .limit(1);
    return !!eofRow;
  }

  return {
    async writeToStream(
      name: string,
      _runId: string | Promise<string>,
      chunk: string | Uint8Array,
    ) {
      // Await runId if it's a promise to ensure proper flushing
      const runId = await _runId;

      const buffer =
        typeof chunk === 'string'
          ? Buffer.from(chunk)
          : Buffer.isBuffer(chunk)
            ? chunk
            : Buffer.from(chunk);

      await insertChunk(name, runId, buffer, false);
    },

    async closeStream(name: string, _runId: string | Promise<string>): Promise<void> {
      // Await runId if it's a promise to ensure proper flushing
      const runId = await _runId;

      await insertChunk(name, runId, Buffer.from([]), true);
    },

    async readFromStream(name: string, startIndex?: number): Promise<ReadableStream<Uint8Array>> {
      let closed = false;

      return new ReadableStream<Uint8Array>({
        async start(controller) {
          // Use a polling loop in start() rather than pull() because
          // Node.js ReadableStream doesn't reliably re-invoke pull()
          // when it resolves without enqueuing data.
          const poll = async () => {
            // startIndex is a 0-based data-chunk offset. Negative values
            // start that many chunks before the current end.
            let toSkip = startIndex ?? 0;
            if (toSkip < 0) {
              toSkip = Math.max(0, (await countDataChunks(name)) + toSkip);
            }

            let lastSequence = -1;
            let lastChunkId = '';

            while (!closed) {
              const chunks = await drizzle
                .select({
                  sequence: streams.sequence,
                  chunkId: streams.chunkId,
                  eof: streams.eof,
                  data: streams.chunkData,
                })
                .from(streams)
                .where(and(eq(streams.streamId, name), afterCursor(lastSequence, lastChunkId)))
                .orderBy(streams.sequence, streams.chunkId)
                .limit(POLL_BATCH_SIZE);

              if (!chunks.length) {
                await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
                continue;
              }

              for (const chunk of chunks) {
                lastSequence = chunk.sequence;
                lastChunkId = chunk.chunkId;

                if (chunk.eof) {
                  closed = true;
                  controller.close();
                  return;
                }

                if (toSkip > 0) {
                  toSkip--;
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
      const cursor = decodeCursor(options?.cursor);

      // Fetch only data rows (exclude EOF) with limit + 1 to detect hasMore.
      const rows = await drizzle
        .select({
          sequence: streams.sequence,
          chunkId: streams.chunkId,
          data: streams.chunkData,
        })
        .from(streams)
        .where(
          and(eq(streams.streamId, name), eq(streams.eof, false), afterCursor(cursor.s, cursor.c)),
        )
        .orderBy(streams.sequence, streams.chunkId)
        .limit(limit + 1);

      const hasMore = rows.length > limit;
      const pageRows = rows.slice(0, limit);
      const last = pageRows.at(-1);

      const nextCursor =
        hasMore && last
          ? Buffer.from(
              JSON.stringify({
                s: last.sequence,
                c: last.chunkId,
                i: cursor.i + pageRows.length,
              } satisfies ChunkCursor),
            ).toString('base64')
          : null;

      return {
        data: pageRows.map((row, i) => ({
          index: cursor.i + i,
          data: new Uint8Array(row.data),
        })),
        cursor: nextCursor,
        hasMore,
        done: await hasEof(name),
      };
    },

    async getStreamInfo(name: string, _runId: string): Promise<StreamInfoResponse> {
      const [dataCount, done] = await Promise.all([countDataChunks(name), hasEof(name)]);
      return { tailIndex: dataCount - 1, done };
    },
  };
}

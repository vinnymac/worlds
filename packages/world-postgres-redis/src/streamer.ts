import { EventEmitter } from 'node:events';
import type {
  GetChunksOptions,
  StreamChunk,
  StreamChunksResponse,
  StreamInfoResponse,
  Streamer,
} from '@workflow/world';
import { and, asc, eq, gt, sql } from 'drizzle-orm';
import type { Sql } from 'postgres';
import { monotonicFactory } from 'ulid';
import { type Drizzle, Schema } from './drizzle/index.js';
import { Mutex } from './util.js';

interface StreamPublishMessage {
  streamId: string;
  chunkId: `chnk_${string}`;
}

function parseStreamPublishMessage(raw: string): StreamPublishMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const { streamId, chunkId } = parsed as Record<string, unknown>;
  if (typeof streamId !== 'string' || typeof chunkId !== 'string') return null;
  if (!chunkId.startsWith('chnk_')) return null;
  return { streamId, chunkId: chunkId as `chnk_${string}` };
}

interface StreamChunkEvent {
  id: `chnk_${string}`;
  data: Uint8Array;
  eof: boolean;
}

class Rc<T extends { drop(): void }> {
  private refCount = 0;
  constructor(private resource: T) {}
  acquire() {
    this.refCount++;
    return {
      ...this.resource,
      [Symbol.dispose]: () => {
        this.release();
      },
    };
  }
  release() {
    this.refCount--;
    if (this.refCount <= 0) {
      this.resource.drop();
    }
  }
}

export function createStreamer(postgres: Sql, drizzle: Drizzle): Streamer {
  const ulid = monotonicFactory();
  const events = new EventEmitter<{
    [key: `strm:${string}`]: [StreamChunkEvent];
  }>();
  const { streams } = Schema;
  const genChunkId = () => `chnk_${ulid()}` as const;
  const mutexes = new Map<string, Rc<{ drop(): void; mutex: Mutex }>>();
  const getMutex = (key: string) => {
    let mutex = mutexes.get(key);
    if (!mutex) {
      mutex = new Rc({
        mutex: new Mutex(),
        drop: () => mutexes.delete(key),
      });
      mutexes.set(key, mutex);
    }
    return mutex.acquire();
  };

  const STREAM_TOPIC = 'workflow_event_chunk';
  postgres.listen(STREAM_TOPIC, async (msg) => {
    const parsed = parseStreamPublishMessage(msg);
    if (!parsed) return;

    const key = `strm:${parsed.streamId}` as const;
    if (!events.listenerCount(key)) {
      return;
    }

    const resource = getMutex(key);
    await resource.mutex.andThen(async () => {
      const [value] = await drizzle
        .select({ eof: streams.eof, data: streams.chunkData })
        .from(streams)
        .where(and(eq(streams.streamId, parsed.streamId), eq(streams.chunkId, parsed.chunkId)))
        .limit(1);
      if (!value) return;
      const { data, eof } = value;
      events.emit(key, { id: parsed.chunkId, data, eof });
    });
  });

  return {
    async writeToStream(
      name: string,
      _runId: string | Promise<string>,
      chunk: string | Uint8Array,
    ) {
      // Await runId if it's a promise to ensure proper flushing
      const runId = await _runId;

      const chunkId = genChunkId();
      await drizzle.insert(streams).values({
        chunkId,
        streamId: name,
        runId,
        chunkData: !Buffer.isBuffer(chunk) ? Buffer.from(chunk) : chunk,
        eof: false,
      });
      postgres.notify(
        STREAM_TOPIC,
        JSON.stringify({ streamId: name, chunkId } satisfies StreamPublishMessage),
      );
    },
    async closeStream(name: string, _runId: string | Promise<string>): Promise<void> {
      // Await runId if it's a promise to ensure proper flushing
      const runId = await _runId;

      const chunkId = genChunkId();
      await drizzle.insert(streams).values({
        chunkId,
        streamId: name,
        runId,
        chunkData: Buffer.from([]),
        eof: true,
      });
      postgres.notify(
        'workflow_event_chunk',
        JSON.stringify({ streamId: name, chunkId } satisfies StreamPublishMessage),
      );
    },
    async readFromStream(name: string, startIndex?: number): Promise<ReadableStream<Uint8Array>> {
      const cleanups: (() => void)[] = [];

      return new ReadableStream<Uint8Array>({
        async start(controller) {
          // an empty string is always < than any string,
          // so `'' < ulid()` and `ulid() < ulid()` (maintaining order)
          let lastChunkId = '';
          let offset = startIndex ?? 0;
          let buffer = [] as StreamChunkEvent[] | null;

          const shouldSkipChunk = (chunkId: string): boolean => {
            return lastChunkId >= chunkId;
          };

          const shouldApplyOffset = (): boolean => {
            if (offset > 0) {
              offset--;
              return true;
            }
            return false;
          };

          const enqueueChunkData = (msg: { id: string; data: Uint8Array; eof: boolean }): void => {
            if (msg.data.byteLength) {
              controller.enqueue(new Uint8Array(msg.data));
            }
            if (msg.eof) {
              controller.close();
            }
            lastChunkId = msg.id;
          };

          function enqueue(msg: { id: string; data: Uint8Array; eof: boolean }) {
            if (shouldSkipChunk(msg.id)) return;
            if (shouldApplyOffset()) return;
            enqueueChunkData(msg);
          }

          function onData(data: StreamChunkEvent) {
            if (buffer) {
              buffer.push(data);
              return;
            }
            enqueue(data);
          }
          events.on(`strm:${name}`, onData);
          cleanups.push(() => {
            events.off(`strm:${name}`, onData);
          });

          const chunks = await drizzle
            .select({
              id: streams.chunkId,
              eof: streams.eof,
              data: streams.chunkData,
            })
            .from(streams)
            .where(and(eq(streams.streamId, name)))
            .orderBy(streams.chunkId);

          for (const chunk of [...chunks, ...(buffer ?? [])]) {
            enqueue(chunk);
          }
          buffer = null;
        },
        cancel() {
          for (const fn of cleanups) {
            fn();
          }
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

      // Decode cursor: { c: last seen chunkId, i: running chunk index }
      let cursorChunkId: `chnk_${string}` | null = null;
      let baseIndex = 0;
      if (options?.cursor) {
        try {
          const decoded: unknown = JSON.parse(
            Buffer.from(options.cursor, 'base64').toString('utf-8'),
          );
          if (decoded && typeof decoded === 'object') {
            const { c, i } = decoded as { c?: unknown; i?: unknown };
            if (typeof c === 'string' && c.startsWith('chnk_')) {
              cursorChunkId = c as `chnk_${string}`;
            }
            if (typeof i === 'number') baseIndex = i;
          }
        } catch {
          // Invalid cursor, start from beginning
        }
      }

      // Fetch only data rows (exclude EOF) with limit + 1 to detect hasMore.
      const rows = await drizzle
        .select({ chunkId: streams.chunkId, data: streams.chunkData })
        .from(streams)
        .where(
          and(
            eq(streams.streamId, name),
            eq(streams.eof, false),
            cursorChunkId ? gt(streams.chunkId, cursorChunkId) : undefined,
          ),
        )
        .orderBy(asc(streams.chunkId))
        .limit(limit + 1);
      const hasMore = rows.length > limit;
      const pageRows = rows.slice(0, limit);

      // Check if stream is complete via a separate EOF query
      const [eofRow] = await drizzle
        .select({ eof: streams.eof })
        .from(streams)
        .where(and(eq(streams.streamId, name), eq(streams.eof, true)))
        .limit(1);

      const chunks: StreamChunk[] = pageRows.map((row, i) => ({
        index: baseIndex + i,
        data: new Uint8Array(row.data),
      }));
      const lastRow = pageRows.at(-1);
      const nextCursor =
        hasMore && lastRow
          ? Buffer.from(
              JSON.stringify({ c: lastRow.chunkId, i: baseIndex + pageRows.length }),
            ).toString('base64')
          : null;

      return {
        data: chunks,
        cursor: nextCursor,
        hasMore,
        done: !!eofRow,
      };
    },

    async getStreamInfo(name: string, _runId: string): Promise<StreamInfoResponse> {
      const [countResult] = await drizzle
        .select({ count: sql<number>`count(*)::int` })
        .from(streams)
        .where(and(eq(streams.streamId, name), eq(streams.eof, false)));
      const dataCount = countResult?.count ?? 0;

      const [eofRow] = await drizzle
        .select({ eof: streams.eof })
        .from(streams)
        .where(and(eq(streams.streamId, name), eq(streams.eof, true)))
        .limit(1);

      return {
        tailIndex: dataCount - 1,
        done: !!eofRow,
      };
    },
  };
}

import type { Container, SqlQuerySpec } from '@azure/cosmos';
import type {
  GetChunksOptions,
  StreamChunksResponse,
  StreamInfoResponse,
  Streamer,
} from '@workflow/world';
import { monotonicFactory } from 'ulid';
import { debug, withCosmosRetry } from './util.js';

interface StreamerConfig {
  /** Container for stream chunks (partition key: /streamId) */
  streamsContainer: Container;
}

interface ChunkDoc {
  id: string;
  streamId: string;
  runId: string;
  /**
   * Full monotonic ULID (prefixed) — the ordering and pagination key.
   * ULIDs generated in the same millisecond still sort correctly because the
   * monotonic factory increments the random suffix, unlike a numeric sequence
   * derived from the millisecond timestamp alone.
   */
  chunkId: string;
  /** Base64-encoded chunk payload (empty string for eof markers). */
  chunkData: string;
  eof: boolean;
  createdAt: string;
}

/** Opaque cursor payload for getStreamChunks pagination. */
interface ChunksCursor {
  /** Last chunkId of the previous page (exclusive lower bound). */
  c: string;
  /** 0-based data index of the first chunk on the next page. */
  i: number;
}

function encodeChunksCursor(cursor: ChunksCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64');
}

function decodeChunksCursor(cursor: string): ChunksCursor | undefined {
  try {
    const decoded: unknown = JSON.parse(Buffer.from(cursor, 'base64').toString('utf-8'));
    if (
      typeof decoded === 'object' &&
      decoded !== null &&
      typeof (decoded as ChunksCursor).c === 'string' &&
      typeof (decoded as ChunksCursor).i === 'number'
    ) {
      return decoded as ChunksCursor;
    }
  } catch {
    // Malformed cursor — treat as start-of-stream (matches world-local).
  }
  return undefined;
}

function decodeChunkData(doc: ChunkDoc): Uint8Array {
  return new Uint8Array(Buffer.from(doc.chunkData, 'base64'));
}

export function createStreamer(config: StreamerConfig): Streamer {
  const { streamsContainer } = config;
  const ulid = monotonicFactory();

  async function insertChunk(
    name: string,
    runId: string,
    chunkId: string,
    data: Buffer,
    eof: boolean,
  ): Promise<void> {
    await withCosmosRetry(() =>
      streamsContainer.items.create({
        id: chunkId,
        streamId: name,
        runId,
        chunkId,
        chunkData: data.toString('base64'),
        eof,
        createdAt: new Date().toISOString(),
      }),
    );
  }

  /**
   * Fetch chunks for a stream in chunkId (ULID) order, strictly after the
   * given cursor. Passing `null` fetches from the start of the stream.
   */
  async function fetchChunksAfter(name: string, afterChunkId: string | null): Promise<ChunkDoc[]> {
    const conditions = ['c.streamId = @streamId'];
    const parameters: { name: string; value: string }[] = [{ name: '@streamId', value: name }];
    if (afterChunkId !== null) {
      conditions.push('c.chunkId > @cursor');
      parameters.push({ name: '@cursor', value: afterChunkId });
    }
    const querySpec: SqlQuerySpec = {
      query: `SELECT * FROM c WHERE ${conditions.join(' AND ')} ORDER BY c.chunkId ASC`,
      parameters,
    };
    const { resources } = await withCosmosRetry(() =>
      streamsContainer.items.query<ChunkDoc>(querySpec, { partitionKey: name }).fetchAll(),
    );
    return resources;
  }

  return {
    streams: {
      async write(runId: string, name: string, chunk: string | Uint8Array) {
        // Allocate the chunkId BEFORE awaiting runId so chunks written in
        // sequence keep their order even when multiple writes await the same
        // pending runId promise.
        const chunkId = `chnk_${ulid()}` as `chnk_${string}`;

        const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk);
        await insertChunk(name, runId, chunkId, buffer, false);
      },

      async close(runId: string, name: string) {
        const chunkId = `chnk_${ulid()}` as `chnk_${string}`;

        await insertChunk(name, runId, chunkId, Buffer.from([]), true);
      },

      async get(_runId: string, streamName: string, startIndex = 0) {
        let closed = false;
        let pollTimer: ReturnType<typeof setTimeout> | undefined;
        // Exclusive lower bound for the poll query: the last chunkId we have
        // seen (data or eof). Full-ULID comparison never collides, unlike a
        // millisecond-derived numeric sequence.
        let lastSeenChunkId: string | null = null;

        return new ReadableStream<Uint8Array>({
          async start(controller) {
            function finish() {
              closed = true;
              if (pollTimer) clearTimeout(pollTimer);
              controller.close();
            }

            /**
             * Enqueue chunks in order, skipping the first `skipCount` data
             * chunks. Returns 'eof' when the stream-end marker is reached —
             * anything ordered after the marker is never delivered.
             */
            function deliver(docs: ChunkDoc[], skipCount: number): 'eof' | 'continue' {
              let skipped = 0;
              for (const doc of docs) {
                lastSeenChunkId = doc.chunkId;
                if (doc.eof) {
                  finish();
                  return 'eof';
                }
                if (skipped < skipCount) {
                  skipped++;
                  continue;
                }
                controller.enqueue(decodeChunkData(doc));
              }
              return 'continue';
            }

            // Deliver the existing backlog, resolving a negative startIndex
            // against the number of data chunks currently written.
            const initial = await fetchChunksAfter(streamName, null);
            const initialDataCount = initial.filter((doc) => !doc.eof).length;
            const resolvedStartIndex =
              startIndex < 0 ? Math.max(0, initialDataCount + startIndex) : startIndex;
            if (deliver(initial, resolvedStartIndex) === 'eof') return;

            // Poll for new chunks (Cosmos DB Change Feed alternative). Polling
            // is simpler and more reliable for this use case than the Change
            // Feed processor, which requires leases and is designed for
            // multi-consumer scenarios.
            function poll() {
              if (closed) return;

              fetchChunksAfter(streamName, lastSeenChunkId)
                .then((docs) => {
                  if (closed) return;
                  if (deliver(docs, 0) === 'eof') return;
                  pollTimer = setTimeout(poll, 100);
                })
                .catch((err) => {
                  if (!closed) {
                    debug('[readFromStream] Poll error:', err);
                    pollTimer = setTimeout(poll, 500);
                  }
                });
            }

            pollTimer = setTimeout(poll, 100);
          },

          cancel() {
            closed = true;
            if (pollTimer) {
              clearTimeout(pollTimer);
            }
          },
        });
      },

      async list(runId: string): Promise<string[]> {
        // Cross-partition query: chunk docs carry the owning runId.
        const querySpec: SqlQuerySpec = {
          query: 'SELECT DISTINCT VALUE c.streamId FROM c WHERE c.runId = @runId',
          parameters: [{ name: '@runId', value: runId }],
        };
        const { resources } = await withCosmosRetry(() =>
          streamsContainer.items.query<string>(querySpec).fetchAll(),
        );
        return resources;
      },

      async getChunks(
        _runId: string,
        name: string,
        options?: GetChunksOptions,
      ): Promise<StreamChunksResponse> {
        const limit = Math.min(options?.limit ?? 100, 1000);
        const cursor = options?.cursor ? decodeChunksCursor(options.cursor) : undefined;
        const startAfter = cursor?.c ?? null;
        const startDataIndex = cursor?.i ?? 0;

        // Fetch one extra doc beyond the page so eof/hasMore can be detected
        // without another round-trip (the extra doc is either the eof marker
        // or proof that more data chunks exist).
        const conditions = ['c.streamId = @streamId'];
        const parameters: { name: string; value: string | number }[] = [
          { name: '@streamId', value: name },
        ];
        if (startAfter !== null) {
          conditions.push('c.chunkId > @cursor');
          parameters.push({ name: '@cursor', value: startAfter });
        }
        const querySpec: SqlQuerySpec = {
          query: `SELECT * FROM c WHERE ${conditions.join(' AND ')} ORDER BY c.chunkId ASC OFFSET 0 LIMIT @limit`,
          parameters: [...parameters, { name: '@limit', value: limit + 1 }],
        };
        const { resources } = await withCosmosRetry(() =>
          streamsContainer.items.query<ChunkDoc>(querySpec, { partitionKey: name }).fetchAll(),
        );

        let done = false;
        let hasMore = false;
        let lastChunkId = startAfter;
        const chunks: StreamChunksResponse['data'] = [];
        for (const doc of resources) {
          if (doc.eof) {
            done = true;
            break;
          }
          if (chunks.length === limit) {
            hasMore = true;
            break;
          }
          chunks.push({ index: startDataIndex + chunks.length, data: decodeChunkData(doc) });
          lastChunkId = doc.chunkId;
        }

        return {
          data: chunks,
          cursor:
            hasMore && lastChunkId !== null
              ? encodeChunksCursor({ c: lastChunkId, i: startDataIndex + chunks.length })
              : null,
          hasMore,
          done,
        };
      },

      async getInfo(_runId: string, name: string): Promise<StreamInfoResponse> {
        // Only the eof flags are needed — never fetch chunk payloads.
        const querySpec: SqlQuerySpec = {
          query: 'SELECT c.eof FROM c WHERE c.streamId = @streamId ORDER BY c.chunkId ASC',
          parameters: [{ name: '@streamId', value: name }],
        };
        const { resources } = await withCosmosRetry(() =>
          streamsContainer.items
            .query<{ eof: boolean }>(querySpec, { partitionKey: name })
            .fetchAll(),
        );

        let dataCount = 0;
        let done = false;
        for (const doc of resources) {
          if (doc.eof) {
            done = true;
            break;
          }
          dataCount++;
        }
        return { tailIndex: dataCount - 1, done };
      },
    },
  };
}

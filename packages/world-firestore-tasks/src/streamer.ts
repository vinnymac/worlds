import type { CollectionReference, Firestore } from '@google-cloud/firestore';
import { WorkflowWorldError } from '@workflow/errors';
import type {
  GetChunksOptions,
  StreamChunk,
  StreamChunksResponse,
  StreamInfoResponse,
  Streamer,
} from '@workflow/world';
import { monotonicFactory } from 'ulid';

export interface FirestoreStreamerConfig {
  firestore: Firestore;
  /**
   * Streaming strategy:
   * - 'listener' (default): Firestore real-time listeners. Lowest latency but
   *   costs scale with subscribers x updates (one read per document change per listener).
   * - 'polling': Periodic polling. Higher latency but costs scale with subscriber
   *   count only, regardless of update frequency.
   */
  mode?: 'listener' | 'polling';
  /**
   * Polling interval (ms) when mode is 'polling'.
   * Default: 1000
   */
  pollIntervalMs?: number;
}

/** @deprecated Use FirestoreStreamerConfig instead */
type StreamerConfig = FirestoreStreamerConfig;

interface StoredChunk {
  chunkId: string;
  streamId: string;
  /** base64-encoded chunk payload */
  chunkData: string;
  eof: boolean;
}

interface ChunkCursor {
  /** 0-based index of the next data chunk */
  i: number;
  /** chunkId of the last chunk included in the previous page */
  c: string;
}

function decodeChunkData(chunk: StoredChunk): Uint8Array {
  return new Uint8Array(Buffer.from(chunk.chunkData, 'base64'));
}

export function createStreamer(config: StreamerConfig | FirestoreStreamerConfig): Streamer {
  const { firestore, mode = 'listener', pollIntervalMs = 1000 } = config;
  const ulid = monotonicFactory();

  function streamRef(name: string) {
    return firestore.collection('workflow_streams').doc(name);
  }

  function chunksCol(name: string): CollectionReference {
    return streamRef(name).collection('chunks');
  }

  // Streams already registered for a run in this process (avoids a parent-doc
  // write per chunk; the parent doc powers listStreamsByRunId).
  const registeredStreams = new Set<string>();

  async function registerStreamForRun(runId: string, name: string): Promise<void> {
    const cacheKey = `${runId}:${name}`;
    if (registeredStreams.has(cacheKey)) return;
    await streamRef(name).set({ streamId: name, runId }, { merge: true });
    registeredStreams.add(cacheKey);
  }

  /**
   * Reader state shared by both modes. Chunks are ordered by their full
   * monotonic ULID chunkId (string comparison), never by a truncated
   * numeric timestamp, which collides for same-millisecond writes.
   */
  interface ReadState {
    /** chunkId of the last chunk delivered or skipped */
    lastChunkId: string;
    /** data chunks still to skip to honor a positive startIndex */
    remainingSkip: number;
    /** the stream was closed (EOF observed) */
    closed: boolean;
  }

  /**
   * Read all historical chunks, resolving startIndex (negative = from the
   * tail, per the Streamer contract) and enqueueing everything at or after
   * the resolved position.
   */
  async function readHistorical(
    name: string,
    startIndex: number,
    controller: ReadableStreamDefaultController<Uint8Array>,
  ): Promise<ReadState> {
    const snapshot = await chunksCol(name).orderBy('chunkId', 'asc').get();
    const chunks = snapshot.docs.map((doc) => doc.data() as StoredChunk);
    const dataChunkCount = chunks.filter((chunk) => !chunk.eof).length;
    const resolvedStart =
      startIndex < 0 ? Math.max(0, dataChunkCount + startIndex) : Math.max(0, startIndex);

    const state: ReadState = { lastChunkId: '', remainingSkip: resolvedStart, closed: false };

    for (const chunk of chunks) {
      if (chunk.eof) {
        state.closed = true;
        controller.close();
        return state;
      }
      state.lastChunkId = chunk.chunkId;
      if (state.remainingSkip > 0) {
        state.remainingSkip--;
        continue;
      }
      controller.enqueue(decodeChunkData(chunk));
    }

    return state;
  }

  /**
   * Deliver a batch of new chunks in chunkId order, handling skip and EOF.
   * Returns true when the stream was closed.
   */
  function deliverChunks(
    chunks: StoredChunk[],
    state: ReadState,
    controller: ReadableStreamDefaultController<Uint8Array>,
    onClose: () => void,
  ): boolean {
    // Sort by full ULID so same-millisecond writes keep their write order;
    // the EOF marker is written last and therefore sorts last.
    const ordered = [...chunks].sort((a, b) => (a.chunkId < b.chunkId ? -1 : 1));
    for (const chunk of ordered) {
      if (chunk.chunkId <= state.lastChunkId) continue;
      if (chunk.eof) {
        state.closed = true;
        onClose();
        controller.close();
        return true;
      }
      state.lastChunkId = chunk.chunkId;
      if (state.remainingSkip > 0) {
        state.remainingSkip--;
        continue;
      }
      controller.enqueue(decodeChunkData(chunk));
    }
    return false;
  }

  /**
   * Read from stream using Firestore real-time listeners (default mode).
   * Lowest latency, but each listener incurs a read cost per document change.
   */
  function readFromStreamListener(name: string, startIndex: number): ReadableStream<Uint8Array> {
    let unsubscribe: (() => void) | undefined;
    let state: ReadState | undefined;
    const pending: StoredChunk[] = [];
    let waitingForData: (() => void) | undefined;

    function notifyWaitingReaders() {
      if (waitingForData) {
        waitingForData();
        waitingForData = undefined;
      }
    }

    function flush(controller: ReadableStreamDefaultController<Uint8Array>) {
      if (!state || state.closed) return;
      const batch = pending.splice(0, pending.length);
      if (batch.length === 0) return;
      deliverChunks(batch, state, controller, () => {
        unsubscribe?.();
      });
    }

    return new ReadableStream<Uint8Array>({
      async start(controller) {
        state = await readHistorical(name, startIndex, controller);
        if (state.closed) return;

        // Listen for chunks written after the historical read. The query is
        // keyed on the full chunkId so same-millisecond siblings are never
        // skipped or deadlocked.
        let query = chunksCol(name).orderBy('chunkId', 'asc');
        if (state.lastChunkId) {
          query = query.where('chunkId', '>', state.lastChunkId);
        }
        unsubscribe = query.onSnapshot((snapshot) => {
          const added = snapshot
            .docChanges()
            .filter((change) => change.type === 'added')
            .map((change) => change.doc.data() as StoredChunk);
          if (added.length === 0) return;
          pending.push(...added);
          flush(controller);
          notifyWaitingReaders();
        });
      },

      async pull(controller) {
        if (state?.closed) {
          return;
        }

        if (pending.length > 0) {
          flush(controller);
          return;
        }

        // Wait for new data from listener
        await new Promise<void>((resolve) => {
          waitingForData = resolve;
          // Timeout after 30 seconds to prevent indefinite hanging
          setTimeout(resolve, 30000);
        });
      },

      cancel() {
        if (state) state.closed = true;
        unsubscribe?.();
      },
    });
  }

  /**
   * Read from stream using periodic polling (cost-optimized mode).
   * Higher latency (configurable via pollIntervalMs) but costs scale with
   * subscriber count only, not update frequency.
   */
  function readFromStreamPolling(name: string, startIndex: number): ReadableStream<Uint8Array> {
    let state: ReadState | undefined;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;

    return new ReadableStream<Uint8Array>({
      async start(controller) {
        state = await readHistorical(name, startIndex, controller);
      },

      async pull(controller) {
        if (!state || state.closed) {
          return;
        }

        // Poll for new chunks at the configured interval. The `>` filter on
        // the full chunkId guarantees a chunk is only consumed once and that
        // same-millisecond siblings are not skipped.
        while (!state.closed) {
          let query = chunksCol(name).orderBy('chunkId', 'asc');
          if (state.lastChunkId) {
            query = query.where('chunkId', '>', state.lastChunkId);
          }
          const snapshot = await query.get();

          if (snapshot.empty) {
            // No new data, wait and poll again
            await new Promise<void>((resolve) => {
              pollTimer = setTimeout(resolve, pollIntervalMs);
            });
            continue;
          }

          const chunks = snapshot.docs.map((doc) => doc.data() as StoredChunk);
          const before = state.lastChunkId;
          if (deliverChunks(chunks, state, controller, () => {})) {
            return;
          }
          // Enqueued at least one chunk: return to let the consumer process
          // it. If everything was skipped (startIndex), keep polling.
          if (state.lastChunkId !== before && state.remainingSkip === 0) {
            return;
          }
        }
      },

      cancel() {
        if (state) state.closed = true;
        if (pollTimer) {
          clearTimeout(pollTimer);
        }
      },
    });
  }

  return {
    async writeToStream(
      name: string,
      _runId: string | Promise<string>,
      chunk: string | Uint8Array,
    ) {
      // Generate the chunkId synchronously BEFORE any await so ULID order
      // matches call order even when runId is a promise multiple writes
      // are waiting on.
      const chunkId = `chnk_${ulid()}` as `chnk_${string}`;
      const runId = await _runId;
      await registerStreamForRun(runId, name);

      const buffer =
        typeof chunk === 'string'
          ? Buffer.from(chunk)
          : Buffer.isBuffer(chunk)
            ? chunk
            : Buffer.from(chunk);

      await chunksCol(name)
        .doc(chunkId)
        .set({
          chunkId,
          streamId: name,
          chunkData: buffer.toString('base64'),
          eof: false,
          createdAt: new Date(),
        });
    },

    async closeStream(name: string, _runId: string | Promise<string>) {
      const chunkId = `chnk_${ulid()}` as `chnk_${string}`;
      const runId = await _runId;
      await registerStreamForRun(runId, name);

      await chunksCol(name).doc(chunkId).set({
        chunkId,
        streamId: name,
        chunkData: '',
        eof: true,
        createdAt: new Date(),
      });
    },

    async readFromStream(streamName: string, startIndex = 0) {
      if (mode === 'polling') {
        return readFromStreamPolling(streamName, startIndex);
      }
      return readFromStreamListener(streamName, startIndex);
    },

    async listStreamsByRunId(runId: string): Promise<string[]> {
      const snapshot = await firestore
        .collection('workflow_streams')
        .where('runId', '==', runId)
        .get();
      return snapshot.docs.map((doc) => {
        const streamId = doc.data().streamId;
        return typeof streamId === 'string' ? streamId : doc.id;
      });
    },

    async getStreamChunks(
      name: string,
      _runId: string,
      options?: GetChunksOptions,
    ): Promise<StreamChunksResponse> {
      const limit = Math.min(Math.max(options?.limit ?? 100, 1), 1000);

      let cursor: ChunkCursor = { i: 0, c: '' };
      if (options?.cursor) {
        try {
          const decoded = JSON.parse(Buffer.from(options.cursor, 'base64').toString('utf-8'));
          if (typeof decoded?.i !== 'number' || typeof decoded?.c !== 'string') {
            throw new Error('malformed cursor payload');
          }
          cursor = decoded as ChunkCursor;
        } catch (error) {
          throw new WorkflowWorldError(`Invalid stream cursor: ${String(error)}`, { status: 400 });
        }
      }

      let query = chunksCol(name).orderBy('chunkId', 'asc');
      if (cursor.c) {
        query = query.where('chunkId', '>', cursor.c);
      }
      // limit + 1 to detect whether more data (or the EOF marker) follows.
      const snapshot = await query.limit(limit + 1).get();

      const data: StreamChunk[] = [];
      let done = false;
      let hasMore = false;
      let lastChunkId = cursor.c;
      for (const doc of snapshot.docs) {
        const chunk = doc.data() as StoredChunk;
        if (chunk.eof) {
          done = true;
          break;
        }
        if (data.length >= limit) {
          hasMore = true;
          break;
        }
        data.push({ index: cursor.i + data.length, data: decodeChunkData(chunk) });
        lastChunkId = chunk.chunkId;
      }

      const nextCursor = hasMore
        ? Buffer.from(
            JSON.stringify({ i: cursor.i + data.length, c: lastChunkId } satisfies ChunkCursor),
          ).toString('base64')
        : null;

      return { data, cursor: nextCursor, hasMore, done };
    },

    async getStreamInfo(name: string, _runId: string): Promise<StreamInfoResponse> {
      // Project only the eof flag; metadata never needs chunk payloads.
      const snapshot = await chunksCol(name).select('eof').get();
      let dataCount = 0;
      let done = false;
      for (const doc of snapshot.docs) {
        if (doc.get('eof') === true) {
          done = true;
        } else {
          dataCount++;
        }
      }
      return { tailIndex: dataCount - 1, done };
    },
  };
}

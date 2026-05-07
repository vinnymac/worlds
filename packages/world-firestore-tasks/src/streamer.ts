import type { Firestore } from '@google-cloud/firestore';
import type {
  GetChunksOptions,
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

export function createStreamer(config: StreamerConfig | FirestoreStreamerConfig): Streamer {
  const { firestore, mode = 'listener', pollIntervalMs = 1000 } = config;
  const ulid = monotonicFactory();

  /**
   * Read from stream using Firestore real-time listeners (default mode).
   * Lowest latency, but each listener incurs a read cost per document change.
   */
  function readFromStreamListener(streamName: string): ReadableStream<Uint8Array> {
    let closed = false;
    let unsubscribe: (() => void) | undefined;
    const chunkBuffer: Array<{ sequence: number; data: Uint8Array }> = [];
    let nextExpectedSequence = 0;
    let waitingForData: (() => void) | undefined;

    // Helper: Process a new chunk and return action to take
    function handleNewChunk(
      chunk: any,
      controller: ReadableStreamDefaultController<Uint8Array>,
    ): 'eof' | 'continue' {
      if (chunk.eof) {
        closed = true;
        controller.close();
        if (unsubscribe) unsubscribe();
        return 'eof';
      }

      const data = Buffer.from(chunk.chunkData, 'base64');
      chunkBuffer.push({
        sequence: chunk.sequence,
        data: new Uint8Array(data),
      });

      chunkBuffer.sort((a, b) => a.sequence - b.sequence);
      return 'continue';
    }

    // Helper: Flush ordered chunks from buffer
    // Sequences are ULID-derived (monotonically increasing but not consecutive),
    // so flush all chunks whose sequence >= nextExpectedSequence in order.
    function flushOrderedChunks(controller: ReadableStreamDefaultController<Uint8Array>) {
      while (chunkBuffer.length > 0 && chunkBuffer[0].sequence >= nextExpectedSequence) {
        const nextChunk = chunkBuffer.shift();
        if (nextChunk) {
          controller.enqueue(nextChunk.data);
          nextExpectedSequence = nextChunk.sequence + 1;
        }
      }
    }

    // Helper: Wake any waiting readers
    function notifyWaitingReaders() {
      if (waitingForData) {
        waitingForData();
        waitingForData = undefined;
      }
    }

    return new ReadableStream<Uint8Array>({
      async start(controller) {
        // First, fetch any historical chunks that already exist
        const historicalSnapshot = await firestore
          .collection('workflow_streams')
          .doc(streamName)
          .collection('chunks')
          .orderBy('sequence', 'asc')
          .get();

        // Process historical chunks in order
        for (const doc of historicalSnapshot.docs) {
          const chunk = doc.data();

          if (chunk.eof) {
            closed = true;
            controller.close();
            return;
          }

          const data = Buffer.from(chunk.chunkData, 'base64');
          controller.enqueue(new Uint8Array(data));
          nextExpectedSequence = chunk.sequence + 1;
        }

        // If we found an EOF in historical data, we're done
        if (closed) {
          return;
        }

        // Set up real-time listener for new chunks
        unsubscribe = firestore
          .collection('workflow_streams')
          .doc(streamName)
          .collection('chunks')
          .where('sequence', '>=', nextExpectedSequence)
          .orderBy('sequence', 'asc')
          .onSnapshot((snapshot) => {
            const addedChunks = snapshot
              .docChanges()
              .filter((change) => change.type === 'added')
              .map((change) => change.doc.data());

            for (const chunk of addedChunks) {
              const action = handleNewChunk(chunk, controller);
              if (action === 'eof') {
                return;
              }
            }

            flushOrderedChunks(controller);
            notifyWaitingReaders();
          });
      },

      async pull(controller) {
        // If stream is closed, finish
        if (closed) {
          controller.close();
          return;
        }

        // If we have buffered chunks ready, process them
        if (chunkBuffer.length > 0 && chunkBuffer[0].sequence >= nextExpectedSequence) {
          const chunk = chunkBuffer.shift();
          if (chunk) {
            controller.enqueue(chunk.data);
            nextExpectedSequence = chunk.sequence + 1;
          }
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
        closed = true;
        if (unsubscribe) {
          unsubscribe();
        }
      },
    });
  }

  /**
   * Read from stream using periodic polling (cost-optimized mode).
   * Higher latency (configurable via pollIntervalMs) but costs scale with
   * subscriber count only, not update frequency.
   */
  function readFromStreamPolling(streamName: string): ReadableStream<Uint8Array> {
    let closed = false;
    let nextExpectedSequence = 0;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;

    return new ReadableStream<Uint8Array>({
      async start(controller) {
        // Fetch any historical chunks that already exist
        const historicalSnapshot = await firestore
          .collection('workflow_streams')
          .doc(streamName)
          .collection('chunks')
          .orderBy('sequence', 'asc')
          .get();

        for (const doc of historicalSnapshot.docs) {
          const chunk = doc.data();

          if (chunk.eof) {
            closed = true;
            controller.close();
            return;
          }

          const data = Buffer.from(chunk.chunkData, 'base64');
          controller.enqueue(new Uint8Array(data));
          nextExpectedSequence = chunk.sequence + 1;
        }
      },

      async pull(controller) {
        if (closed) {
          controller.close();
          return;
        }

        // Poll for new chunks at the configured interval
        while (!closed) {
          const snapshot = await firestore
            .collection('workflow_streams')
            .doc(streamName)
            .collection('chunks')
            .where('sequence', '>=', nextExpectedSequence)
            .orderBy('sequence', 'asc')
            .get();

          if (snapshot.empty) {
            // No new data, wait and poll again
            await new Promise<void>((resolve) => {
              pollTimer = setTimeout(resolve, pollIntervalMs);
            });
            continue;
          }

          for (const doc of snapshot.docs) {
            const chunk = doc.data();

            if (chunk.eof) {
              closed = true;
              controller.close();
              return;
            }

            const data = Buffer.from(chunk.chunkData, 'base64');
            controller.enqueue(new Uint8Array(data));
            nextExpectedSequence = chunk.sequence + 1;
          }

          // Enqueued at least one chunk, return to let consumer process it
          return;
        }
      },

      cancel() {
        closed = true;
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
      // Await runId if it's a promise to ensure proper flushing
      await _runId;

      const chunkId = `chnk_${ulid()}` as `chnk_${string}`;
      const sequence = Number.parseInt(ulid().substring(0, 10), 36);

      const buffer =
        typeof chunk === 'string'
          ? Buffer.from(chunk)
          : Buffer.isBuffer(chunk)
            ? chunk
            : Buffer.from(chunk);

      await firestore
        .collection('workflow_streams')
        .doc(name)
        .collection('chunks')
        .doc(chunkId)
        .set({
          chunkId,
          streamId: name,
          sequence,
          chunkData: buffer.toString('base64'),
          eof: false,
          createdAt: new Date(),
        });
    },

    async closeStream(name: string, _runId: string | Promise<string>) {
      await _runId;

      const chunkId = `chnk_${ulid()}` as `chnk_${string}`;
      const sequence = Number.parseInt(ulid().substring(0, 10), 36);

      await firestore
        .collection('workflow_streams')
        .doc(name)
        .collection('chunks')
        .doc(chunkId)
        .set({
          chunkId,
          streamId: name,
          sequence,
          chunkData: '',
          eof: true,
          createdAt: new Date(),
        });
    },

    async readFromStream(streamName: string) {
      if (mode === 'polling') {
        return readFromStreamPolling(streamName);
      }
      return readFromStreamListener(streamName);
    },

    async listStreamsByRunId(_runId: string): Promise<string[]> {
      // Not implemented for Firestore
      return [];
    },

    async getStreamChunks(
      _name: string,
      _runId: string,
      _options?: GetChunksOptions,
    ): Promise<StreamChunksResponse> {
      // Not implemented for Firestore
      return { data: [], hasMore: false, cursor: null, done: true };
    },

    async getStreamInfo(_name: string, _runId: string): Promise<StreamInfoResponse> {
      // Not implemented for Firestore
      return { tailIndex: -1, done: false };
    },
  };
}

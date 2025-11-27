import type { Firestore } from '@google-cloud/firestore';
import type { Streamer } from '@workflow/world';
import { monotonicFactory } from 'ulid';

interface StreamerConfig {
  firestore: Firestore;
}

export function createStreamer(config: StreamerConfig): Streamer {
  const { firestore } = config;
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
      let closed = false;
      let unsubscribe: (() => void) | undefined;
      const chunkBuffer: Array<{ sequence: number; data: Uint8Array }> = [];
      let nextExpectedSequence = 0;
      let waitingForData: (() => void) | undefined;

      // Helper: Process a new chunk and return action to take
      function handleNewChunk(
        chunk: any,
        controller: ReadableStreamDefaultController<Uint8Array>
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
      function flushOrderedChunks(
        controller: ReadableStreamDefaultController<Uint8Array>
      ) {
        while (
          chunkBuffer.length > 0 &&
          chunkBuffer[0].sequence === nextExpectedSequence
        ) {
          const nextChunk = chunkBuffer.shift();
          if (nextChunk) {
            controller.enqueue(nextChunk.data);
            nextExpectedSequence++;
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
          if (
            chunkBuffer.length > 0 &&
            chunkBuffer[0].sequence === nextExpectedSequence
          ) {
            const chunk = chunkBuffer.shift();
            if (chunk) {
              controller.enqueue(chunk.data);
              nextExpectedSequence++;
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
    },
  };
}

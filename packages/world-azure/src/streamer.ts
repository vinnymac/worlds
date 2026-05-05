import type { Container } from '@azure/cosmos';
import type {
  GetChunksOptions,
  StreamChunksResponse,
  StreamInfoResponse,
  Streamer,
} from '@workflow/world';
import { monotonicFactory } from 'ulid';

interface StreamerConfig {
  /** Container for stream chunks (partition key: /streamId) */
  streamsContainer: Container;
}

export function createStreamer(config: StreamerConfig): Streamer {
  const { streamsContainer } = config;
  const ulid = monotonicFactory();

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

      await streamsContainer.items.create({
        id: chunkId,
        streamId: name,
        chunkId,
        sequence,
        chunkData: buffer.toString('base64'),
        eof: false,
        createdAt: new Date().toISOString(),
      });
    },

    async closeStream(name: string, _runId: string | Promise<string>) {
      await _runId;

      const chunkId = `chnk_${ulid()}` as `chnk_${string}`;
      const sequence = Number.parseInt(ulid().substring(0, 10), 36);

      await streamsContainer.items.create({
        id: chunkId,
        streamId: name,
        chunkId,
        sequence,
        chunkData: '',
        eof: true,
        createdAt: new Date().toISOString(),
      });
    },

    async readFromStream(streamName: string) {
      let closed = false;
      let pollTimer: ReturnType<typeof setTimeout> | undefined;
      const chunkBuffer: Array<{ sequence: number; data: Uint8Array }> = [];
      let nextExpectedSequence = 0;
      let waitingForData: (() => void) | undefined;

      // Helper: Process a new chunk
      function handleNewChunk(
        chunk: Record<string, unknown>,
        controller: ReadableStreamDefaultController<Uint8Array>,
      ): 'eof' | 'continue' {
        if (chunk.eof) {
          closed = true;
          controller.close();
          if (pollTimer) clearTimeout(pollTimer);
          return 'eof';
        }

        const data = Buffer.from(chunk.chunkData as string, 'base64');
        chunkBuffer.push({
          sequence: chunk.sequence as number,
          data: new Uint8Array(data),
        });

        chunkBuffer.sort((a, b) => a.sequence - b.sequence);
        return 'continue';
      }

      // Helper: Flush ordered chunks from buffer
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
          const { resources: historicalChunks } = await streamsContainer.items
            .query(
              {
                query: 'SELECT * FROM c WHERE c.streamId = @streamId ORDER BY c.sequence ASC',
                parameters: [{ name: '@streamId', value: streamName }],
              },
              { partitionKey: streamName },
            )
            .fetchAll();

          // Process historical chunks in order
          for (const chunk of historicalChunks) {
            if (chunk.eof) {
              closed = true;
              controller.close();
              return;
            }

            const data = Buffer.from(chunk.chunkData, 'base64');
            controller.enqueue(new Uint8Array(data));
            nextExpectedSequence = chunk.sequence + 1;
          }

          if (closed) return;

          // Set up polling for new chunks (Cosmos DB Change Feed alternative)
          // Polling is simpler and more reliable for this use case than the Change Feed
          // processor which requires leases and is designed for multi-consumer scenarios.
          function poll() {
            if (closed) return;

            streamsContainer.items
              .query(
                {
                  query:
                    'SELECT * FROM c WHERE c.streamId = @streamId AND c.sequence >= @seq ORDER BY c.sequence ASC',
                  parameters: [
                    { name: '@streamId', value: streamName },
                    { name: '@seq', value: nextExpectedSequence },
                  ],
                },
                { partitionKey: streamName },
              )
              .fetchAll()
              .then(({ resources }) => {
                if (closed) return;

                for (const chunk of resources) {
                  const action = handleNewChunk(chunk, controller);
                  if (action === 'eof') return;
                }

                flushOrderedChunks(controller);
                notifyWaitingReaders();

                // Continue polling
                if (!closed) {
                  pollTimer = setTimeout(poll, 100);
                }
              })
              .catch((err) => {
                if (!closed) {
                  console.error('[readFromStream] Poll error:', err);
                  pollTimer = setTimeout(poll, 500);
                }
              });
          }

          // Start polling
          pollTimer = setTimeout(poll, 100);
        },

        async pull(controller) {
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

          // Wait for new data from polling
          await new Promise<void>((resolve) => {
            waitingForData = resolve;
            // Timeout after 30 seconds to prevent indefinite hanging
            setTimeout(resolve, 30000);
          });
        },

        cancel() {
          closed = true;
          if (pollTimer) {
            clearTimeout(pollTimer);
          }
        },
      });
    },

    async listStreamsByRunId(_runId: string): Promise<string[]> {
      // Not implemented for Cosmos DB
      return [];
    },

    async getStreamChunks(
      _name: string,
      _runId: string,
      _options?: GetChunksOptions,
    ): Promise<StreamChunksResponse> {
      // Not implemented for Cosmos DB
      return { data: [], hasMore: false, cursor: null, done: true };
    },

    async getStreamInfo(_name: string, _runId: string): Promise<StreamInfoResponse> {
      // Not implemented for Cosmos DB
      return { tailIndex: -1, done: false };
    },
  };
}

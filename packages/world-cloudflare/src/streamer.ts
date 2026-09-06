import type {
  GetChunksOptions,
  StreamChunk,
  StreamChunksResponse,
  StreamInfoResponse,
  Streamer,
} from '@workflow/world';

export interface CloudflareStreamerConfig {
  env: {
    WORKFLOW_STREAMS: StreamDONamespace;
  };
}

/**
 * RPC surface of StreamDO (see durable-objects/StreamDO.ts). The streamer
 * talks to the DO exclusively via these methods; there is no fetch()
 * protocol.
 */
export interface StreamDOStub {
  writeChunk(data: Uint8Array): Promise<number>;
  closeStream(): Promise<void>;
  getChunks(params: {
    startIndex: number;
    limit: number;
  }): Promise<{ chunks: Uint8Array[]; done: boolean; tailIndex: number }>;
  getInfo(): Promise<{ tailIndex: number; done: boolean }>;
  registerStream(name: string): Promise<void>;
  listStreams(): Promise<string[]>;
}

export interface StreamDONamespace {
  idFromName(name: string): StreamDOId;
  get(id: StreamDOId): StreamDOStub;
}

export interface StreamDOId {
  toString(): string;
}

/** Poll interval while waiting for new chunks on a live stream. */
const READ_POLL_MS = 100;
/** Chunks fetched per DO round-trip while reading. */
const READ_BATCH_SIZE = 32;
/** Default / maximum page sizes for streams.getChunks. */
const DEFAULT_CHUNK_PAGE_SIZE = 100;
const MAX_CHUNK_PAGE_SIZE = 1000;

export function createStreamer(config: CloudflareStreamerConfig): Streamer {
  const { env } = config;

  const getStreamDO = (streamName: string): StreamDOStub => {
    const id = env.WORKFLOW_STREAMS.idFromName(`stream:${streamName}`);
    return env.WORKFLOW_STREAMS.get(id);
  };

  const getRunRegistryDO = (runId: string): StreamDOStub => {
    const id = env.WORKFLOW_STREAMS.idFromName(`run-streams:${runId}`);
    return env.WORKFLOW_STREAMS.get(id);
  };

  /** Per-isolate cache so each (runId, stream) pair registers only once. */
  const registeredStreams = new Set<string>();

  async function registerStreamForRun(runId: string, name: string): Promise<void> {
    const cacheKey = `${runId}\u0000${name}`;
    if (registeredStreams.has(cacheKey)) return;
    await getRunRegistryDO(runId).registerStream(name);
    registeredStreams.add(cacheKey);
  }

  function toBytes(chunk: string | Uint8Array): Uint8Array {
    return typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk;
  }

  return {
    streams: {
      async write(runId: string, name: string, chunk: string | Uint8Array) {
        await registerStreamForRun(runId, name);
        await getStreamDO(name).writeChunk(toBytes(chunk));
      },

      async writeMulti(runId: string, name: string, chunks: (string | Uint8Array)[]) {
        await registerStreamForRun(runId, name);
        const stub = getStreamDO(name);
        for (const chunk of chunks) {
          await stub.writeChunk(toBytes(chunk));
        }
      },

      async close(runId: string, name: string) {
        await registerStreamForRun(runId, name);
        await getStreamDO(name).closeStream();
      },

      async get(_runId: string, name: string, startIndex = 0) {
        const stub = getStreamDO(name);

        // Negative startIndex counts back from the current end, clamped to 0.
        let nextIndex: number;
        if (startIndex < 0) {
          const info = await stub.getInfo();
          nextIndex = Math.max(0, info.tailIndex + 1 + startIndex);
        } else {
          nextIndex = startIndex;
        }

        let cancelled = false;

        return new ReadableStream<Uint8Array>({
          async pull(controller) {
            // Loop until we can enqueue data, close, or the reader cancels.
            // Errors from the DO propagate and error the stream; readers must
            // never see a silently-truncated stream.
            while (!cancelled) {
              const { chunks, done } = await stub.getChunks({
                startIndex: nextIndex,
                limit: READ_BATCH_SIZE,
              });
              if (chunks.length > 0) {
                for (const chunk of chunks) {
                  controller.enqueue(chunk);
                }
                nextIndex += chunks.length;
                return;
              }
              if (done) {
                controller.close();
                return;
              }
              await new Promise((resolve) => setTimeout(resolve, READ_POLL_MS));
            }
          },

          cancel() {
            cancelled = true;
          },
        });
      },

      async list(runId: string): Promise<string[]> {
        return getRunRegistryDO(runId).listStreams();
      },

      async getChunks(
        _runId: string,
        name: string,
        options?: GetChunksOptions,
      ): Promise<StreamChunksResponse> {
        const limit = Math.min(options?.limit ?? DEFAULT_CHUNK_PAGE_SIZE, MAX_CHUNK_PAGE_SIZE);
        const startIndex = options?.cursor ? Number.parseInt(options.cursor, 10) : 0;
        if (Number.isNaN(startIndex) || startIndex < 0) {
          throw new Error(`Invalid stream cursor: ${options?.cursor}`);
        }

        const stub = getStreamDO(name);
        const result = await stub.getChunks({ startIndex, limit: limit + 1 });
        const hasMore = result.chunks.length > limit;
        const data: StreamChunk[] = result.chunks
          .slice(0, limit)
          .map((chunk, offset) => ({ index: startIndex + offset, data: chunk }));

        return {
          data,
          cursor: hasMore ? String(startIndex + limit) : null,
          hasMore,
          done: result.done,
        };
      },

      async getInfo(_runId: string, name: string): Promise<StreamInfoResponse> {
        return getStreamDO(name).getInfo();
      },
    },
  };
}

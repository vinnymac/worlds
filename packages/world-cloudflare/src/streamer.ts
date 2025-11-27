import type { Streamer } from '@workflow/world';
import { monotonicFactory } from 'ulid';

export interface CloudflareStreamerConfig {
  env: {
    WORKFLOW_STREAMS: DurableObjectNamespace;
  };
}

interface DurableObjectStub {
  fetch(request: Request): Promise<Response>;
}

interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
}

interface DurableObjectId {
  toString(): string;
}

export function createStreamer(config: CloudflareStreamerConfig): Streamer {
  const { env } = config;
  const ulid = monotonicFactory();

  const getStreamDO = (streamName: string): DurableObjectStub => {
    const id = env.WORKFLOW_STREAMS.idFromName(streamName);
    return env.WORKFLOW_STREAMS.get(id);
  };

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

      const stub = getStreamDO(name);
      await stub.fetch(
        new Request('http://do/chunks', {
          method: 'POST',
          body: JSON.stringify({
            chunkId,
            streamId: name,
            sequence,
            chunkData: buffer.toString('base64'),
            eof: false,
            createdAt: new Date().toISOString(),
          }),
        })
      );
    },

    async closeStream(name: string, _runId: string | Promise<string>) {
      await _runId;

      const chunkId = `chnk_${ulid()}` as `chnk_${string}`;
      const sequence = Number.parseInt(ulid().substring(0, 10), 36);

      const stub = getStreamDO(name);
      await stub.fetch(
        new Request('http://do/chunks', {
          method: 'POST',
          body: JSON.stringify({
            chunkId,
            streamId: name,
            sequence,
            chunkData: '',
            eof: true,
            createdAt: new Date().toISOString(),
          }),
        })
      );
    },

    async readFromStream(streamName: string) {
      let closed = false;
      let lastSequence = -1;

      const stub = getStreamDO(streamName);

      const processChunks = (
        chunks: Array<{
          sequence: number;
          eof: boolean;
          chunkData: string;
        }>,
        controller: ReadableStreamDefaultController<Uint8Array>
      ): boolean => {
        for (const chunk of chunks) {
          lastSequence = chunk.sequence;
          if (chunk.eof) {
            closed = true;
            controller.close();
            return true;
          }
          controller.enqueue(
            new Uint8Array(Buffer.from(chunk.chunkData, 'base64'))
          );
        }
        return false;
      };

      return new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (closed) {
            controller.close();
            return;
          }

          const response = await stub.fetch(
            new Request(
              `http://do/chunks?lastSequence=${lastSequence}&limit=10`
            )
          );

          if (!response.ok) {
            closed = true;
            controller.close();
            return;
          }

          const chunks = await response.json();

          if (!Array.isArray(chunks) || chunks.length === 0) {
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

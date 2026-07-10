import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createStreamer, type StreamDOStub } from '../src/streamer.js';
import { createMockEnv } from '../src/test-mocks.js';

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array[]> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const result = await reader.read();
    if (result.done) break;
    chunks.push(result.value);
  }
  return chunks;
}

function text(chunks: Uint8Array[]): string {
  return chunks.map((c) => new TextDecoder().decode(c)).join('');
}

describe('Streamer (StreamDO RPC integration)', () => {
  let mockEnv: ReturnType<typeof createMockEnv>;
  let streamer: ReturnType<typeof createStreamer>;

  beforeEach(() => {
    mockEnv = createMockEnv();
    streamer = createStreamer({ env: mockEnv });
  });

  describe('writeToStream()', () => {
    it('should write string chunks with monotonic indexes', async () => {
      await streamer.writeToStream('test-stream', 'wrun_123', 'Hello');
      await streamer.writeToStream('test-stream', 'wrun_123', ' world');

      const stub = mockEnv.WORKFLOW_STREAMS.get(
        mockEnv.WORKFLOW_STREAMS.idFromName('stream:test-stream'),
      );
      const { chunks, tailIndex } = await stub.getChunks({ startIndex: 0, limit: 10 });
      expect(chunks).toHaveLength(2);
      expect(tailIndex).toBe(1);
      expect(new TextDecoder().decode(chunks[0])).toBe('Hello');
      expect(new TextDecoder().decode(chunks[1])).toBe(' world');
    });

    it('should write binary chunks untouched', async () => {
      const bytes = new Uint8Array([0, 1, 2, 253, 254, 255]);
      await streamer.writeToStream('binary-stream', 'wrun_456', bytes);

      const stub = mockEnv.WORKFLOW_STREAMS.get(
        mockEnv.WORKFLOW_STREAMS.idFromName('stream:binary-stream'),
      );
      const { chunks } = await stub.getChunks({ startIndex: 0, limit: 10 });
      expect(Array.from(chunks[0])).toEqual([0, 1, 2, 253, 254, 255]);
    });

    it('should await runId promise before writing', async () => {
      let resolved = false;
      const runIdPromise = new Promise<string>((resolve) => {
        setTimeout(() => {
          resolved = true;
          resolve('wrun_789');
        }, 50);
      });

      await streamer.writeToStream('test-stream', runIdPromise, 'data');

      expect(resolved).toBe(true);
      const info = await streamer.getStreamInfo('test-stream', 'wrun_789');
      expect(info.tailIndex).toBe(0);
    });

    it('should handle empty string chunks', async () => {
      await streamer.writeToStream('test-stream', 'wrun_123', '');

      const info = await streamer.getStreamInfo('test-stream', 'wrun_123');
      expect(info.tailIndex).toBe(0);
    });

    it('should reject writes after the stream is closed', async () => {
      await streamer.writeToStream('test-stream', 'wrun_123', 'data');
      await streamer.closeStream('test-stream', 'wrun_123');

      await expect(streamer.writeToStream('test-stream', 'wrun_123', 'more')).rejects.toThrow(
        /closed/,
      );
    });
  });

  describe('closeStream()', () => {
    it('should mark the stream done', async () => {
      await streamer.writeToStream('test-stream', 'wrun_123', 'data');

      let info = await streamer.getStreamInfo('test-stream', 'wrun_123');
      expect(info.done).toBe(false);

      await streamer.closeStream('test-stream', 'wrun_123');

      info = await streamer.getStreamInfo('test-stream', 'wrun_123');
      expect(info.done).toBe(true);
      expect(info.tailIndex).toBe(0);
    });

    it('should be idempotent', async () => {
      await streamer.closeStream('test-stream', 'wrun_123');
      await streamer.closeStream('test-stream', 'wrun_123');

      const info = await streamer.getStreamInfo('test-stream', 'wrun_123');
      expect(info.done).toBe(true);
      expect(info.tailIndex).toBe(-1);
    });
  });

  describe('readFromStream()', () => {
    it('should read all chunks and close on EOF', async () => {
      await streamer.writeToStream('test-stream', 'wrun_123', 'Chunk 1\n');
      await streamer.writeToStream('test-stream', 'wrun_123', 'Chunk 2\n');
      await streamer.writeToStream('test-stream', 'wrun_123', 'Chunk 3\n');
      await streamer.closeStream('test-stream', 'wrun_123');

      const stream = await streamer.readFromStream('test-stream');
      const chunks = await readAll(stream);

      expect(chunks).toHaveLength(3);
      expect(text(chunks)).toBe('Chunk 1\nChunk 2\nChunk 3\n');
    });

    it('should handle binary data end-to-end', async () => {
      await streamer.writeToStream('binary-stream', 'wrun_123', new Uint8Array([0, 1, 2, 3, 4]));
      await streamer.writeToStream('binary-stream', 'wrun_123', new Uint8Array([5, 6, 7, 8, 9]));
      await streamer.closeStream('binary-stream', 'wrun_123');

      const stream = await streamer.readFromStream('binary-stream');
      const chunks = await readAll(stream);

      expect(chunks).toHaveLength(2);
      expect(Array.from(chunks[0])).toEqual([0, 1, 2, 3, 4]);
      expect(Array.from(chunks[1])).toEqual([5, 6, 7, 8, 9]);
    });

    it('should read a live stream that closes later', async () => {
      await streamer.writeToStream('live-stream', 'wrun_123', 'early');

      const stream = await streamer.readFromStream('live-stream');
      const reader = stream.getReader();

      const first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toBe('early');

      // Write + close while the reader is polling for more.
      setTimeout(() => {
        void streamer
          .writeToStream('live-stream', 'wrun_123', 'late')
          .then(() => streamer.closeStream('live-stream', 'wrun_123'));
      }, 50);

      const second = await reader.read();
      expect(new TextDecoder().decode(second.value)).toBe('late');

      const end = await reader.read();
      expect(end.done).toBe(true);
    });

    it('should honor a positive startIndex', async () => {
      await streamer.writeToStream('test-stream', 'wrun_123', 'zero');
      await streamer.writeToStream('test-stream', 'wrun_123', 'one');
      await streamer.writeToStream('test-stream', 'wrun_123', 'two');
      await streamer.closeStream('test-stream', 'wrun_123');

      const stream = await streamer.readFromStream('test-stream', 1);
      const chunks = await readAll(stream);

      expect(text(chunks)).toBe('onetwo');
    });

    it('should resolve a negative startIndex from the end', async () => {
      await streamer.writeToStream('test-stream', 'wrun_123', 'zero');
      await streamer.writeToStream('test-stream', 'wrun_123', 'one');
      await streamer.writeToStream('test-stream', 'wrun_123', 'two');
      await streamer.closeStream('test-stream', 'wrun_123');

      const stream = await streamer.readFromStream('test-stream', -2);
      const chunks = await readAll(stream);

      expect(text(chunks)).toBe('onetwo');
    });

    it('should handle stream cancellation', async () => {
      await streamer.writeToStream('test-stream', 'wrun_123', 'data');

      const stream = await streamer.readFromStream('test-stream');
      const reader = stream.getReader();

      await reader.read();
      await reader.cancel();

      const result = await reader.read();
      expect(result.done).toBe(true);
    });

    it('should propagate DO errors instead of silently closing', async () => {
      const fail = async (): Promise<never> => {
        throw new Error('DO unavailable');
      };
      const failingStub: StreamDOStub = {
        writeChunk: vi.fn(fail),
        closeStream: vi.fn(fail),
        getChunks: vi.fn(fail),
        getInfo: vi.fn(fail),
        registerStream: vi.fn(fail),
        listStreams: vi.fn(fail),
      };
      const failingEnv = {
        WORKFLOW_STREAMS: {
          idFromName: (name: string) => ({ toString: () => name }),
          get: () => failingStub,
        },
      };

      const failingStreamer = createStreamer({ env: failingEnv });
      const stream = await failingStreamer.readFromStream('error-stream');
      const reader = stream.getReader();

      await expect(reader.read()).rejects.toThrow('DO unavailable');
    });
  });

  describe('getStreamChunks()', () => {
    it('should paginate chunks with a numeric cursor', async () => {
      for (let i = 0; i < 5; i++) {
        await streamer.writeToStream('paged-stream', 'wrun_123', `chunk-${i}`);
      }
      await streamer.closeStream('paged-stream', 'wrun_123');

      const page1 = await streamer.getStreamChunks('paged-stream', 'wrun_123', { limit: 2 });
      expect(page1.data).toHaveLength(2);
      expect(page1.data[0].index).toBe(0);
      expect(page1.data[1].index).toBe(1);
      expect(page1.hasMore).toBe(true);
      expect(page1.cursor).toBe('2');
      expect(page1.done).toBe(true);

      const page2 = await streamer.getStreamChunks('paged-stream', 'wrun_123', {
        limit: 2,
        cursor: page1.cursor ?? undefined,
      });
      expect(page2.data.map((c) => c.index)).toEqual([2, 3]);
      expect(page2.hasMore).toBe(true);

      const page3 = await streamer.getStreamChunks('paged-stream', 'wrun_123', {
        limit: 2,
        cursor: page2.cursor ?? undefined,
      });
      expect(page3.data.map((c) => c.index)).toEqual([4]);
      expect(page3.hasMore).toBe(false);
      expect(page3.cursor).toBeNull();
      expect(new TextDecoder().decode(page3.data[0].data)).toBe('chunk-4');
    });

    it('should report done=false for open streams', async () => {
      await streamer.writeToStream('open-stream', 'wrun_123', 'data');

      const result = await streamer.getStreamChunks('open-stream', 'wrun_123');
      expect(result.done).toBe(false);
      expect(result.hasMore).toBe(false);
      expect(result.data).toHaveLength(1);
    });

    it('should reject invalid cursors', async () => {
      await expect(
        streamer.getStreamChunks('any-stream', 'wrun_123', { cursor: 'bogus' }),
      ).rejects.toThrow(/Invalid stream cursor/);
    });
  });

  describe('getStreamInfo()', () => {
    it('should return -1 tailIndex for empty streams', async () => {
      const info = await streamer.getStreamInfo('empty-stream', 'wrun_123');
      expect(info).toEqual({ tailIndex: -1, done: false });
    });
  });

  describe('listStreamsByRunId()', () => {
    it('should list streams written for a run', async () => {
      await streamer.writeToStream('stream-a', 'wrun_list', 'a');
      await streamer.writeToStream('stream-b', 'wrun_list', 'b');
      await streamer.writeToStream('stream-c', 'wrun_other', 'c');

      const streams = await streamer.listStreamsByRunId('wrun_list');
      expect(streams.sort()).toEqual(['stream-a', 'stream-b']);

      const other = await streamer.listStreamsByRunId('wrun_other');
      expect(other).toEqual(['stream-c']);
    });

    it('should return an empty list for unknown runs', async () => {
      const streams = await streamer.listStreamsByRunId('wrun_unknown');
      expect(streams).toEqual([]);
    });
  });
});

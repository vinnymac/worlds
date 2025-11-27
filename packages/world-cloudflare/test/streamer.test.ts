import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStreamer } from '../src/streamer.js';

describe('Streamer (StreamDO integration)', () => {
  let mockStreamDO: any;
  let mockEnv: any;
  let streamer: ReturnType<typeof createStreamer>;
  let storedChunks: any[];

  beforeEach(() => {
    storedChunks = [];

    // Mock Durable Object Stub with fetch API
    mockStreamDO = {
      fetch: vi.fn(async (request: Request) => {
        const url = new URL(request.url);

        if (request.method === 'POST') {
          // Store chunk
          const body = await request.json();
          storedChunks.push(body);
          return new Response('OK', { status: 200 });
        }

        if (request.method === 'GET') {
          // Read chunks
          const lastSeq = Number(url.searchParams.get('lastSequence') || '-1');
          const limit = Number(url.searchParams.get('limit') || '10');

          const newChunks = storedChunks
            .filter((c) => c.sequence > lastSeq)
            .slice(0, limit);

          return new Response(JSON.stringify(newChunks), { status: 200 });
        }

        return new Response('Not found', { status: 404 });
      }),
    };

    mockEnv = {
      WORKFLOW_STREAMS: {
        idFromName: vi.fn((name: string) => ({ toString: () => name })),
        get: vi.fn(() => mockStreamDO),
      },
    };

    streamer = createStreamer({ env: mockEnv });
  });

  afterEach(() => {
    vi.clearAllMocks();
    storedChunks = [];
  });

  describe('writeToStream()', () => {
    it('should write string chunk to stream', async () => {
      const streamName = 'test-stream';
      const runId = 'wrun_123';
      const chunk = 'Hello, world!';

      await streamer.writeToStream(streamName, runId, chunk);

      expect(mockStreamDO.fetch).toHaveBeenCalledOnce();
      expect(storedChunks).toHaveLength(1);

      const storedChunk = storedChunks[0];
      expect(storedChunk.streamId).toBe(streamName);
      expect(storedChunk.chunkId).toMatch(/^chnk_/);
      expect(storedChunk.sequence).toBeTypeOf('number');
      expect(storedChunk.eof).toBe(false);

      // Verify base64 encoding
      const decoded = Buffer.from(storedChunk.chunkData, 'base64').toString();
      expect(decoded).toBe(chunk);
    });

    it('should write binary chunk to stream', async () => {
      const streamName = 'binary-stream';
      const runId = 'wrun_456';
      const chunk = new Uint8Array([1, 2, 3, 4, 5]);

      await streamer.writeToStream(streamName, runId, chunk);

      expect(storedChunks).toHaveLength(1);

      const storedChunk = storedChunks[0];
      const decoded = Buffer.from(storedChunk.chunkData, 'base64');
      expect(decoded).toEqual(Buffer.from(chunk));
    });

    it('should await runId promise before writing', async () => {
      const streamName = 'test-stream';
      let resolved = false;

      const runIdPromise = new Promise<string>((resolve) => {
        setTimeout(() => {
          resolved = true;
          resolve('wrun_789');
        }, 50);
      });

      await streamer.writeToStream(streamName, runIdPromise, 'data');

      expect(resolved).toBe(true);
      expect(storedChunks).toHaveLength(1);
    });

    it('should generate sequential chunk IDs', async () => {
      const streamName = 'test-stream';
      const runId = 'wrun_123';

      await streamer.writeToStream(streamName, runId, 'chunk1');
      await streamer.writeToStream(streamName, runId, 'chunk2');
      await streamer.writeToStream(streamName, runId, 'chunk3');

      expect(storedChunks).toHaveLength(3);

      const chunkIds = storedChunks.map((c) => c.chunkId);
      expect(chunkIds[0]).toMatch(/^chnk_/);
      expect(chunkIds[1]).toMatch(/^chnk_/);
      expect(chunkIds[2]).toMatch(/^chnk_/);

      // Chunk IDs should be unique
      expect(new Set(chunkIds).size).toBe(3);
    });

    it('should generate sequence numbers', async () => {
      const streamName = 'test-stream';
      const runId = 'wrun_123';

      await streamer.writeToStream(streamName, runId, 'chunk1');
      await streamer.writeToStream(streamName, runId, 'chunk2');
      await streamer.writeToStream(streamName, runId, 'chunk3');

      const sequences = storedChunks.map((c) => c.sequence);

      // Sequences should be numbers and generally increasing over time
      expect(sequences[0]).toBeTypeOf('number');
      expect(sequences[1]).toBeTypeOf('number');
      expect(sequences[2]).toBeTypeOf('number');

      // Sequences should be non-negative
      expect(sequences[0]).toBeGreaterThanOrEqual(0);
      expect(sequences[1]).toBeGreaterThanOrEqual(0);
      expect(sequences[2]).toBeGreaterThanOrEqual(0);
    });

    it('should include timestamp in chunk', async () => {
      const streamName = 'test-stream';
      const runId = 'wrun_123';

      await streamer.writeToStream(streamName, runId, 'data');

      const storedChunk = storedChunks[0];
      expect(storedChunk.createdAt).toBeDefined();
      expect(new Date(storedChunk.createdAt).getTime()).toBeGreaterThan(
        Date.now() - 1000
      );
    });

    it('should get correct StreamDO by name', async () => {
      const streamName = 'named-stream';
      const runId = 'wrun_123';

      await streamer.writeToStream(streamName, runId, 'data');

      expect(mockEnv.WORKFLOW_STREAMS.idFromName).toHaveBeenCalledWith(
        streamName
      );
      expect(mockEnv.WORKFLOW_STREAMS.get).toHaveBeenCalled();
    });

    it('should handle empty string chunks', async () => {
      const streamName = 'test-stream';
      const runId = 'wrun_123';

      await streamer.writeToStream(streamName, runId, '');

      expect(storedChunks).toHaveLength(1);

      const decoded = Buffer.from(
        storedChunks[0].chunkData,
        'base64'
      ).toString();
      expect(decoded).toBe('');
    });

    it('should handle large binary chunks', async () => {
      const streamName = 'test-stream';
      const runId = 'wrun_123';
      const largeChunk = new Uint8Array(10000).fill(255);

      await streamer.writeToStream(streamName, runId, largeChunk);

      expect(storedChunks).toHaveLength(1);

      const decoded = Buffer.from(storedChunks[0].chunkData, 'base64');
      expect(decoded.length).toBe(10000);
      expect(decoded[0]).toBe(255);
    });
  });

  describe('closeStream()', () => {
    it('should write EOF marker to stream', async () => {
      const streamName = 'test-stream';
      const runId = 'wrun_123';

      await streamer.closeStream(streamName, runId);

      expect(storedChunks).toHaveLength(1);

      const eofChunk = storedChunks[0];
      expect(eofChunk.eof).toBe(true);
      expect(eofChunk.chunkData).toBe('');
      expect(eofChunk.streamId).toBe(streamName);
      expect(eofChunk.chunkId).toMatch(/^chnk_/);
    });

    it('should await runId promise before closing', async () => {
      const streamName = 'test-stream';
      let resolved = false;

      const runIdPromise = new Promise<string>((resolve) => {
        setTimeout(() => {
          resolved = true;
          resolve('wrun_789');
        }, 50);
      });

      await streamer.closeStream(streamName, runIdPromise);

      expect(resolved).toBe(true);
      expect(storedChunks).toHaveLength(1);
      expect(storedChunks[0].eof).toBe(true);
    });

    it('should generate unique chunk ID for EOF marker', async () => {
      const streamName = 'test-stream';
      const runId = 'wrun_123';

      await streamer.writeToStream(streamName, runId, 'data1');
      await streamer.writeToStream(streamName, runId, 'data2');
      await streamer.closeStream(streamName, runId);

      expect(storedChunks).toHaveLength(3);

      const chunkIds = storedChunks.map((c) => c.chunkId);
      expect(new Set(chunkIds).size).toBe(3);
    });

    it('should generate sequence number for EOF', async () => {
      const streamName = 'test-stream';
      const runId = 'wrun_123';

      await streamer.writeToStream(streamName, runId, 'data1');
      await streamer.writeToStream(streamName, runId, 'data2');
      await streamer.closeStream(streamName, runId);

      const sequences = storedChunks.map((c) => c.sequence);

      // EOF should have a valid sequence number
      expect(sequences[2]).toBeTypeOf('number');
      expect(sequences[2]).toBeGreaterThanOrEqual(0);
    });
  });

  describe('readFromStream()', () => {
    it('should return ReadableStream', async () => {
      const streamName = 'test-stream';

      const stream = await streamer.readFromStream(streamName);

      expect(stream).toBeInstanceOf(ReadableStream);
    });

    it('should read chunks from stream', async () => {
      const streamName = 'test-stream';

      // Pre-populate chunks with EOF
      storedChunks.push({
        chunkId: 'chnk_1',
        streamId: streamName,
        sequence: 1,
        chunkData: Buffer.from('Hello').toString('base64'),
        eof: false,
      });
      storedChunks.push({
        chunkId: 'chnk_2',
        streamId: streamName,
        sequence: 2,
        chunkData: Buffer.from(' world!').toString('base64'),
        eof: false,
      });
      storedChunks.push({
        chunkId: 'chnk_eof',
        streamId: streamName,
        sequence: 3,
        chunkData: '',
        eof: true,
      });

      const stream = await streamer.readFromStream(streamName);
      const reader = stream.getReader();

      const chunks: Uint8Array[] = [];
      let iterations = 0;
      const maxIterations = 10; // Prevent infinite loop

      while (iterations < maxIterations) {
        const result = await reader.read();
        iterations++;

        if (result.done) {
          break;
        }

        if (result.value) {
          chunks.push(result.value);
        }
      }

      expect(chunks.length).toBeGreaterThan(0);

      const text1 = Buffer.from(chunks[0]).toString();
      expect(text1).toBe('Hello');

      if (chunks.length > 1) {
        const text2 = Buffer.from(chunks[1]).toString();
        expect(text2).toBe(' world!');
      }
    });

    it('should close stream on EOF marker', async () => {
      const streamName = 'test-stream';

      storedChunks.push({
        chunkId: 'chnk_1',
        streamId: streamName,
        sequence: 1,
        chunkData: Buffer.from('data').toString('base64'),
        eof: false,
      });
      storedChunks.push({
        chunkId: 'chnk_eof',
        streamId: streamName,
        sequence: 2,
        chunkData: '',
        eof: true,
      });

      const stream = await streamer.readFromStream(streamName);
      const reader = stream.getReader();

      const chunks: Uint8Array[] = [];
      let done = false;

      while (!done) {
        const result = await reader.read();
        done = result.done;
        if (result.value) {
          chunks.push(result.value);
        }
      }

      // Should have read 1 chunk (EOF marker doesn't produce data)
      expect(chunks).toHaveLength(1);
      expect(done).toBe(true);
    });

    it('should respect sequence ordering', async () => {
      const streamName = 'test-stream';

      // Add chunks out of order, reader should filter correctly
      storedChunks.push({
        chunkId: 'chnk_1',
        streamId: streamName,
        sequence: 1,
        chunkData: Buffer.from('first').toString('base64'),
        eof: false,
      });
      storedChunks.push({
        chunkId: 'chnk_2',
        streamId: streamName,
        sequence: 2,
        chunkData: Buffer.from('second').toString('base64'),
        eof: false,
      });
      storedChunks.push({
        chunkId: 'chnk_eof',
        streamId: streamName,
        sequence: 3,
        chunkData: '',
        eof: true,
      });

      const stream = await streamer.readFromStream(streamName);
      const reader = stream.getReader();

      const chunks: Uint8Array[] = [];
      let done = false;

      while (!done) {
        const result = await reader.read();
        done = result.done;
        if (result.value) {
          chunks.push(result.value);
        }
      }

      expect(chunks).toHaveLength(2);
      expect(Buffer.from(chunks[0]).toString()).toBe('first');
      expect(Buffer.from(chunks[1]).toString()).toBe('second');
    });

    it('should handle stream cancellation', async () => {
      const streamName = 'test-stream';

      const stream = await streamer.readFromStream(streamName);
      const reader = stream.getReader();

      await reader.cancel();

      const result = await reader.read();
      expect(result.done).toBe(true);
    });

    it('should handle DO fetch errors gracefully', async () => {
      const streamName = 'error-stream';

      // Mock fetch to return error
      mockStreamDO.fetch = vi.fn(async () => {
        return new Response('Error', { status: 500 });
      });

      const stream = await streamer.readFromStream(streamName);
      const reader = stream.getReader();

      const result = await reader.read();
      expect(result.done).toBe(true);
    });

    it('should decode base64 chunks correctly', async () => {
      const streamName = 'test-stream';
      const originalData = 'Test data with special chars: !@#$%^&*()';

      storedChunks.push({
        chunkId: 'chnk_1',
        streamId: streamName,
        sequence: 1,
        chunkData: Buffer.from(originalData).toString('base64'),
        eof: false,
      });
      storedChunks.push({
        chunkId: 'chnk_eof',
        streamId: streamName,
        sequence: 2,
        chunkData: '',
        eof: true,
      });

      const stream = await streamer.readFromStream(streamName);
      const reader = stream.getReader();

      const chunks: Uint8Array[] = [];
      let iterations = 0;

      while (iterations < 5) {
        const result = await reader.read();
        iterations++;

        if (result.done) break;
        if (result.value) chunks.push(result.value);
      }

      expect(chunks.length).toBeGreaterThan(0);
      const decoded = Buffer.from(chunks[0]).toString();
      expect(decoded).toBe(originalData);
    });
  });

  describe('Integration: Write and Read', () => {
    it('should write and read stream end-to-end', async () => {
      const streamName = 'integration-stream';
      const runId = 'wrun_integration';

      // Write chunks
      await streamer.writeToStream(streamName, runId, 'Chunk 1\n');
      await streamer.writeToStream(streamName, runId, 'Chunk 2\n');
      await streamer.writeToStream(streamName, runId, 'Chunk 3\n');
      await streamer.closeStream(streamName, runId);

      // Read stream
      const stream = await streamer.readFromStream(streamName);
      const reader = stream.getReader();

      const chunks: Uint8Array[] = [];
      let done = false;

      while (!done) {
        const result = await reader.read();
        done = result.done;
        if (result.value) {
          chunks.push(result.value);
        }
      }

      expect(chunks).toHaveLength(3);

      const fullText = chunks.map((c) => Buffer.from(c).toString()).join('');
      expect(fullText).toBe('Chunk 1\nChunk 2\nChunk 3\n');
    });

    it('should handle binary data end-to-end', async () => {
      const streamName = 'binary-stream';
      const runId = 'wrun_binary';

      const binaryData1 = new Uint8Array([0, 1, 2, 3, 4]);
      const binaryData2 = new Uint8Array([5, 6, 7, 8, 9]);

      await streamer.writeToStream(streamName, runId, binaryData1);
      await streamer.writeToStream(streamName, runId, binaryData2);
      await streamer.closeStream(streamName, runId);

      const stream = await streamer.readFromStream(streamName);
      const reader = stream.getReader();

      const chunks: Uint8Array[] = [];
      let done = false;

      while (!done) {
        const result = await reader.read();
        done = result.done;
        if (result.value) {
          chunks.push(result.value);
        }
      }

      expect(chunks).toHaveLength(2);
      expect(Array.from(chunks[0])).toEqual([0, 1, 2, 3, 4]);
      expect(Array.from(chunks[1])).toEqual([5, 6, 7, 8, 9]);
    });
  });
});

import { DurableObject } from 'cloudflare:workers';

interface StreamMeta {
  /** Number of chunks written so far (also the next chunk index). */
  count: number;
  /** Whether the stream has been closed (EOF). */
  closed: boolean;
}

const META_KEY = 'meta';
const CHUNK_KEY_PREFIX = 'chunk:';
/** Registry keys used when this DO instance acts as a per-run stream index. */
const STREAM_REGISTRY_PREFIX = 'stream:';

/**
 * Zero-pad chunk indexes so `storage.list({ prefix })` returns chunks in
 * write order. 12 digits comfortably exceeds any realistic chunk count.
 */
function chunkKey(index: number): string {
  return `${CHUNK_KEY_PREFIX}${index.toString().padStart(12, '0')}`;
}

/**
 * Durable Object backing workflow streams.
 *
 * Two roles, selected by the DO name:
 * - `stream:<name>`: chunk storage for a single stream. A monotonic
 *   per-stream counter (maintained transactionally inside the DO) assigns
 *   each chunk its index; one chunk per storage key.
 * - `run-streams:<runId>`: registry of stream names owned by a run,
 *   powering `listStreamsByRunId`.
 */
export class StreamDO extends DurableObject {
  private async getMeta(): Promise<StreamMeta> {
    const meta = await this.ctx.storage.get<StreamMeta>(META_KEY);
    return meta ?? { count: 0, closed: false };
  }

  /**
   * Append a chunk. The index is allocated inside the transaction, so
   * concurrent writers can never collide or skip.
   */
  async writeChunk(data: Uint8Array): Promise<number> {
    return await this.ctx.storage.transaction(async (txn) => {
      const meta = (await txn.get<StreamMeta>(META_KEY)) ?? { count: 0, closed: false };
      if (meta.closed) {
        throw new Error('Cannot write to a closed stream');
      }
      const index = meta.count;
      await txn.put(chunkKey(index), data);
      await txn.put<StreamMeta>(META_KEY, { count: index + 1, closed: false });
      return index;
    });
  }

  /**
   * Close the stream (idempotent). Readers observe `done: true` once all
   * previously written chunks have been consumed.
   */
  async closeStream(): Promise<void> {
    await this.ctx.storage.transaction(async (txn) => {
      const meta = (await txn.get<StreamMeta>(META_KEY)) ?? { count: 0, closed: false };
      await txn.put<StreamMeta>(META_KEY, { ...meta, closed: true });
    });
  }

  /**
   * Read up to `limit` chunks starting at `startIndex` (0-based, inclusive).
   */
  async getChunks(params: { startIndex: number; limit: number }): Promise<{
    chunks: Uint8Array[];
    /** Whether the stream is closed. */
    done: boolean;
    /** Index of the last written chunk, -1 when empty. */
    tailIndex: number;
  }> {
    const meta = await this.getMeta();
    const start = Math.max(0, params.startIndex);
    const entries = await this.ctx.storage.list<Uint8Array>({
      prefix: CHUNK_KEY_PREFIX,
      start: chunkKey(start),
      limit: params.limit,
    });
    return {
      chunks: Array.from(entries.values()),
      done: meta.closed,
      tailIndex: meta.count - 1,
    };
  }

  /**
   * Lightweight stream metadata: last chunk index and completion flag.
   */
  async getInfo(): Promise<{ tailIndex: number; done: boolean }> {
    const meta = await this.getMeta();
    return { tailIndex: meta.count - 1, done: meta.closed };
  }

  /**
   * Register a stream name against this per-run registry instance.
   */
  async registerStream(name: string): Promise<void> {
    await this.ctx.storage.put(`${STREAM_REGISTRY_PREFIX}${name}`, true);
  }

  /**
   * List stream names registered against this per-run registry instance.
   */
  async listStreams(): Promise<string[]> {
    const entries = await this.ctx.storage.list<boolean>({ prefix: STREAM_REGISTRY_PREFIX });
    return Array.from(entries.keys()).map((key) => key.slice(STREAM_REGISTRY_PREFIX.length));
  }
}

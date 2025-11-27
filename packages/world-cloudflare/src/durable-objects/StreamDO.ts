import { DurableObject } from 'cloudflare:workers';

/**
 * Durable Object for managing workflow execution streams
 * Handles real-time event streaming for workflow runs
 */
export class StreamDO extends DurableObject {
  private chunks: Map<number, string> = new Map();

  /**
   * Store a chunk of streamed data
   */
  async storeChunk(index: number, data: string): Promise<void> {
    this.chunks.set(index, data);
    await this.ctx.storage.put(`chunk:${index}`, data);
  }

  /**
   * Retrieve a specific chunk
   */
  async getChunk(index: number): Promise<string | null> {
    // Check in-memory first
    if (this.chunks.has(index)) {
      return this.chunks.get(index) || null;
    }

    // Fall back to storage
    const chunk = await this.ctx.storage.get<string>(`chunk:${index}`);
    if (chunk) {
      this.chunks.set(index, chunk);
    }
    return chunk || null;
  }

  /**
   * Get all chunks in order
   */
  async getAllChunks(): Promise<string[]> {
    const keys = await this.ctx.storage.list<string>({ prefix: 'chunk:' });
    const chunks: string[] = [];

    for (const [key, value] of keys) {
      const index = Number.parseInt(key.replace('chunk:', ''), 10);
      chunks[index] = value;
    }

    return chunks.filter(Boolean); // Remove any undefined entries
  }

  /**
   * Clear all stored chunks
   */
  async clearChunks(): Promise<void> {
    this.chunks.clear();
    await this.ctx.storage.deleteAll();
  }
}

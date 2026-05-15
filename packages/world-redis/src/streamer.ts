import { EventEmitter } from 'node:events';
import type { Streamer } from '@workflow/world';
import type { Redis } from 'ioredis';
import { debug, Mutex, Rc } from './util.js';

/**
 * Stream health statistics for observability.
 * Reports the length and active listener count for a given stream.
 */
export interface StreamStats {
  /** Total number of entries in the Redis Stream */
  streamLength: number;
  /** Number of active event listeners for this stream */
  activeListeners: number;
}

interface StreamPublishMessage {
  streamId: string;
  entryId: string;
}

function parseStreamPublishMessage(raw: string): StreamPublishMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const { streamId, entryId } = parsed as Record<string, unknown>;
  if (typeof streamId !== 'string' || typeof entryId !== 'string') return null;
  return { streamId, entryId };
}

interface StreamChunkEvent {
  id: string;
  data: Uint8Array;
  eof: boolean;
}

interface StreamerConfig {
  redis: Redis;
  keyPrefix: string;
}

/**
 * Create a streamer implementation using Redis Streams.
 *
 * Uses Redis auto-generated stream entry IDs (timestamp-sequence format)
 * instead of custom IDs, since Redis Streams require IDs in
 * `<millisecondsTime>-<sequenceNumber>` format.
 */
export function createStreamer(
  config: StreamerConfig,
): Streamer & { getStreamStats(name: string): Promise<StreamStats> } {
  const { redis, keyPrefix } = config;
  const events = new EventEmitter<{
    [key: `strm:${string}`]: [StreamChunkEvent];
  }>();
  const mutexes = new Map<string, Rc>();

  const getMutex = (key: string) => {
    let mutex = mutexes.get(key);
    if (!mutex) {
      mutex = new Rc(async () => {
        mutexes.delete(key);
      });
      mutexes.set(key, mutex);
    }
    mutex.inc();
    return {
      mutex: new Mutex(),
      [Symbol.dispose]: () => mutex?.dec(),
    };
  };

  const streamKey = (name: string) => `${keyPrefix}stream:${name}`;
  const STREAM_CHANNEL = `${keyPrefix}stream_notify`;

  // Set up pub/sub subscriber for stream notifications
  const subscriber = redis.duplicate();

  // CRITICAL: Must await subscribe() to avoid race condition where PUBLISH happens before SUBSCRIBE is ready
  // This was causing workflows to hang because completion events were published but never received
  const subscriptionReady: Promise<void> = subscriber.subscribe(STREAM_CHANNEL).then(() => {});

  subscriber.on('message', async (channel, message) => {
    if (channel !== STREAM_CHANNEL) return;

    try {
      const parsed = parseStreamPublishMessage(message);
      if (!parsed) return;

      const key = `strm:${parsed.streamId}` as const;
      if (!events.listenerCount(key)) {
        return;
      }

      const resource = getMutex(key);
      await resource.mutex.andThen(async () => {
        // Read the specific entry from the stream using its auto-generated ID
        const results = await redis.xrange(
          streamKey(parsed.streamId),
          parsed.entryId,
          parsed.entryId,
        );

        if (results.length === 0) return;

        const [id, fields] = results[0];
        const data = Buffer.from(fields[1] as string, 'base64');
        const eof = fields[3] === 'true';

        events.emit(key, {
          id,
          data,
          eof,
        });
      });
    } catch (error) {
      // Ignore parse errors
      console.error('Error processing stream notification:', error);
    }
  });

  /**
   * Get health/observability stats for a specific stream.
   * Useful for dashboards and alerting on stream health.
   */
  async function getStreamStats(name: string): Promise<StreamStats> {
    const key = streamKey(name);
    const listenerKey = `strm:${name}` as const;

    let streamLength = 0;
    try {
      streamLength = await redis.xlen(key);
    } catch {
      // Stream may not exist yet
    }

    const activeListeners = events.listenerCount(listenerKey);

    const stats: StreamStats = {
      streamLength,
      activeListeners,
    };

    debug('stream stats', { name, ...stats });
    return stats;
  }

  // Type assertion to match updated Streamer interface signature
  // This package uses the updated API but the old @workflow/world types
  return {
    getStreamStats,
    async writeToStream(
      name: string,
      _runId: string | Promise<string>,
      chunk: string | Uint8Array,
    ): Promise<void> {
      // Await runId if it's a promise to ensure proper flushing
      await _runId;

      const data = !Buffer.isBuffer(chunk) ? Buffer.from(chunk) : chunk;

      // Add chunk to Redis Stream with auto-generated ID
      const entryId = (await redis.xadd(
        streamKey(name),
        '*',
        'data',
        data.toString('base64'),
        'eof',
        'false',
      ))!;

      // CRITICAL: Wait for subscription to be ready before publishing
      // Otherwise the message might be published before anyone is subscribed
      await subscriptionReady;

      // Notify subscribers with the auto-generated entry ID
      await redis.publish(
        STREAM_CHANNEL,
        JSON.stringify({ streamId: name, entryId } satisfies StreamPublishMessage),
      );
    },

    async closeStream(name: string, _runId: string | Promise<string>): Promise<void> {
      // Await runId if it's a promise to ensure proper flushing
      await _runId;

      // Add final chunk with eof=true, using auto-generated ID
      const entryId = (await redis.xadd(streamKey(name), '*', 'data', '', 'eof', 'true'))!;

      // CRITICAL: Wait for subscription to be ready before publishing
      // Otherwise the message might be published before anyone is subscribed
      await subscriptionReady;

      // Notify subscribers with the auto-generated entry ID
      await redis.publish(
        STREAM_CHANNEL,
        JSON.stringify({ streamId: name, entryId } satisfies StreamPublishMessage),
      );
    },

    async readFromStream(name: string, startIndex?: number): Promise<ReadableStream<Uint8Array>> {
      const cleanups: (() => void)[] = [];

      return new ReadableStream<Uint8Array>({
        async start(controller) {
          // Track last entry ID for ordering
          let lastEntryId = '';
          let offset = startIndex ?? 0;
          let buffer = [] as StreamChunkEvent[] | null;

          const shouldSkipChunk = (entryId: string): boolean => {
            return lastEntryId >= entryId;
          };

          const shouldApplyOffset = (): boolean => {
            if (offset > 0) {
              offset--;
              return true;
            }
            return false;
          };

          const enqueueChunkData = (msg: { id: string; data: Uint8Array; eof: boolean }): void => {
            if (msg.data.byteLength) {
              controller.enqueue(new Uint8Array(msg.data));
            }
            if (msg.eof) {
              controller.close();
            }
            lastEntryId = msg.id;
          };

          function enqueue(msg: { id: string; data: Uint8Array; eof: boolean }) {
            if (shouldSkipChunk(msg.id)) return;
            if (shouldApplyOffset()) return;
            enqueueChunkData(msg);
          }

          function onData(data: StreamChunkEvent) {
            if (buffer) {
              buffer.push(data);
              return;
            }
            enqueue(data);
          }

          events.on(`strm:${name}`, onData);
          cleanups.push(() => {
            events.off(`strm:${name}`, onData);
          });

          // Read all historical chunks from Redis Stream
          // XRANGE reads entries from start to end
          const chunks = await redis.xrange(streamKey(name), '-', '+');

          const parsedChunks: StreamChunkEvent[] = [];
          for (const [id, fields] of chunks) {
            const data = Buffer.from(fields[1] as string, 'base64');
            const eof = fields[3] === 'true';
            parsedChunks.push({
              id,
              data,
              eof,
            });
          }

          // Process historical chunks and buffered real-time chunks
          for (const chunk of [...parsedChunks, ...(buffer ?? [])]) {
            enqueue(chunk);
          }

          // From now on, process chunks in real-time
          buffer = null;
        },
        cancel() {
          cleanups.forEach((fn) => void fn());
        },
      });
    },
  } as any as Streamer & { getStreamStats(name: string): Promise<StreamStats> }; // Type assertion for updated API with old @workflow/world types
}

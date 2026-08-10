import { EventEmitter } from 'node:events';
import type {
  GetChunksOptions,
  StreamChunk,
  StreamChunksResponse,
  StreamInfoResponse,
  Streamer,
} from '@workflow/world';
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

/**
 * Compare two Redis stream entry IDs (`<ms>-<seq>` format) numerically.
 * Returns a negative number if a < b, 0 if equal, positive if a > b.
 *
 * A plain string comparison is wrong: '1700000000000-9' > '1700000000000-10'
 * lexicographically, which silently drops chunks (including the eof entry,
 * hanging readers forever) whenever 10+ entries land in the same millisecond.
 */
function compareStreamIds(a: string, b: string): number {
  const [aMs = '0', aSeq = '0'] = a.split('-');
  const [bMs = '0', bSeq = '0'] = b.split('-');
  const msDiff = Number(aMs) - Number(bMs);
  if (msDiff !== 0) return msDiff;
  return Number(aSeq) - Number(bSeq);
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
export function createStreamer(config: StreamerConfig): Streamer & {
  getStreamStats(name: string): Promise<StreamStats>;
  closeStreamer(): Promise<void>;
} {
  const { redis, keyPrefix } = config;
  const events = new EventEmitter<{
    [key: `strm:${string}`]: [StreamChunkEvent];
  }>();
  // The Mutex must be SHARED per stream key (stored alongside the Rc) so
  // concurrent pub/sub handlers for the same stream actually serialize.
  // Constructing a fresh Mutex per call would make the serialization a no-op.
  const mutexes = new Map<string, { rc: Rc; mutex: Mutex }>();

  const getMutex = (key: string) => {
    let entry = mutexes.get(key);
    if (!entry) {
      entry = {
        rc: new Rc(async () => {
          mutexes.delete(key);
        }),
        mutex: new Mutex(),
      };
      mutexes.set(key, entry);
    }
    entry.rc.inc();
    const { rc, mutex } = entry;
    return {
      mutex,
      [Symbol.dispose]: () => void rc.dec(),
    };
  };

  const streamKey = (name: string) => `${keyPrefix}stream:${name}`;
  // Per-run index of stream names, mirroring the `<entity>:by_run:<runId>`
  // convention used by storage (events/steps/hooks). Populated on every
  // write/close so `listStreamsByRunId` can enumerate a run's streams.
  const streamsByRunKey = (runId: string) => `${keyPrefix}streams:by_run:${runId}`;
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
      try {
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
      } finally {
        resource[Symbol.dispose]();
      }
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

  /**
   * Release the dedicated pub/sub connection. After this the streamer no
   * longer receives live chunk notifications.
   */
  async function closeStreamer(): Promise<void> {
    try {
      await subscriber.quit();
    } catch {
      subscriber.disconnect();
    }
  }

  // Type assertion to match updated Streamer interface signature
  // This package uses the updated API but the old @workflow/world types
  return {
    getStreamStats,
    closeStreamer,
    streams: {
      async write(runId: string, name: string, chunk: string | Uint8Array): Promise<void> {
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

        // Register this stream under its run so listStreamsByRunId can find it.
        // SADD is idempotent, so repeating it per chunk is safe.
        await redis.sadd(streamsByRunKey(runId), name);

        // CRITICAL: Wait for subscription to be ready before publishing
        // Otherwise the message might be published before anyone is subscribed
        await subscriptionReady;

        // Notify subscribers with the auto-generated entry ID
        await redis.publish(
          STREAM_CHANNEL,
          JSON.stringify({ streamId: name, entryId } satisfies StreamPublishMessage),
        );
      },

      async close(runId: string, name: string): Promise<void> {
        // Add final chunk with eof=true, using auto-generated ID
        const entryId = (await redis.xadd(streamKey(name), '*', 'data', '', 'eof', 'true'))!;

        // Ensure the stream is indexed even if it closes without any data write.
        await redis.sadd(streamsByRunKey(runId), name);

        // CRITICAL: Wait for subscription to be ready before publishing
        // Otherwise the message might be published before anyone is subscribed
        await subscriptionReady;

        // Notify subscribers with the auto-generated entry ID
        await redis.publish(
          STREAM_CHANNEL,
          JSON.stringify({ streamId: name, entryId } satisfies StreamPublishMessage),
        );
      },

      async get(
        _runId: string,
        name: string,
        startIndex?: number,
      ): Promise<ReadableStream<Uint8Array>> {
        const cleanups: (() => void)[] = [];

        return new ReadableStream<Uint8Array>({
          async start(controller) {
            // Track last entry ID for ordering
            let lastEntryId = '';
            let offset = startIndex ?? 0;
            let buffer = [] as StreamChunkEvent[] | null;

            const shouldSkipChunk = (entryId: string): boolean => {
              if (lastEntryId === '') return false;
              return compareStreamIds(lastEntryId, entryId) >= 0;
            };

            const shouldApplyOffset = (): boolean => {
              if (offset > 0) {
                offset--;
                return true;
              }
              return false;
            };

            const enqueueChunkData = (msg: {
              id: string;
              data: Uint8Array;
              eof: boolean;
            }): void => {
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

      async list(runId: string): Promise<string[]> {
        return (await redis.smembers(streamsByRunKey(runId))) ?? [];
      },

      async getChunks(
        _runId: string,
        name: string,
        options?: GetChunksOptions,
      ): Promise<StreamChunksResponse> {
        const limit = Math.min(options?.limit ?? 100, 1000);

        // Cursor carries the running 0-based data-chunk index plus the last
        // returned entry ID, letting us resume with a bounded XRANGE instead of
        // rescanning the whole stream on every page.
        let dataIndex = 0;
        let start = '-';
        if (options?.cursor) {
          try {
            const decoded = JSON.parse(Buffer.from(options.cursor, 'base64').toString('utf-8')) as {
              i?: number;
              id?: string;
            };
            if (typeof decoded.i === 'number') dataIndex = decoded.i;
            // '(' makes the range start exclusive of the last returned entry.
            if (typeof decoded.id === 'string') start = `(${decoded.id}`;
          } catch {
            // Malformed cursor -> restart from the beginning of the stream.
            dataIndex = 0;
            start = '-';
          }
        }

        // Fetch one extra entry to detect whether more data pages follow.
        const entries = await redis.xrange(streamKey(name), start, '+', 'COUNT', limit + 1);

        const data: StreamChunk[] = [];
        let done = false;
        let hasMore = false;
        let lastId: string | null = null;

        for (const [id, fields] of entries) {
          if (fields[3] === 'true') {
            // The eof marker is always the terminal entry, so reaching it means
            // the stream is complete and no further data pages exist.
            done = true;
            break;
          }
          if (data.length >= limit) {
            // A data entry beyond the requested page: more pages remain.
            hasMore = true;
            break;
          }
          data.push({
            index: dataIndex,
            data: new Uint8Array(Buffer.from(fields[1] as string, 'base64')),
          });
          dataIndex++;
          lastId = id;
        }

        const cursor =
          hasMore && lastId
            ? Buffer.from(JSON.stringify({ i: dataIndex, id: lastId })).toString('base64')
            : null;

        return { data, cursor, hasMore, done };
      },

      async getInfo(_runId: string, name: string): Promise<StreamInfoResponse> {
        const key = streamKey(name);
        const [length, tail] = await Promise.all([
          redis.xlen(key),
          redis.xrevrange(key, '+', '-', 'COUNT', 1),
        ]);
        // The eof marker is always the final entry (closeStream is the terminal
        // XADD, and auto-generated IDs are monotonic), so the last entry alone
        // tells us whether the stream is done. Data chunks are the non-eof
        // entries; an empty stream yields tailIndex -1.
        const done = tail.length > 0 && tail[0][1][3] === 'true';
        const dataCount = length - (done ? 1 : 0);
        return { tailIndex: dataCount - 1, done };
      },
    },
  };
}

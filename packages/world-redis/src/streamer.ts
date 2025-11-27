import { EventEmitter } from 'node:events';
import type { Streamer } from '@workflow/world';
import type { Redis } from 'ioredis';
import { monotonicFactory } from 'ulid';
import * as z from 'zod';
import { Mutex, Rc } from './util.js';

const StreamPublishMessage = z.object({
  streamId: z.string(),
  chunkId: z.templateLiteral(['chnk_', z.string()]),
});

interface StreamChunkEvent {
  id: `chnk_${string}`;
  data: Uint8Array;
  eof: boolean;
}

interface StreamerConfig {
  redis: Redis;
  keyPrefix: string;
}

/**
 * Create a streamer implementation using Redis Streams
 */
export function createStreamer(config: StreamerConfig): Streamer {
  const { redis, keyPrefix } = config;
  const ulid = monotonicFactory();
  const events = new EventEmitter<{
    [key: `strm:${string}`]: [StreamChunkEvent];
  }>();
  const genChunkId = () => `chnk_${ulid()}` as const;
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
  let subscriptionReady: Promise<void>;
  subscriptionReady = subscriber.subscribe(STREAM_CHANNEL).then(() => {});

  subscriber.on('message', async (channel, message) => {
    if (channel !== STREAM_CHANNEL) return;

    try {
      const parsed = await Promise.resolve(message)
        .then(JSON.parse)
        .then(StreamPublishMessage.parse);

      const key = `strm:${parsed.streamId}` as const;
      if (!events.listenerCount(key)) {
        return;
      }

      const resource = getMutex(key);
      await resource.mutex.andThen(async () => {
        // Read the specific chunk from the stream
        const results = await redis.xrange(
          streamKey(parsed.streamId),
          parsed.chunkId,
          parsed.chunkId
        );

        if (results.length === 0) return;

        const [_id, fields] = results[0];
        const data = Buffer.from(fields[1] as string, 'base64');
        const eof = fields[3] === 'true';

        events.emit(key, {
          id: parsed.chunkId,
          data,
          eof,
        });
      });
    } catch (error) {
      // Ignore parse errors
      console.error('Error processing stream notification:', error);
    }
  });

  // Type assertion to match updated Streamer interface signature
  // This package uses the updated API but the old @workflow/world types
  return {
    async writeToStream(
      name: string,
      _runId: string | Promise<string>,
      chunk: string | Uint8Array
    ): Promise<void> {
      // Await runId if it's a promise to ensure proper flushing
      await _runId;

      const chunkId = genChunkId();
      const data = !Buffer.isBuffer(chunk) ? Buffer.from(chunk) : chunk;

      // Add chunk to Redis Stream
      // Redis Streams use XADD to append entries
      // We use the chunkId as the stream entry ID for ordering
      await redis.xadd(
        streamKey(name),
        chunkId,
        'data',
        data.toString('base64'),
        'eof',
        'false'
      );

      // CRITICAL: Wait for subscription to be ready before publishing
      // Otherwise the message might be published before anyone is subscribed
      await subscriptionReady;

      // Notify subscribers
      await redis.publish(
        STREAM_CHANNEL,
        JSON.stringify(
          StreamPublishMessage.encode({
            chunkId,
            streamId: name,
          })
        )
      );
    },

    async closeStream(
      name: string,
      _runId: string | Promise<string>
    ): Promise<void> {
      // Await runId if it's a promise to ensure proper flushing
      await _runId;

      const chunkId = genChunkId();

      // Add final chunk with eof=true
      await redis.xadd(streamKey(name), chunkId, 'data', '', 'eof', 'true');

      // CRITICAL: Wait for subscription to be ready before publishing
      // Otherwise the message might be published before anyone is subscribed
      await subscriptionReady;

      // Notify subscribers
      await redis.publish(
        STREAM_CHANNEL,
        JSON.stringify(
          StreamPublishMessage.encode({
            streamId: name,
            chunkId,
          })
        )
      );
    },

    async readFromStream(
      name: string,
      startIndex?: number
    ): Promise<ReadableStream<Uint8Array>> {
      const cleanups: (() => void)[] = [];

      return new ReadableStream<Uint8Array>({
        async start(controller) {
          // Track last chunk ID for ordering
          let lastChunkId = '';
          let offset = startIndex ?? 0;
          let buffer = [] as StreamChunkEvent[] | null;

          const shouldSkipChunk = (chunkId: string): boolean => {
            return lastChunkId >= chunkId;
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
            lastChunkId = msg.id;
          };

          function enqueue(msg: {
            id: string;
            data: Uint8Array;
            eof: boolean;
          }) {
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
              id: id as `chnk_${string}`,
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
  } as any as Streamer; // Type assertion for updated API with old @workflow/world types
}

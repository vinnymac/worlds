import { EventEmitter } from 'node:events';
import type {
  GetChunksOptions,
  StreamChunk,
  StreamChunksResponse,
  StreamInfoResponse,
  Streamer,
} from '@workflow/world';
import type { Redis } from 'ioredis';
import { Mutex, Rc } from './util.js';

interface StreamPublishMessage {
  streamId: string;
  entryId: string;
  /** Base64 chunk, inline so subscribers need no XRANGE per notification. */
  data: string;
  eof: boolean;
}

function parseStreamPublishMessage(raw: string): StreamPublishMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const { streamId, entryId, data, eof } = parsed as Record<string, unknown>;
  if (typeof streamId !== 'string' || typeof entryId !== 'string') return null;
  if (typeof data !== 'string' || typeof eof !== 'boolean') return null;
  return { streamId, entryId, data, eof };
}

interface StreamChunkEvent {
  id: string;
  data: Uint8Array;
  eof: boolean;
}

/**
 * Compare two Redis stream entry IDs (`<ms>-<seq>`) numerically.
 *
 * String comparison is NOT safe here: within one millisecond `...-10` compares
 * lexicographically smaller than `...-9`, which would drop chunks (and the eof
 * marker) once the sequence number crosses a digit boundary.
 */
function compareStreamEntryIds(a: string, b: string): number {
  const [aMs, aSeq] = a.split('-').map(Number);
  const [bMs, bSeq] = b.split('-').map(Number);
  return aMs - bMs || aSeq - bSeq;
}

interface StreamerConfig {
  redis: Redis;
  keyPrefix: string;
}

/**
 * Append a chunk, index the stream under its run, and notify subscribers in one
 * round trip. These were three sequential awaits per chunk, and the publish
 * could not be pipelined with the rest because it needs the entry ID `XADD`
 * generates; Lua makes that dependency server-side. The chunk rides along in
 * the message so subscribers no longer `XRANGE` per notification.
 *
 * KEYS[1] = stream key
 * KEYS[2] = streams-by-run key
 * ARGV[1] = notification channel
 * ARGV[2] = stream name
 * ARGV[3] = base64 chunk data
 * ARGV[4] = 'true' | 'false' (eof marker)
 * Returns: the generated stream entry ID
 */
const LUA_APPEND_AND_PUBLISH = `
  local streamKey = KEYS[1]
  local runIndexKey = KEYS[2]
  local channel = ARGV[1]
  local streamId = ARGV[2]
  local data = ARGV[3]
  local eof = ARGV[4]

  local entryId = redis.call('XADD', streamKey, '*', 'data', data, 'eof', eof)
  redis.call('SADD', runIndexKey, streamId)
  redis.call('PUBLISH', channel, cjson.encode({
    streamId = streamId,
    entryId = entryId,
    data = data,
    eof = eof == 'true'
  }))
  return entryId
`;

type RedisWithStreamScript = Redis & {
  wfStreamAppend(...args: string[]): Promise<string>;
};

/**
 * Create a streamer implementation using Redis Streams.
 *
 * Uses Redis auto-generated stream entry IDs (timestamp-sequence format)
 * instead of custom IDs, since Redis Streams require IDs in
 * `<millisecondsTime>-<sequenceNumber>` format.
 */
export function createStreamer(config: StreamerConfig): Streamer & { close(): Promise<void> } {
  const { redis, keyPrefix } = config;
  const events = new EventEmitter<{
    [key: `strm:${string}`]: [StreamChunkEvent];
  }>();
  const mutexes = new Map<string, { mutex: Mutex; rc: Rc }>();

  // Serialize work per stream key through a shared, ref-counted Mutex so
  // concurrent pub/sub notifications for the same stream are processed in
  // order. The entry is dropped once the last holder releases it.
  const withStreamMutex = async <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    let entry = mutexes.get(key);
    if (!entry) {
      entry = {
        mutex: new Mutex(),
        rc: new Rc(() => {
          mutexes.delete(key);
        }),
      };
      mutexes.set(key, entry);
    }
    entry.rc.inc();
    try {
      return await entry.mutex.andThen(fn);
    } finally {
      await entry.rc.dec();
    }
  };

  redis.defineCommand('wfStreamAppend', { numberOfKeys: 2, lua: LUA_APPEND_AND_PUBLISH });
  const scripted = redis as RedisWithStreamScript;

  const streamKey = (name: string) => `${keyPrefix}stream:${name}`;
  // Per-run index of stream names, mirroring the `<entity>:by_run:<runId>`
  // convention used by storage. Populated on every write/close so
  // `listStreamsByRunId` can enumerate a run's streams.
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

      await withStreamMutex(key, async () => {
        // The chunk travels with the notification, so no XRANGE per message.
        events.emit(key, {
          id: parsed.entryId,
          data: Buffer.from(parsed.data, 'base64'),
          eof: parsed.eof,
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
      chunk: string | Uint8Array,
    ): Promise<void> {
      // Await runId if it's a promise to ensure proper flushing
      const runId = await _runId;

      const data = !Buffer.isBuffer(chunk) ? Buffer.from(chunk) : chunk;
      const encoded = data.toString('base64');

      // CRITICAL: Wait for subscription to be ready before publishing
      // Otherwise the message might be published before anyone is subscribed
      await subscriptionReady;

      await scripted.wfStreamAppend(
        streamKey(name),
        streamsByRunKey(runId),
        STREAM_CHANNEL,
        name,
        encoded,
        'false',
      );
    },

    async closeStream(name: string, _runId: string | Promise<string>): Promise<void> {
      // Await runId if it's a promise to ensure proper flushing
      const runId = await _runId;

      // CRITICAL: Wait for subscription to be ready before publishing
      // Otherwise the message might be published before anyone is subscribed
      await subscriptionReady;

      // Final chunk carries eof=true. Same single-round-trip append as above,
      // which also keeps the stream indexed when it closes without any data.
      await scripted.wfStreamAppend(
        streamKey(name),
        streamsByRunKey(runId),
        STREAM_CHANNEL,
        name,
        '',
        'true',
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
            return lastEntryId !== '' && compareStreamEntryIds(lastEntryId, entryId) >= 0;
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

    async listStreamsByRunId(runId: string): Promise<string[]> {
      return (await redis.smembers(streamsByRunKey(runId))) ?? [];
    },

    async getStreamChunks(
      name: string,
      _runId: string,
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

    async getStreamInfo(name: string, _runId: string): Promise<StreamInfoResponse> {
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

    async close(): Promise<void> {
      // Tear down the duplicated pub/sub connection so short-lived processes
      // do not leak it.
      await subscriber.quit();
    },
  };
}

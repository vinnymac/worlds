import type { ConsumerConfig, ConsumerInfo, JetStreamClient, JsMsg } from '@nats-io/jetstream';
import { setTimeout as sleep } from 'node:timers/promises';
import { stringify } from '@fantasticfour/shared';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { NatsJetStreamWorldConfig } from '../src/config.js';
import { createQueue } from '../src/queue.js';

type FakeOptions = {
  existing?: boolean;
  /** Delivered in order; an Error is thrown from the pull instead. */
  messages?: (JsMsg | Error)[];
  /** ack_wait the server reports back; defaults to echoing the request. */
  serverAckWait?: number;
  /** ack_wait an already-existing durable holds. */
  existingAckWait?: number;
  /** max_deliver an already-existing durable holds. */
  existingMaxDeliver?: number;
  /** While true, every consumer info call rejects, as a closed connection does. */
  infoFails?: { value: boolean };
};

function fakeJetStream(options: FakeOptions = {}) {
  /** Mutable so a test can act as another process changing the shared durable. */
  const server = { ackWait: options.serverAckWait };
  const requested = new Map<string, number | undefined>();
  const info = (stream: string, cfg: Partial<ConsumerConfig>) => {
    requested.set(stream, cfg.ack_wait);
    return { config: { ...cfg, ack_wait: server.ackWait ?? cfg.ack_wait } } as ConsumerInfo;
  };
  const add = vi.fn(async (stream: string, cfg: Partial<ConsumerConfig>) => {
    if (options.existing) throw new Error('consumer already exists');
    return info(stream, cfg);
  });
  const update = vi.fn(async (stream: string, _name: string, cfg: Partial<ConsumerConfig>) =>
    info(stream, cfg),
  );
  const consumerInfo = vi.fn(async (stream: string) => {
    if (options.infoFails?.value) throw new Error('connection closed');
    return {
      config: {
        ack_wait: server.ackWait ?? requested.get(stream) ?? options.existingAckWait ?? 30e9,
        max_deliver: requested.has(stream) ? MAX_DELIVER : options.existingMaxDeliver,
      },
    } as ConsumerInfo;
  });
  const pending = options.messages ? [...options.messages] : [];
  const next = vi.fn(async (stream: string) => {
    if (!stream.endsWith('steps')) return await new Promise<JsMsg>(() => {});
    const msg = pending.shift();
    if (msg instanceof Error) throw msg;
    return msg ?? (await new Promise<JsMsg>(() => {}));
  });
  const jsm = {
    streams: { add: vi.fn(async () => {}) },
    consumers: { add, update, info: consumerInfo },
  };
  const client = {
    jetstreamManager: async () => jsm,
    consumers: { get: async (stream: string) => ({ next: () => next(stream) }) },
  };
  return {
    add,
    update,
    next,
    server,
    consumerInfo,
    getJetStream: async () => client as unknown as JetStreamClient,
  };
}

/** The status errors @nats-io/jetstream rejects a fetch with. */
function statusError(code: number, description: string): Error {
  return Object.assign(new Error(description), { code, name: 'JetStreamStatusError' });
}

/** Each fetch waits until the test resolves it. */
function stubFetch(): ((response: Response) => void)[] {
  const responses: ((response: Response) => void)[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise<Response>((resolve) => responses.push(resolve))),
  );
  return responses;
}

function fakeMsg(messageId: string, seq = 1) {
  const working = vi.fn();
  const ack = vi.fn();
  const msg = {
    data: new TextEncoder().encode(
      stringify({ messageId, queueName: '__wkf_step_demo', message: { runId: messageId } }),
    ),
    info: { deliveryCount: 1, streamSequence: seq },
    working,
    ack,
    nak: vi.fn(),
  } as unknown as JsMsg;
  return { msg, working, ack };
}

/** Lets the refresh promise chain settle between fake-timer advances. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

/** Polls without `vi.waitFor`, which advances fake timers on every check. */
async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i++) await sleep(5);
  if (!condition()) throw new Error('condition not met');
}

/** Mirrors MAX_DELIVER in src/queue.ts (MAX_SOFT_NAKS + 64). */
const MAX_DELIVER = 320;

/** Mirrors SLOW_ACK_WAIT_REFRESH_MS in src/queue.ts. */
const SLOW_REFRESH_MS = 60_000;

const baseConfig: NatsJetStreamWorldConfig = {
  nats: 'nats://localhost:4222',
  queueConcurrency: 1,
  baseUrl: 'http://localhost:3000',
};

describe('createQueue ackWaitMs', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  test.each([0, -1, 999, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 7_000_000_000])(
    'rejects ackWaitMs %s',
    (ackWaitMs) => {
      const { getJetStream } = fakeJetStream();
      expect(() => createQueue(getJetStream, { ...baseConfig, ackWaitMs })).toThrow(/ackWaitMs/);
    },
  );

  test.each([
    { ackWaitMs: undefined, nanos: 30_000_000_000 },
    { ackWaitMs: 120_000, nanos: 120_000_000_000 },
  ])('creates consumers with ack_wait $nanos', async ({ ackWaitMs, nanos }) => {
    const { add, update, getJetStream } = fakeJetStream();
    await createQueue(getJetStream, { ...baseConfig, ackWaitMs }).start();
    await vi.waitFor(() => expect(add).toHaveBeenCalledTimes(2));
    for (const [, cfg] of add.mock.calls) expect(cfg.ack_wait).toBe(nanos);
    expect(update).not.toHaveBeenCalled();
  });

  test('reconciles ack_wait on an existing durable consumer', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { update, getJetStream } = fakeJetStream({ existing: true, existingAckWait: 30e9 });
    await createQueue(getJetStream, { ...baseConfig, ackWaitMs: 120_000 }).start();
    await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(2));
    for (const [, , cfg] of update.mock.calls) expect(cfg.ack_wait).toBe(120_000_000_000);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('not the configured'));
    warn.mockRestore();
  });

  test('leaves an existing ack_wait alone when ackWaitMs is unset', async () => {
    const { update, next, getJetStream } = fakeJetStream({
      existing: true,
      existingAckWait: 120e9,
      existingMaxDeliver: MAX_DELIVER,
    });
    await createQueue(getJetStream, baseConfig).start();
    await until(() => next.mock.calls.length === 2);
    expect(update).not.toHaveBeenCalled();
  });

  test('updates max_deliver on an older durable without rewriting ack_wait', async () => {
    const { update, getJetStream } = fakeJetStream({
      existing: true,
      existingAckWait: 120e9,
      existingMaxDeliver: 3,
    });
    await createQueue(getJetStream, baseConfig).start();
    await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(2));
    for (const [, , cfg] of update.mock.calls) {
      expect(cfg.max_deliver).toBe(MAX_DELIVER);
      expect(cfg.ack_wait).toBeUndefined();
    }
  });

  test.each([
    {
      name: 'the configured ack wait',
      ackWaitMs: 3_000,
      serverAckWait: undefined,
      intervalMs: 1_000,
    },
    {
      name: "the server's ack wait over a stale local ackWaitMs",
      ackWaitMs: 120_000,
      serverAckWait: 60_000_000_000,
      intervalMs: 20_000,
    },
  ])('heartbeats every third of $name', async ({ ackWaitMs, serverAckWait, intervalMs }) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const responses = stubFetch();
    const { msg, working, ack } = fakeMsg('msg_1');
    const { getJetStream } = fakeJetStream({ messages: [msg], serverAckWait });
    await createQueue(getJetStream, { ...baseConfig, ackWaitMs }).start();
    await until(() => vi.mocked(fetch).mock.calls.length > 0);

    vi.advanceTimersByTime(intervalMs - 1);
    expect(working).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(working).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(intervalMs * 2);
    expect(working).toHaveBeenCalledTimes(3);

    responses[0]?.(Response.json({ ok: true }));
    await until(() => ack.mock.calls.length > 0);
    vi.advanceTimersByTime(intervalMs * 10);
    expect(working).toHaveBeenCalledTimes(3);
  });

  test('follows an ack_wait another process changes after start', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const responses = stubFetch();
    const { msg, working } = fakeMsg('msg_1');
    const { getJetStream, server } = fakeJetStream({ messages: [msg] });
    await createQueue(getJetStream, { ...baseConfig, ackWaitMs: 120_000 }).start();
    await until(() => responses.length > 0);

    vi.advanceTimersByTime(40_000);
    await flush();
    expect(working).toHaveBeenCalledTimes(1);

    // Another process lowers the shared durable to 30s: heartbeat at once, then every 10s.
    server.ackWait = 30_000_000_000;
    vi.advanceTimersByTime(5_000);
    await until(() => working.mock.calls.length === 2);
    vi.advanceTimersByTime(9_999);
    expect(working).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1);
    expect(working).toHaveBeenCalledTimes(3);
    responses[0]?.(Response.json({ ok: true }));
  });

  test('retries a transient pull failure without rebuilding the consumer', async () => {
    const responses = stubFetch();
    const { msg, ack } = fakeMsg('msg_1');
    const { add, getJetStream } = fakeJetStream({
      messages: [statusError(409, 'Leadership Change'), statusError(503, 'no responders'), msg],
    });
    await createQueue(getJetStream, baseConfig).start();
    await until(() => responses.length === 1);
    // Two streams, one consumer each: no restart re-ran the setup.
    expect(add).toHaveBeenCalledTimes(2);
    responses[0]?.(Response.json({ ok: true }));
    await until(() => ack.mock.calls.length > 0);
  });

  test('rebuilds the consumer when it was deleted and escalates its backoff', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    stubFetch();
    const { add, getJetStream } = fakeJetStream({
      messages: [statusError(409, 'Consumer Deleted'), statusError(409, 'Consumer Deleted')],
    });
    const queue = createQueue(getJetStream, baseConfig);
    await queue.start();
    const steps = () => add.mock.calls.filter(([stream]) => stream.endsWith('steps')).length;
    await until(() => steps() > 2);
    expect(error).toHaveBeenCalled();
    // Restarts must not reset the counter, or the backoff never escalates.
    expect(queue.getHealth().consecutiveFailures).toBeGreaterThanOrEqual(2);
    error.mockRestore();
  });

  test('backs the ack_wait refresh off while it fails, then recovers', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const responses = stubFetch();
    const infoFails = { value: true };
    const { msg, working } = fakeMsg('msg_1');
    const { consumerInfo, server, getJetStream } = fakeJetStream({
      infoFails,
      messages: [msg],
      serverAckWait: 300e9,
    });
    // A 100s heartbeat interval, so no beat is due before the refresh recovers.
    await createQueue(getJetStream, { ...baseConfig, ackWaitMs: 300_000 }).start();
    await until(() => responses.length > 0);

    // Three failed refreshes: it says so once, then retries every 60s.
    for (let i = 0; i < 3; i++) {
      vi.advanceTimersByTime(5_000);
      await flush();
    }
    await until(() =>
      error.mock.calls.some(([message]) => String(message).includes('could not refresh ack_wait')),
    );
    const afterFailures = consumerInfo.mock.calls.length;
    vi.advanceTimersByTime(5_000);
    await flush();
    expect(consumerInfo.mock.calls.length).toBe(afterFailures);

    // The connection comes back and another process shrinks the ack wait.
    infoFails.value = false;
    server.ackWait = 30e9;
    vi.advanceTimersByTime(SLOW_REFRESH_MS);
    await flush();
    // The in-flight delivery heartbeats at once, then at the new cadence.
    await until(() => working.mock.calls.length === 1);
    vi.advanceTimersByTime(9_999);
    expect(working).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(working).toHaveBeenCalledTimes(2);
    responses[0]?.(Response.json({ ok: true }));
    error.mockRestore();
  });

  test('pulls the next message only after the current delivery settles', async () => {
    const responses = stubFetch();
    const first = fakeMsg('msg_1', 1);
    const second = fakeMsg('msg_2', 2);
    const { getJetStream, next } = fakeJetStream({ messages: [first.msg, second.msg] });
    await createQueue(getJetStream, { ...baseConfig, ackWaitMs: 3_000 }).start();
    await until(() => responses.length === 1);
    await sleep(20);
    const stepPulls = () => next.mock.calls.filter(([stream]) => stream.endsWith('steps')).length;
    expect(stepPulls()).toBe(1);

    responses[0]?.(Response.json({ ok: true }));
    await until(() => first.ack.mock.calls.length > 0 && responses.length === 2);
    expect(stepPulls()).toBe(2);
    responses[1]?.(Response.json({ ok: true }));
    await until(() => second.ack.mock.calls.length > 0);
  });
});

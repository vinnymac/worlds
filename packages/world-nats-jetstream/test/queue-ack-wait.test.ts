import type { TimerOptions } from 'node:timers';
import type { ConsumerConfig, ConsumerInfo, JetStreamClient, JsMsg } from '@nats-io/jetstream';
import { JetStreamApiError, JetStreamError } from '@nats-io/jetstream';
import { stringify } from '@fantasticfour/shared';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { NatsJetStreamWorldConfig } from '../src/config.js';
import { createQueue } from '../src/queue.js';

/** Backoff sleeps src/queue.ts asked for. `instant` skips the wait itself. */
const backoffs = vi.hoisted(() => ({ delays: [] as number[], aborted: 0, instant: false }));

vi.mock('node:timers/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:timers/promises')>();
  return {
    ...real,
    setTimeout: async <T>(ms?: number, value?: T, options?: TimerOptions): Promise<T> => {
      backoffs.delays.push(ms ?? 0);
      try {
        return await real.setTimeout(backoffs.instant ? 0 : ms, value, options);
      } catch (error) {
        backoffs.aborted++;
        throw error;
      }
    },
  };
});

/** Captured before any test installs fake timers. */
const realSetTimeout = globalThis.setTimeout;
const sleep = (ms: number) => new Promise<void>((resolve) => realSetTimeout(resolve, ms));

type Pull = JsMsg | Error | null | (() => Promise<JsMsg | null>);

type FakeOptions = {
  existing?: boolean;
  /** Pulled in order: an Error is thrown, null is an empty pull, a function
   * is awaited. Once they run out every pull waits forever. */
  messages?: Pull[];
  /** ack_wait the server reports back; defaults to echoing the request. */
  serverAckWait?: number;
  /** ack_wait an already-existing durable holds. */
  existingAckWait?: number;
  /** max_deliver an already-existing durable holds. */
  existingMaxDeliver?: number;
  /** While true, every consumer info call rejects, as a closed connection does. */
  infoFails?: { value: boolean };
  /** While true, consumer info reports the durable as deleted. */
  consumerMissing?: { value: boolean };
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
    if (options.consumerMissing?.value) {
      throw new JetStreamApiError({
        code: 404,
        err_code: 10014,
        description: 'consumer not found',
      });
    }
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
    const pull = pending.shift();
    if (pull instanceof Error) throw pull;
    if (typeof pull === 'function') return await pull();
    return pull === undefined ? await new Promise<JsMsg>(() => {}) : pull;
  });
  const jsm = {
    streams: { add: vi.fn(async () => {}) },
    consumers: { add, update, info: consumerInfo },
  };
  const client = {
    jetstreamManager: async () => jsm,
    consumers: { get: async (stream: string) => ({ next: () => next(stream) }) },
  };
  /** Calls a mock received for the steps stream, the only one given messages. */
  const forSteps = (mock: { mock: { calls: [string, ...unknown[]][] } }) =>
    mock.mock.calls.filter(([stream]) => stream.endsWith('steps')).length;
  return {
    add,
    update,
    next,
    server,
    consumerInfo,
    stepAdds: () => forSteps(add),
    stepPulls: () => forSteps(next),
    stepInfos: () => forSteps(consumerInfo),
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
  const nak = vi.fn();
  const msg = {
    data: new TextEncoder().encode(
      stringify({ messageId, queueName: '__wkf_step_demo', message: { runId: messageId } }),
    ),
    info: { deliveryCount: 1, streamSequence: seq },
    working,
    ack,
    nak,
  } as unknown as JsMsg;
  return { msg, working, ack, nak };
}

/** Lets a promise chain settle without advancing any timer. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
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

/** Mirrors MAX_ACK_WAIT_MS in src/queue.ts: 24 days. */
const MAX_ACK_WAIT_MS = 2_073_600_000;

/** Mirrors MAX_TIMER_DELAY_MS in src/queue.ts. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

const FAKE_TIMERS = ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] as const;

const baseConfig: NatsJetStreamWorldConfig = {
  nats: 'nats://localhost:4222',
  queueConcurrency: 1,
  baseUrl: 'http://localhost:3000',
};

const started: ReturnType<typeof createQueue>[] = [];

/** Starts a queue that afterEach closes, so no worker outlives its test. */
async function startQueue(
  getJetStream: () => Promise<JetStreamClient>,
  config: NatsJetStreamWorldConfig = baseConfig,
) {
  const queue = createQueue(getJetStream, config);
  started.push(queue);
  await queue.start();
  return queue;
}

afterEach(() => {
  // Not awaited: some tests leave a delivery unanswered on purpose.
  for (const queue of started.splice(0)) void queue.close();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  backoffs.delays.length = 0;
  backoffs.aborted = 0;
  backoffs.instant = false;
});

describe('createQueue ackWaitMs', () => {
  test.each([
    0,
    -1,
    999,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    MAX_ACK_WAIT_MS + 1,
    30 * 86_400_000,
  ])('rejects ackWaitMs %s', (ackWaitMs) => {
    const { getJetStream } = fakeJetStream();
    expect(() => createQueue(getJetStream, { ...baseConfig, ackWaitMs })).toThrow(RangeError);
    expect(() => createQueue(getJetStream, { ...baseConfig, ackWaitMs })).toThrow(/ackWaitMs/);
  });

  test.each([1_000, MAX_ACK_WAIT_MS])('accepts ackWaitMs %s', (ackWaitMs) => {
    const { getJetStream } = fakeJetStream();
    expect(() => createQueue(getJetStream, { ...baseConfig, ackWaitMs })).not.toThrow();
  });

  test.each([
    { ackWaitMs: undefined, nanos: 30_000_000_000 },
    { ackWaitMs: 120_000, nanos: 120_000_000_000 },
  ])('creates consumers with ack_wait $nanos', async ({ ackWaitMs, nanos }) => {
    const { add, update, getJetStream } = fakeJetStream();
    await startQueue(getJetStream, { ...baseConfig, ackWaitMs });
    await vi.waitFor(() => expect(add).toHaveBeenCalledTimes(2));
    for (const [, cfg] of add.mock.calls) expect(cfg.ack_wait).toBe(nanos);
    expect(update).not.toHaveBeenCalled();
  });

  test('reconciles ack_wait on an existing durable consumer', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { update, getJetStream } = fakeJetStream({ existing: true, existingAckWait: 30e9 });
    await startQueue(getJetStream, { ...baseConfig, ackWaitMs: 120_000 });
    await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(2));
    for (const [, , cfg] of update.mock.calls) expect(cfg.ack_wait).toBe(120_000_000_000);
    // The warning names both the value it replaces and the one it writes.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ack_wait is 30000000000ns'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('not the configured 120000000000ns'));
  });

  test('leaves an existing ack_wait alone when ackWaitMs already matches it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { update, next, getJetStream } = fakeJetStream({
      existing: true,
      existingAckWait: 120e9,
      existingMaxDeliver: MAX_DELIVER,
    });
    await startQueue(getJetStream, { ...baseConfig, ackWaitMs: 120_000 });
    await until(() => next.mock.calls.length === 2);
    expect(update).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  test('sets a stream up once however many workers share it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { add, update, next, getJetStream } = fakeJetStream({
      existing: true,
      existingAckWait: 30e9,
    });
    await startQueue(getJetStream, { ...baseConfig, queueConcurrency: 5, ackWaitMs: 120_000 });
    await until(() => next.mock.calls.length === 10);
    // Two streams: one add, one update and one warning each, not one per worker.
    expect(add).toHaveBeenCalledTimes(2);
    expect(update).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  test('leaves an existing ack_wait alone when ackWaitMs is unset', async () => {
    const { update, next, getJetStream } = fakeJetStream({
      existing: true,
      existingAckWait: 120e9,
      existingMaxDeliver: MAX_DELIVER,
    });
    await startQueue(getJetStream);
    await until(() => next.mock.calls.length === 2);
    expect(update).not.toHaveBeenCalled();
  });

  test('updates max_deliver on an older durable without rewriting ack_wait', async () => {
    const { update, getJetStream } = fakeJetStream({
      existing: true,
      existingAckWait: 120e9,
      existingMaxDeliver: 3,
    });
    await startQueue(getJetStream);
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
    vi.useFakeTimers({ toFake: [...FAKE_TIMERS] });
    const responses = stubFetch();
    const { msg, working, ack } = fakeMsg('msg_1');
    const { getJetStream } = fakeJetStream({ messages: [msg], serverAckWait });
    await startQueue(getJetStream, { ...baseConfig, ackWaitMs });
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

  test('clamps the heartbeat for a server ack_wait too long for a timer', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.useFakeTimers({ toFake: [...FAKE_TIMERS] });
    const responses = stubFetch();
    const { msg, working } = fakeMsg('msg_1');
    // 90 days: a third of it overflows setTimeout, which would then fire after 1ms.
    const { getJetStream, stepAdds } = fakeJetStream({
      messages: [msg],
      serverAckWait: 90 * 86_400e9,
    });
    await startQueue(getJetStream);
    await until(() => responses.length > 0);

    vi.advanceTimersByTime(10);
    expect(working).not.toHaveBeenCalled();
    vi.advanceTimersByTime(MAX_TIMER_DELAY_MS - 11);
    expect(working).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(working).toHaveBeenCalledTimes(1);
    expect(stepAdds()).toBe(1);
    expect(error).not.toHaveBeenCalled();
    responses[0]?.(Response.json({ ok: true }));
  });

  test('follows an ack_wait another process changes after start', async () => {
    vi.useFakeTimers({ toFake: [...FAKE_TIMERS] });
    const responses = stubFetch();
    const { msg, working } = fakeMsg('msg_1');
    const { getJetStream, server } = fakeJetStream({ messages: [msg] });
    await startQueue(getJetStream, { ...baseConfig, ackWaitMs: 120_000 });
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

  test('retries transient pull failures in place with a growing backoff', async () => {
    backoffs.instant = true;
    const responses = stubFetch();
    const first = fakeMsg('msg_1', 1);
    const second = fakeMsg('msg_2', 2);
    const { add, getJetStream } = fakeJetStream({
      messages: [
        statusError(409, 'Leadership Change'),
        statusError(503, 'no responders'),
        first.msg,
        statusError(503, 'no responders'),
        second.msg,
      ],
    });
    await startQueue(getJetStream);
    await until(() => responses.length === 1);
    expect(backoffs.delays).toEqual([200, 400]);
    responses[0]?.(Response.json({ ok: true }));
    await until(() => first.ack.mock.calls.length > 0 && responses.length === 2);
    // A pull that worked starts the next outage's backoff from the bottom.
    expect(backoffs.delays).toEqual([200, 400, 200]);
    // Two streams, one consumer each: no restart re-ran the setup.
    expect(add).toHaveBeenCalledTimes(2);
    responses[1]?.(Response.json({ ok: true }));
    await until(() => second.ack.mock.calls.length > 0);
  });

  test("retries the fetch's codeless heartbeats missed error in place", async () => {
    backoffs.instant = true;
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const responses = stubFetch();
    const { msg, ack } = fakeMsg('msg_1');
    const { add, getJetStream } = fakeJetStream({
      messages: [new JetStreamError('heartbeats missed'), msg],
    });
    await startQueue(getJetStream);
    await until(() => responses.length === 1);
    expect(add).toHaveBeenCalledTimes(2);
    expect(error).not.toHaveBeenCalled();
    responses[0]?.(Response.json({ ok: true }));
    await until(() => ack.mock.calls.length > 0);
  });

  test('rebuilds the consumer when it was deleted and escalates its backoff', async () => {
    backoffs.instant = true;
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const responses = stubFetch();
    const { msg, ack } = fakeMsg('msg_1');
    const { stepAdds, getJetStream } = fakeJetStream({
      messages: [statusError(409, 'Consumer Deleted'), statusError(409, 'Consumer Deleted'), msg],
    });
    const queue = await startQueue(getJetStream);
    await until(() => responses.length === 1);
    expect(stepAdds()).toBe(3);
    expect(error).toHaveBeenCalledTimes(2);
    // Restarts must not reset the counter, or the backoff never escalates.
    expect(backoffs.delays).toEqual([200, 400]);
    expect(queue.getHealth().consecutiveFailures).toBe(2);

    // Only a delivery that succeeds resets it.
    responses[0]?.(Response.json({ ok: true }));
    await until(() => ack.mock.calls.length > 0);
    expect(queue.getHealth().consecutiveFailures).toBe(0);
  });

  test('rebuilds a consumer deleted between pulls, which only ever reports 503', async () => {
    backoffs.instant = true;
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { stepAdds, stepInfos, getJetStream } = fakeJetStream({
      messages: Array.from({ length: 5 }, () => statusError(503, 'no responders')),
      consumerMissing: { value: true },
    });
    await startQueue(getJetStream);
    await until(() => stepAdds() === 2);
    // Checked once, at the fifth failure, not on every 503.
    expect(stepInfos()).toBe(1);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('Error in worker'),
      expect.any(JetStreamApiError),
    );
  });

  test.each([
    { name: 'still exists', infoFails: false },
    { name: 'cannot be checked', infoFails: true },
  ])('keeps retrying a run of 503s in place when the consumer $name', async ({ infoFails }) => {
    backoffs.instant = true;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const responses = stubFetch();
    const { msg, ack } = fakeMsg('msg_1');
    const { stepAdds, stepInfos, getJetStream } = fakeJetStream({
      messages: [...Array.from({ length: 6 }, () => statusError(503, 'no responders')), msg],
      infoFails: { value: infoFails },
    });
    await startQueue(getJetStream);
    await until(() => responses.length === 1);
    expect(stepInfos()).toBe(2);
    expect(stepAdds()).toBe(1);
    responses[0]?.(Response.json({ ok: true }));
    await until(() => ack.mock.calls.length > 0);
  });

  test('backs the ack_wait refresh off while it fails, then recovers', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.useFakeTimers({ toFake: [...FAKE_TIMERS] });
    const responses = stubFetch();
    const infoFails = { value: true };
    const { msg, working } = fakeMsg('msg_1');
    const { stepInfos, server, getJetStream } = fakeJetStream({
      infoFails,
      messages: [msg],
      serverAckWait: 900e9,
    });
    const refreshErrors = () =>
      error.mock.calls.filter(([message]) =>
        String(message).includes('could not refresh ack_wait for workflow_steps_worker'),
      ).length;
    // A 300s heartbeat interval, so no beat is due before the refresh recovers.
    await startQueue(getJetStream, { ...baseConfig, ackWaitMs: 900_000 });
    await until(() => responses.length > 0);

    // Three failed refreshes: it says so once, then retries every 60s.
    for (let i = 0; i < 3; i++) {
      vi.advanceTimersByTime(5_000);
      await flush();
    }
    await until(() => refreshErrors() === 1);
    const afterFailures = stepInfos();
    vi.advanceTimersByTime(5_000);
    await flush();
    expect(stepInfos()).toBe(afterFailures);

    // A slow retry that fails too stays quiet.
    vi.advanceTimersByTime(SLOW_REFRESH_MS);
    await until(() => stepInfos() === afterFailures + 1);
    await flush();
    expect(refreshErrors()).toBe(1);

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

    // A second outage is reported once again, at the fast cadence it went back to.
    await flush();
    infoFails.value = true;
    for (let i = 0; i < 3; i++) {
      vi.advanceTimersByTime(5_000);
      await flush();
    }
    await until(() => refreshErrors() === 2);
    vi.advanceTimersByTime(SLOW_REFRESH_MS);
    await flush();
    expect(refreshErrors()).toBe(2);
    responses[0]?.(Response.json({ ok: true }));
  });

  test('pulls the next message only after the current delivery settles', async () => {
    const responses = stubFetch();
    const first = fakeMsg('msg_1', 1);
    const second = fakeMsg('msg_2', 2);
    const { getJetStream, stepPulls } = fakeJetStream({ messages: [first.msg, second.msg] });
    await startQueue(getJetStream, { ...baseConfig, ackWaitMs: 3_000 });
    await until(() => responses.length === 1);
    await flush();
    expect(stepPulls()).toBe(1);

    responses[0]?.(Response.json({ ok: true }));
    await until(() => first.ack.mock.calls.length > 0 && responses.length === 2);
    expect(stepPulls()).toBe(2);
    responses[1]?.(Response.json({ ok: true }));
    await until(() => second.ack.mock.calls.length > 0);
  });
});

describe('createQueue close', () => {
  test('ends a worker parked in a pull without pulling again or logging', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    let endPull: (msg: null) => void = () => {};
    const parked = () => new Promise<null>((resolve) => (endPull = resolve));
    const { stepAdds, stepPulls, getJetStream } = fakeJetStream({
      messages: [parked, new Error('connection draining')],
    });
    const queue = await startQueue(getJetStream);
    await until(() => stepPulls() === 1);

    const closing = queue.close();
    expect(queue.close()).toBe(closing);
    await closing;
    // The drain ends the parked fetch empty; a pull after it would throw.
    endPull(null);
    await flush();
    expect(stepPulls()).toBe(1);
    expect(stepAdds()).toBe(1);
    expect(backoffs.delays).toEqual([]);
    expect(error).not.toHaveBeenCalled();
  });

  test('hands back a message pulled while closing', async () => {
    let endPull: (msg: JsMsg) => void = () => {};
    const parked = () => new Promise<JsMsg>((resolve) => (endPull = resolve));
    const responses = stubFetch();
    const { msg, nak } = fakeMsg('msg_1');
    const { stepPulls, getJetStream } = fakeJetStream({ messages: [parked] });
    const queue = await startQueue(getJetStream);
    await until(() => stepPulls() === 1);

    await queue.close();
    endPull(msg);
    await flush();
    expect(nak).toHaveBeenCalledWith();
    expect(responses).toHaveLength(0);
    expect(stepPulls()).toBe(1);
  });

  test('waits for an in-flight delivery to ack', async () => {
    const responses = stubFetch();
    const { msg, ack } = fakeMsg('msg_1');
    const { stepPulls, getJetStream } = fakeJetStream({ messages: [msg] });
    const queue = await startQueue(getJetStream);
    await until(() => responses.length === 1);

    let closed = false;
    const closing = queue.close().then(() => (closed = true));
    await flush();
    expect(closed).toBe(false);
    expect(ack).not.toHaveBeenCalled();

    responses[0]?.(Response.json({ ok: true }));
    await closing;
    expect(ack).toHaveBeenCalledTimes(1);
    await flush();
    expect(stepPulls()).toBe(1);
  });

  test.each([
    { name: 'a transient pull failure', failure: statusError(503, 'no responders'), errors: 0 },
    { name: 'a worker teardown', failure: statusError(409, 'Consumer Deleted'), errors: 1 },
  ])('cancels the backoff after $name instead of restarting', async ({ failure, errors }) => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { stepAdds, stepPulls, getJetStream } = fakeJetStream({ messages: [failure] });
    const queue = await startQueue(getJetStream);
    await until(() => backoffs.delays.length === 1);

    await queue.close();
    await flush();
    expect(backoffs.aborted).toBe(1);
    expect(stepPulls()).toBe(1);
    expect(stepAdds()).toBe(1);
    expect(error).toHaveBeenCalledTimes(errors);
  });

  test('clears the ack_wait refresh timers, even with a refresh in flight', async () => {
    vi.useFakeTimers({ toFake: [...FAKE_TIMERS] });
    const { consumerInfo, next, getJetStream } = fakeJetStream();
    const queue = await startQueue(getJetStream);
    await until(() => next.mock.calls.length === 2);
    expect(vi.getTimerCount()).toBe(2);

    // Both refreshes fire and are still unanswered when close() runs.
    vi.advanceTimersByTime(5_000);
    expect(consumerInfo).toHaveBeenCalledTimes(2);
    await queue.close();
    await flush();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(SLOW_REFRESH_MS);
    await flush();
    expect(consumerInfo).toHaveBeenCalledTimes(2);
  });
});

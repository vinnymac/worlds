import type { MessageId, QueuePayload, QueuePrefix, ValidQueueName } from '@workflow/world';
import { Client } from '@upstash/qstash';
import { describe, expect, it, vi } from 'vitest';
import { parse } from '../src/util.js';
import { createQueue } from '../src/queue.js';

const QUEUE_NAME = '__wkf_workflow_test' as ValidQueueName;
const QUEUE_PREFIX = '__wkf_workflow_' as QueuePrefix;
const TARGET_URL = 'https://example.com/api/workflow';

interface PublishedBody {
  queueName: ValidQueueName;
  message: unknown;
  messageId: MessageId;
  deliveryCount?: number;
}

interface HandlerMeta {
  attempt: number;
  queueName: ValidQueueName;
  messageId: MessageId;
  requestId?: string;
}

function makeQueue() {
  const client = new Client({ token: 'test-token' });
  const publishSpy = vi
    .spyOn(client, 'publish')
    .mockResolvedValue({ messageId: 'qstash-msg-1', url: TARGET_URL });
  const queue = createQueue({
    client,
    token: 'test-token',
    targetUrl: TARGET_URL,
  });
  return { queue, publishSpy };
}

function publishedRequest(publishSpy: ReturnType<typeof makeQueue>['publishSpy'], call = 0) {
  const request = publishSpy.mock.calls[call][0];
  return {
    request,
    body: parse<PublishedBody>(String(request.body)),
  };
}

function deliveryRequest(body: string, headers: Record<string, string> = {}): Request {
  return new Request(TARGET_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body,
  });
}

describe('QStash queue', () => {
  describe('queue()', () => {
    it('passes opts.idempotencyKey through as the QStash deduplicationId', async () => {
      const { queue, publishSpy } = makeQueue();
      await queue.queue(QUEUE_NAME, { runId: 'wrun_1' } as QueuePayload, {
        idempotencyKey: 'step-abc',
      });

      const { request } = publishedRequest(publishSpy);
      expect(request.deduplicationId).toBe('step-abc');
    });

    it('does not set a deduplicationId when no idempotencyKey is provided', async () => {
      const { queue, publishSpy } = makeQueue();
      await queue.queue(QUEUE_NAME, { runId: 'wrun_1' } as QueuePayload);

      const { request } = publishedRequest(publishSpy);
      expect(request.deduplicationId).toBeUndefined();
    });

    it('round-trips Uint8Array message payloads through the queue body', async () => {
      const { queue, publishSpy } = makeQueue();
      const binary = new Uint8Array([1, 2, 3, 250]);
      await queue.queue(QUEUE_NAME, {
        runId: 'wrun_1',
        runInput: {
          input: [binary],
          deploymentId: 'dpl_1',
          workflowName: 'wf',
          specVersion: 4,
        },
      } as QueuePayload);

      const { body } = publishedRequest(publishSpy);
      const message = body.message as { runInput: { input: unknown[] } };
      expect(message.runInput.input[0]).toBeInstanceOf(Uint8Array);
      expect(Array.from(message.runInput.input[0] as Uint8Array)).toEqual([1, 2, 3, 250]);
    });

    it('passes delaySeconds through as QStash delay', async () => {
      const { queue, publishSpy } = makeQueue();
      await queue.queue(QUEUE_NAME, { runId: 'wrun_1' } as QueuePayload, { delaySeconds: 30 });

      const { request } = publishedRequest(publishSpy);
      expect(request.delay).toBe(30);
    });

    it('defaults the QStash retry budget to 47 (48 total deliveries)', async () => {
      const { queue, publishSpy } = makeQueue();
      await queue.queue(QUEUE_NAME, { runId: 'wrun_1' } as QueuePayload);

      const { request } = publishedRequest(publishSpy);
      // 47 retries + 1 initial delivery = 48 = core's MAX_QUEUE_DELIVERIES.
      expect(request.retries).toBe(47);
    });

    it('honors a custom retries config on publish', async () => {
      const client = new Client({ token: 'test-token' });
      const publishSpy = vi
        .spyOn(client, 'publish')
        .mockResolvedValue({ messageId: 'qstash-msg-1', url: TARGET_URL });
      const queue = createQueue({
        client,
        token: 'test-token',
        targetUrl: TARGET_URL,
        retries: 10,
      });

      await queue.queue(QUEUE_NAME, { runId: 'wrun_1' } as QueuePayload);

      const { request } = publishedRequest(publishSpy);
      expect(request.retries).toBe(10);
    });
  });

  describe('createQueueHandler()', () => {
    it('reports a 1-based attempt derived from upstash-retried', async () => {
      const { queue, publishSpy } = makeQueue();
      await queue.queue(QUEUE_NAME, { runId: 'wrun_1' } as QueuePayload);
      const { request } = publishedRequest(publishSpy);

      const calls: { message: unknown; meta: HandlerMeta }[] = [];
      const httpHandler = queue.createQueueHandler(QUEUE_PREFIX, async (message, meta) => {
        calls.push({ message, meta });
      });

      let response = await httpHandler(deliveryRequest(String(request.body)));
      expect(response.status).toBe(200);
      expect(calls[0].message).toEqual({ runId: 'wrun_1' });
      expect(calls[0].meta.attempt).toBe(1);
      expect(calls[0].meta.queueName).toBe(QUEUE_NAME);

      response = await httpHandler(
        deliveryRequest(String(request.body), { 'upstash-retried': '2' }),
      );
      expect(response.status).toBe(200);
      expect(calls[1].meta.attempt).toBe(3);
    });

    it('republishes the message with the requested delay when the handler returns { timeoutSeconds }', async () => {
      const { queue, publishSpy } = makeQueue();
      await queue.queue(QUEUE_NAME, { runId: 'wrun_1' } as QueuePayload);
      const { request, body } = publishedRequest(publishSpy);

      const httpHandler = queue.createQueueHandler(QUEUE_PREFIX, async () => ({
        timeoutSeconds: 42,
      }));
      const response = await httpHandler(deliveryRequest(String(request.body)));

      expect(response.status).toBe(200);
      expect(publishSpy).toHaveBeenCalledTimes(2);
      const { request: republished, body: republishedBody } = publishedRequest(publishSpy, 1);
      expect(republished.delay).toBe(42);
      // The self-republish gets the same hard-failure retry budget.
      expect(republished.retries).toBe(47);
      // The redelivery must not be swallowed by QStash dedup
      expect(republished.deduplicationId).toBeUndefined();
      // Same logical message, with the completed delivery recorded
      expect(republishedBody.messageId).toBe(body.messageId);
      expect(republishedBody.message).toEqual({ runId: 'wrun_1' });
      expect(republishedBody.deliveryCount).toBe(1);
    });

    it('carries deliveryCount across republishes so attempt keeps increasing', async () => {
      const { queue, publishSpy } = makeQueue();
      await queue.queue(QUEUE_NAME, { runId: 'wrun_1' } as QueuePayload);
      const first = publishedRequest(publishSpy);

      const attempts: number[] = [];
      const httpHandler = queue.createQueueHandler(QUEUE_PREFIX, async (_message, meta) => {
        attempts.push(meta.attempt);
        return { timeoutSeconds: 0 };
      });

      await httpHandler(deliveryRequest(String(first.request.body)));
      const second = publishedRequest(publishSpy, 1);
      // timeoutSeconds: 0 means immediate redelivery — no delay set
      expect(second.request.delay).toBeUndefined();
      expect(second.body.deliveryCount).toBe(1);

      await httpHandler(deliveryRequest(String(second.request.body)));
      const third = publishedRequest(publishSpy, 2);
      expect(third.body.deliveryCount).toBe(2);

      expect(attempts).toEqual([1, 2]);
    });

    it('does not republish when the handler returns void', async () => {
      const { queue, publishSpy } = makeQueue();
      await queue.queue(QUEUE_NAME, { runId: 'wrun_1' } as QueuePayload);
      const { request } = publishedRequest(publishSpy);

      const httpHandler = queue.createQueueHandler(QUEUE_PREFIX, async () => undefined);
      const response = await httpHandler(deliveryRequest(String(request.body)));

      expect(response.status).toBe(200);
      expect(publishSpy).toHaveBeenCalledTimes(1);
    });

    it('returns 500 when the handler throws so QStash retries the delivery', async () => {
      const { queue, publishSpy } = makeQueue();
      await queue.queue(QUEUE_NAME, { runId: 'wrun_1' } as QueuePayload);
      const { request } = publishedRequest(publishSpy);

      const httpHandler = queue.createQueueHandler(QUEUE_PREFIX, async () => {
        throw new Error('storage unavailable');
      });
      const response = await httpHandler(deliveryRequest(String(request.body)));

      expect(response.status).toBe(500);
      expect(publishSpy).toHaveBeenCalledTimes(1);
    });

    it('returns 500 when the republish fails so the delivery is retried', async () => {
      const { queue, publishSpy } = makeQueue();
      await queue.queue(QUEUE_NAME, { runId: 'wrun_1' } as QueuePayload);
      const { request } = publishedRequest(publishSpy);

      publishSpy.mockRejectedValueOnce(new Error('qstash unavailable'));
      const httpHandler = queue.createQueueHandler(QUEUE_PREFIX, async () => ({
        timeoutSeconds: 5,
      }));
      const response = await httpHandler(deliveryRequest(String(request.body)));

      expect(response.status).toBe(500);
    });

    it('round-trips Uint8Array payloads to the handler', async () => {
      const { queue, publishSpy } = makeQueue();
      const binary = new Uint8Array([9, 8, 7]);
      await queue.queue(QUEUE_NAME, {
        runId: 'wrun_1',
        runInput: {
          input: [binary],
          deploymentId: 'dpl_1',
          workflowName: 'wf',
          specVersion: 4,
        },
      } as QueuePayload);
      const { request } = publishedRequest(publishSpy);

      let received: unknown;
      const httpHandler = queue.createQueueHandler(QUEUE_PREFIX, async (message) => {
        received = message;
      });
      await httpHandler(deliveryRequest(String(request.body)));

      const payload = received as { runInput: { input: unknown[] } };
      expect(payload.runInput.input[0]).toBeInstanceOf(Uint8Array);
      expect(Array.from(payload.runInput.input[0] as Uint8Array)).toEqual([9, 8, 7]);
    });
  });
});

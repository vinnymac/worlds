import { parse, stringify } from '@fantasticfour/shared';
import type { ValidQueueName } from '@workflow/world';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createQueue } from '../src/queue.js';

interface SentMessage {
  body: string;
  options?: { contentType?: string; delaySeconds?: number };
}

interface MockClaimStub {
  claimInflight: ReturnType<typeof vi.fn>;
  releaseInflight: ReturnType<typeof vi.fn>;
}

function createMockClaimNamespace() {
  const claims = new Map<string, { messageId: string; claimedAt: number }>();
  const stubs = new Map<string, MockClaimStub>();

  const getStub = (name: string): MockClaimStub => {
    let stub = stubs.get(name);
    if (!stub) {
      stub = {
        claimInflight: vi.fn(async (params: { messageId: string; staleMs: number }) => {
          const existing = claims.get(name);
          const now = Date.now();
          if (
            existing &&
            existing.messageId !== params.messageId &&
            now - existing.claimedAt < params.staleMs
          ) {
            return { claimed: false };
          }
          claims.set(name, { messageId: params.messageId, claimedAt: now });
          return { claimed: true };
        }),
        releaseInflight: vi.fn(async () => {
          claims.delete(name);
        }),
      };
      stubs.set(name, stub);
    }
    return stub;
  };

  return {
    claims,
    stubs,
    namespace: {
      idFromName: (name: string) => ({ toString: () => name }),
      get: (id: { toString(): string }) => getStub(id.toString()),
    },
  };
}

describe('Queue (Cloudflare Queues integration)', () => {
  let sent: SentMessage[];
  let mockQueue: { send: ReturnType<typeof vi.fn> };
  let claimNamespace: ReturnType<typeof createMockClaimNamespace>;
  let mockEnv: {
    WORKFLOW_QUEUE: { send: ReturnType<typeof vi.fn> };
    WORKFLOW_DB: ReturnType<typeof createMockClaimNamespace>['namespace'];
  };
  let queue: ReturnType<typeof createQueue>;

  // Save original env vars
  const originalVitest = process.env.VITEST;
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    sent = [];
    mockQueue = {
      send: vi.fn(async (body: string, options?: SentMessage['options']) => {
        sent.push({ body, options });
      }),
    };
    claimNamespace = createMockClaimNamespace();

    mockEnv = {
      WORKFLOW_QUEUE: mockQueue,
      WORKFLOW_DB: claimNamespace.namespace,
    };
  });

  afterEach(() => {
    // Restore env vars
    process.env.VITEST = originalVitest;
    process.env.NODE_ENV = originalNodeEnv;
    vi.clearAllMocks();
  });

  describe('queue() - Production Mode', () => {
    beforeEach(() => {
      // Ensure production mode
      delete process.env.VITEST;
      process.env.NODE_ENV = 'production';

      queue = createQueue({
        env: mockEnv,
        deploymentId: 'test-deployment',
      });
    });

    it('should send a tagged-JSON text envelope', async () => {
      const queueName = 'test-queue' as ValidQueueName;
      const message = { data: 'test-message' };

      const result = await queue.queue(queueName, message);

      expect(mockQueue.send).toHaveBeenCalledOnce();
      const [body, options] = mockQueue.send.mock.calls[0];
      expect(typeof body).toBe('string');
      expect(options).toMatchObject({ contentType: 'text' });

      const envelope = parse<{
        messageId: string;
        queueName: string;
        message: unknown;
        timestamp: number;
      }>(body);
      expect(envelope.queueName).toBe(queueName);
      expect(envelope.message).toEqual(message);
      expect(envelope.messageId).toMatch(/^msg_/);
      expect(envelope.timestamp).toBeTypeOf('number');

      expect(result.messageId).toBe(envelope.messageId);
    });

    it('should include the idempotency key in the envelope', async () => {
      const queueName = 'test-queue' as ValidQueueName;
      const idempotencyKey = 'unique-key-123';

      await queue.queue(queueName, { data: 'test' }, { idempotencyKey });

      const envelope = parse<{ idempotencyKey?: string }>(sent[0].body);
      expect(envelope.idempotencyKey).toBe(idempotencyKey);
    });

    it('should pass delaySeconds through to Cloudflare Queues', async () => {
      await queue.queue('test-queue' as ValidQueueName, {}, { delaySeconds: 42 });

      expect(sent[0].options).toMatchObject({ delaySeconds: 42 });
    });

    it('should generate unique monotonic message IDs', async () => {
      const first = await queue.queue('test-queue' as ValidQueueName, {});
      const second = await queue.queue('test-queue' as ValidQueueName, {});

      expect(first.messageId).toMatch(/^msg_/);
      expect(second.messageId).toMatch(/^msg_/);
      expect(first.messageId).not.toBe(second.messageId);
    });

    it('should round-trip Uint8Array payloads (binary-safe transport)', async () => {
      const input = new Uint8Array([0, 1, 2, 250, 251, 252]);
      await queue.queue('test-queue' as ValidQueueName, {
        runId: 'wrun_1',
        runInput: { input, deploymentId: 'd', workflowName: 'w', specVersion: 3 },
      });

      const envelope = parse<{
        message: { runInput: { input: Uint8Array } };
      }>(sent[0].body);
      expect(envelope.message.runInput.input).toBeInstanceOf(Uint8Array);
      expect(Array.from(envelope.message.runInput.input)).toEqual([0, 1, 2, 250, 251, 252]);
    });

    it('should handle complex message payloads', async () => {
      const message = {
        nested: {
          object: {
            with: ['arrays', 'and', 'strings'],
          },
        },
        number: 42,
        boolean: true,
      };

      await queue.queue('test-queue' as ValidQueueName, message);

      const envelope = parse<{ message: unknown }>(sent[0].body);
      expect(envelope.message).toEqual(message);
    });
  });

  describe('queue() - Test Mode', () => {
    beforeEach(() => {
      // Set test mode BEFORE creating queue
      process.env.VITEST = 'true';
    });

    it('should not call Cloudflare Queue in test mode', async () => {
      // Create queue in test mode
      queue = createQueue({
        env: mockEnv,
        deploymentId: 'test-deployment',
      });

      // Register handler for embedded world
      queue.createQueueHandler('test:', vi.fn());

      const queueName = 'test:queue' as ValidQueueName;
      const message = { data: 'test' };

      // Attempt to queue - embedded world will handle it
      try {
        await queue.queue(queueName, message);
      } catch {
        // Embedded world may throw if no handler, that's OK for this test
        // We're just verifying Cloudflare Queue wasn't called
      }

      // Main assertion: Cloudflare Queue should NOT be called
      expect(mockQueue.send).not.toHaveBeenCalled();
    });

    it('should detect test mode from NODE_ENV', async () => {
      // Reset VITEST and use NODE_ENV instead
      delete process.env.VITEST;
      process.env.NODE_ENV = 'test';

      queue = createQueue({
        env: mockEnv,
        deploymentId: 'test-deployment',
      });

      queue.createQueueHandler('test:', vi.fn());

      try {
        await queue.queue('test:queue' as ValidQueueName, { data: 'test' });
      } catch {
        // Ignore errors from embedded world
      }

      // Main assertion: Cloudflare Queue should NOT be called
      expect(mockQueue.send).not.toHaveBeenCalled();
    });

    it('should dedup messages on idempotencyKey while inflight', async () => {
      queue = createQueue({
        env: mockEnv,
        deploymentId: 'test-deployment',
      });

      const first = await queue.queue(
        '__wkf_step_a' as ValidQueueName,
        { data: 1 },
        { idempotencyKey: 'step-abc' },
      );
      const second = await queue.queue(
        '__wkf_step_a' as ValidQueueName,
        { data: 1 },
        { idempotencyKey: 'step-abc' },
      );

      // Same inflight message: the duplicate enqueue returns the original id
      expect(second.messageId).toBe(first.messageId);

      const third = await queue.queue(
        '__wkf_step_a' as ValidQueueName,
        { data: 2 },
        { idempotencyKey: 'step-other' },
      );
      expect(third.messageId).not.toBe(first.messageId);
    });
  });

  describe('createQueueHandler() - Production Mode', () => {
    beforeEach(() => {
      delete process.env.VITEST;
      process.env.NODE_ENV = 'production';

      queue = createQueue({
        env: mockEnv,
        deploymentId: 'test-deployment',
      });
    });

    function envelopeRequest(
      envelope: Record<string, unknown>,
      headers?: Record<string, string>,
    ): Request {
      return new Request('http://localhost', {
        method: 'POST',
        headers,
        body: stringify(envelope),
      });
    }

    it('should create handler function', () => {
      const handler = vi.fn();
      const queueHandler = queue.createQueueHandler('workflow:', handler);

      expect(typeof queueHandler).toBe('function');
    });

    it('should invoke handler with correct message', async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      const queueHandler = queue.createQueueHandler('workflow:', handler);

      const response = await queueHandler(
        envelopeRequest({
          messageId: 'msg_test_1',
          queueName: 'workflow:test-queue',
          message: { data: 'test-data' },
        }),
      );

      expect(response.status).toBe(200);
      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith(
        { data: 'test-data' },
        expect.objectContaining({
          queueName: 'workflow:test-queue',
          attempt: 1,
          messageId: 'msg_test_1',
        }),
      );
    });

    it('should revive Uint8Array payloads before invoking the handler', async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      const queueHandler = queue.createQueueHandler('workflow:', handler);

      const input = new Uint8Array([9, 8, 7]);
      const response = await queueHandler(
        envelopeRequest({
          messageId: 'msg_test_bin',
          queueName: 'workflow:test-queue',
          message: { runInput: { input } },
        }),
      );

      expect(response.status).toBe(200);
      const [message] = handler.mock.calls[0];
      expect(message.runInput.input).toBeInstanceOf(Uint8Array);
      expect(Array.from(message.runInput.input)).toEqual([9, 8, 7]);
    });

    it('should extract retry count from headers', async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      const queueHandler = queue.createQueueHandler('workflow:', handler);

      await queueHandler(
        envelopeRequest(
          {
            messageId: 'msg_test_2',
            queueName: 'workflow:test-queue',
            message: { data: 'test' },
          },
          { 'CF-Queue-Retry-Count': '2' },
        ),
      );

      expect(handler).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          attempt: 3, // Retry count 2 + 1 = attempt 3
        }),
      );
    });

    it('should prefer the CF-Queue-Message-Id header over the envelope', async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      const queueHandler = queue.createQueueHandler('workflow:', handler);

      await queueHandler(
        envelopeRequest(
          {
            messageId: 'msg_envelope',
            queueName: 'workflow:test-queue',
            message: { data: 'test' },
          },
          { 'CF-Queue-Message-Id': 'msg_cloudflare_123' },
        ),
      );

      expect(handler).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          messageId: 'msg_cloudflare_123',
        }),
      );
    });

    it('should signal redelivery instead of acking when the handler returns timeoutSeconds', async () => {
      const handler = vi.fn().mockResolvedValue({ timeoutSeconds: 30 });
      const queueHandler = queue.createQueueHandler('workflow:', handler);

      const response = await queueHandler(
        envelopeRequest({
          messageId: 'msg_retrying',
          queueName: 'workflow:test-queue',
          message: { data: 'test' },
        }),
      );

      // Retryable non-2xx: the consumer maps this onto message.retry()
      expect(response.status).toBe(503);
      expect(response.headers.get('Retry-After')).toBe('30');
      const body = await response.json();
      expect(body.timeoutSeconds).toBe(30);
    });

    it('should claim the idempotency key before invoking and release it after success', async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      const queueHandler = queue.createQueueHandler('workflow:', handler);

      const response = await queueHandler(
        envelopeRequest({
          messageId: 'msg_claim_1',
          queueName: 'workflow:test-queue',
          message: { data: 'test' },
          idempotencyKey: 'step-1',
        }),
      );

      expect(response.status).toBe(200);
      const stub = claimNamespace.stubs.get('claim:workflow:test-queue:step-1');
      expect(stub).toBeDefined();
      expect(stub!.claimInflight).toHaveBeenCalledOnce();
      expect(stub!.releaseInflight).toHaveBeenCalledOnce();
      // Claim released -> map empty
      expect(claimNamespace.claims.size).toBe(0);
    });

    it('should ack a duplicate message without invoking the handler', async () => {
      const handler = vi.fn().mockResolvedValue({ timeoutSeconds: 60 });
      const queueHandler = queue.createQueueHandler('workflow:', handler);

      // First delivery claims the key and stays inflight (503, no release).
      const first = await queueHandler(
        envelopeRequest({
          messageId: 'msg_dup_a',
          queueName: 'workflow:test-queue',
          message: { data: 'test' },
          idempotencyKey: 'step-dup',
        }),
      );
      expect(first.status).toBe(503);
      expect(handler).toHaveBeenCalledTimes(1);

      // A DIFFERENT message with the same idempotencyKey is a duplicate.
      const second = await queueHandler(
        envelopeRequest({
          messageId: 'msg_dup_b',
          queueName: 'workflow:test-queue',
          message: { data: 'test' },
          idempotencyKey: 'step-dup',
        }),
      );
      expect(second.status).toBe(200);
      const body = await second.json();
      expect(body.duplicate).toBe(true);
      expect(handler).toHaveBeenCalledTimes(1);

      // Redelivery of the SAME message re-enters its own claim.
      const redelivery = await queueHandler(
        envelopeRequest({
          messageId: 'msg_dup_a',
          queueName: 'workflow:test-queue',
          message: { data: 'test' },
          idempotencyKey: 'step-dup',
        }),
      );
      expect(redelivery.status).toBe(503);
      expect(handler).toHaveBeenCalledTimes(2);
    });

    it('should keep the claim on transient errors so the redelivery can re-enter it', async () => {
      const handler = vi.fn().mockRejectedValue(new Error('transient'));
      const queueHandler = queue.createQueueHandler('workflow:', handler);

      const response = await queueHandler(
        envelopeRequest({
          messageId: 'msg_transient',
          queueName: 'workflow:test-queue',
          message: { data: 'test' },
          idempotencyKey: 'step-transient',
        }),
      );

      expect(response.status).toBe(500);
      const stub = claimNamespace.stubs.get('claim:workflow:test-queue:step-transient');
      expect(stub!.releaseInflight).not.toHaveBeenCalled();
      expect(claimNamespace.claims.size).toBe(1);
    });

    it('should reject messages with invalid queue name prefix', async () => {
      const handler = vi.fn();
      const queueHandler = queue.createQueueHandler('workflow:', handler);

      const response = await queueHandler(
        envelopeRequest({
          queueName: 'invalid:test-queue', // Wrong prefix
          message: { data: 'test' },
        }),
      );

      expect(response.status).toBe(400);
      expect(await response.text()).toBe('Invalid queue');
      expect(handler).not.toHaveBeenCalled();
    });

    it('should reject malformed message body', async () => {
      const handler = vi.fn();
      const queueHandler = queue.createQueueHandler('workflow:', handler);

      const response = await queueHandler(
        envelopeRequest({
          // Missing queueName and message
          invalid: 'data',
        }),
      );

      expect(response.status).toBe(400);
      expect(await response.text()).toBe('Invalid message format');
      expect(handler).not.toHaveBeenCalled();
    });

    it('should handle handler errors gracefully', async () => {
      const handler = vi.fn().mockRejectedValue(new Error('Handler error'));
      const queueHandler = queue.createQueueHandler('workflow:', handler);

      const response = await queueHandler(
        envelopeRequest({
          messageId: 'msg_err',
          queueName: 'workflow:test-queue',
          message: { data: 'test' },
        }),
      );

      expect(response.status).toBe(500);
      expect(response.headers.get('Retry-After')).toBeDefined();
      const errorBody = await response.json();
      expect(errorBody.error).toContain('Handler error');
    });

    it('should accept queue names with exact prefix match', async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      const queueHandler = queue.createQueueHandler('workflow:', handler);

      const response = await queueHandler(
        envelopeRequest({
          messageId: 'msg_ok',
          queueName: 'workflow:my-queue',
          message: { data: 'test' },
        }),
      );

      expect(response.status).toBe(200);
      expect(handler).toHaveBeenCalled();
    });
  });

  describe('createQueueHandler() - Test Mode', () => {
    beforeEach(() => {
      process.env.VITEST = 'true';

      queue = createQueue({
        env: mockEnv,
        deploymentId: 'test-deployment',
      });
    });

    it('should use embedded world handler in test mode', () => {
      const handler = vi.fn();
      const queueHandler = queue.createQueueHandler('workflow:', handler);

      // In test mode, returns embedded world's handler
      expect(typeof queueHandler).toBe('function');
    });

    it('should parse tagged-JSON bodies and honor timeoutSeconds', async () => {
      const handler = vi.fn().mockResolvedValue({ timeoutSeconds: 5 });
      const queueHandler = queue.createQueueHandler('workflow:', handler);

      const input = new Uint8Array([1, 2, 3]);
      const response = await queueHandler(
        new Request('http://localhost', {
          method: 'POST',
          headers: {
            'x-vqs-queue-name': 'workflow:test-queue',
            'x-vqs-message-id': 'msg_test',
            'x-vqs-message-attempt': '1',
          },
          body: stringify({ runInput: { input } }),
        }),
      );

      expect(response.status).toBe(503);
      const body = await response.json();
      expect(body.timeoutSeconds).toBe(5);

      const [message] = handler.mock.calls[0];
      expect(message.runInput.input).toBeInstanceOf(Uint8Array);
    });
  });

  describe('getDeploymentId()', () => {
    beforeEach(() => {
      queue = createQueue({
        env: mockEnv,
        deploymentId: 'custom-deployment-123',
      });
    });

    it('should return configured deployment ID', async () => {
      const deploymentId = await queue.getDeploymentId();

      expect(deploymentId).toBe('custom-deployment-123');
    });
  });

  describe('start()', () => {
    beforeEach(() => {
      queue = createQueue({
        env: mockEnv,
        deploymentId: 'test-deployment',
      });
    });

    it('should exist and be callable', async () => {
      await expect(queue.start()).resolves.toBeUndefined();
    });

    it('should not throw errors', async () => {
      await queue.start();
      await queue.start(); // Multiple calls should be safe
    });
  });
});

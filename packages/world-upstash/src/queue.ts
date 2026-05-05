import type {
  MessageId,
  Queue,
  QueueOptions,
  QueuePayload,
  QueuePrefix,
  ValidQueueName,
} from '@workflow/world';
import { Client } from '@upstash/qstash';
import { monotonicFactory } from 'ulid';

interface QStashQueueConfig {
  client?: Client;
  token?: string;
  targetUrl?: string;
  deploymentId?: string;
}

export function createQueue(config: QStashQueueConfig): Queue {
  const token = config.token || process.env.QSTASH_TOKEN;
  const targetUrl = config.targetUrl || process.env.QSTASH_TARGET_URL;
  const deploymentId =
    config.deploymentId || process.env.WORKFLOW_DEPLOYMENT_ID || 'upstash-default';
  const ulid = monotonicFactory();

  if (!token) {
    throw new Error('QStash token is required. Set QSTASH_TOKEN environment variable.');
  }

  if (!targetUrl) {
    throw new Error('QStash target URL is required. Set QSTASH_TARGET_URL environment variable.');
  }

  const client = config.client || new Client({ token });

  return {
    async getDeploymentId(): Promise<string> {
      return deploymentId;
    },

    async queue(
      queueName: ValidQueueName,
      message: QueuePayload,
      opts: QueueOptions = {},
    ): Promise<{ messageId: MessageId | null }> {
      const messageId = `wmsg_${ulid()}` as MessageId;

      await client.publishJSON({
        url: targetUrl,
        body: {
          queueName,
          message,
          messageId,
        },
        ...(opts.delaySeconds && { delay: opts.delaySeconds }),
        ...(opts.headers && { headers: opts.headers }),
      });

      return { messageId };
    },

    createQueueHandler(
      _queueNamePrefix: QueuePrefix,
      handler: (
        message: unknown,
        meta: {
          attempt: number;
          queueName: ValidQueueName;
          messageId: MessageId;
          requestId?: string;
        },
      ) => Promise<void | { timeoutSeconds: number }>,
    ): (req: Request) => Promise<Response> {
      return async (req: Request): Promise<Response> => {
        try {
          const body = await req.json();
          const { queueName, message, messageId } = body as {
            queueName: ValidQueueName;
            message: unknown;
            messageId: MessageId;
          };

          const attempt = Number.parseInt(req.headers.get('upstash-retried') || '0', 10);
          const requestId = req.headers.get('x-request-id') || undefined;

          await handler(message, {
            attempt,
            queueName,
            messageId,
            requestId,
          });

          return new Response('OK', { status: 200 });
        } catch (error) {
          console.error('Queue handler error:', error);
          return new Response('Internal Server Error', { status: 500 });
        }
      };
    },
  };
}

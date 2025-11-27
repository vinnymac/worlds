import { Client } from '@upstash/qstash';
import { MessageId, type Queue } from '@workflow/world';

export interface QStashConfig {
  token: string;
  targetUrl: string;
}

export function createQueue(
  config: QStashConfig,
  deploymentId: string
): Queue & { start(): Promise<void> } {
  const client = new Client({ token: config.token });

  return {
    queue: async (queueName, message, opts) => {
      const response = await client.publishJSON({
        url: `${config.targetUrl}/queue/${queueName}`,
        body: message,
        retries: 3,
        deduplicationId: opts?.idempotencyKey,
      });

      // QStash returns an object with messageId, extract and parse as branded type
      const rawId =
        typeof response === 'string' ? response : response.messageId;
      const messageId = MessageId.parse(`msg_${rawId}`);

      return { messageId };
    },

    createQueueHandler: (queueNamePrefix, handler) => {
      return async (req: Request) => {
        const url = new URL(req.url);
        const queueName = url.pathname.split('/').pop() as
          | `__wkf_workflow_${string}`
          | `__wkf_step_${string}`;

        if (!queueName.startsWith(queueNamePrefix)) {
          return new Response('Invalid queue', { status: 400 });
        }

        try {
          const message = await req.json();
          const rawId = req.headers.get('Upstash-Message-Id') || 'unknown';
          await handler(message, {
            attempt: 1,
            queueName,
            messageId: MessageId.parse(`msg_${rawId}`),
          });

          return new Response('OK', { status: 200 });
        } catch (error) {
          return new Response(JSON.stringify({ error: String(error) }), {
            status: 500,
          });
        }
      };
    },

    getDeploymentId: async () => deploymentId,

    start: async () => {
      // QStash is push-based, no polling needed
    },
  };
}

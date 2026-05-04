import type { ServiceBusClient, ServiceBusSender } from '@azure/service-bus';
import type { Queue } from '@workflow/world';
import { MessageId } from '@workflow/world';
import { createLocalWorld } from '@workflow/world-local';

interface ServiceBusConfig {
  client?: ServiceBusClient;
  queueName?: string;
  deploymentId: string;
}

export function createQueue(config: ServiceBusConfig): Queue & {
  start(): Promise<void>;
  processAllQueuedTasks?: () => Promise<void>;
} {
  const { client, queueName = 'workflow-queue', deploymentId } = config;

  // Create embedded world for test orchestration (like world-redis and world-firestore)
  const port = process.env.PORT ? Number(process.env.PORT) : undefined;
  const embeddedWorld = createLocalWorld({ dataDir: undefined, port });

  // Detect test mode
  const isTest =
    process.env.VITEST === 'true' || process.env.NODE_ENV === 'test' || !client;

  let sender: ServiceBusSender | undefined;
  if (client && !isTest) {
    sender = client.createSender(queueName);
  }

  // Extract createQueueHandler as direct reference (like world-redis pattern)
  const createQueueHandler = isTest
    ? embeddedWorld.createQueueHandler
    : (queueNamePrefix: string, handler: any) => {
        // In production: create Service Bus handler
        return async (req: Request) => {
          try {
            const url = new URL(req.url);
            const receivedQueueName = url.pathname.split('/').pop() as
              | `__wkf_workflow_${string}`
              | `__wkf_step_${string}`;

            if (!receivedQueueName.startsWith(queueNamePrefix)) {
              return new Response('Invalid queue', { status: 400 });
            }

            const message = await req.json();

            // Service Bus provides delivery count in broker properties
            const deliveryCount =
              req.headers.get('X-ServiceBus-DeliveryCount') || '0';
            const attempt = Number.parseInt(deliveryCount, 10) + 1;
            const messageId =
              req.headers.get('X-ServiceBus-MessageId') ||
              Date.now().toString();

            await handler(message, {
              attempt,
              queueName: receivedQueueName,
              messageId: MessageId.parse(`msg_${messageId}`),
            });

            return new Response('OK', { status: 200 });
          } catch (error) {
            return new Response(JSON.stringify({ error: String(error) }), {
              status: 500,
            });
          }
        };
      };

  return {
    async queue(queueName, message, opts) {
      // Re-check test mode on each call
      const currentIsTest =
        process.env.VITEST === 'true' ||
        process.env.NODE_ENV === 'test' ||
        !client;
      if (currentIsTest) {
        return await embeddedWorld.queue(queueName, message as any, opts);
      }

      // In production: use Service Bus
      if (!sender) {
        throw new Error('Service Bus sender not initialized');
      }

      const messageIdValue = opts?.idempotencyKey || `msg_${Date.now()}`;

      await sender.sendMessages({
        body: message,
        messageId: messageIdValue,
        subject: queueName,
        applicationProperties: {
          queueName,
          deploymentId,
        },
      });

      return { messageId: MessageId.parse(`msg_${messageIdValue}`) };
    },

    createQueueHandler,

    async getDeploymentId() {
      return deploymentId;
    },

    async start() {
      if (isTest && embeddedWorld.start) {
        await embeddedWorld.start();
      }
      // In production: Service Bus is push-based via receivers or Azure Functions triggers
    },
  };
}

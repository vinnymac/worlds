import type { CosmosClient, Database } from '@azure/cosmos';
import { CosmosClient as CosmosClientClass } from '@azure/cosmos';
import type { ServiceBusClient } from '@azure/service-bus';
import { ServiceBusClient as ServiceBusClientClass } from '@azure/service-bus';
import type { World } from '@workflow/world';
import { createQueue } from './queue.js';
import { createStorage } from './storage.js';
import { createStreamer } from './streamer.js';

export interface AzureWorldConfig {
  cosmosClient?: CosmosClient;
  serviceBusClient?: ServiceBusClient;
  /** Cosmos DB database name. Defaults to 'workflow' */
  databaseName?: string;
  /** Service Bus queue name. Defaults to 'workflow-queue' */
  queueName?: string;
  deploymentId?: string;
}

/**
 * Container names used by the Azure world.
 * - workflow_runs: Main container with partition key /runId (stores runs, events, steps, hooks)
 * - hooks_by_token: Secondary container with partition key /token (O(1) hook lookups)
 * - workflow_streams: Stream chunks with partition key /streamId
 */
const CONTAINER_WORKFLOW_RUNS = 'workflow_runs';
const CONTAINER_HOOKS_BY_TOKEN = 'hooks_by_token';
const CONTAINER_WORKFLOW_STREAMS = 'workflow_streams';

/**
 * Ensure the database and containers exist. Creates them if they don't.
 * This is safe to call multiple times (idempotent).
 */
async function ensureInfrastructure(
  cosmosClient: CosmosClient,
  databaseName: string
): Promise<Database> {
  const { database } = await cosmosClient.databases.createIfNotExists({
    id: databaseName,
  });

  await Promise.all([
    database.containers.createIfNotExists({
      id: CONTAINER_WORKFLOW_RUNS,
      partitionKey: { paths: ['/runId'] },
    }),
    database.containers.createIfNotExists({
      id: CONTAINER_HOOKS_BY_TOKEN,
      partitionKey: { paths: ['/token'] },
    }),
    database.containers.createIfNotExists({
      id: CONTAINER_WORKFLOW_STREAMS,
      partitionKey: { paths: ['/streamId'] },
    }),
  ]);

  return database;
}

export function createAzureWorld(
  config: AzureWorldConfig = {}
): World & { start(): Promise<void> } {
  const databaseName =
    config.databaseName || process.env.COSMOS_DATABASE || 'workflow';
  const queueName =
    config.queueName || process.env.SERVICE_BUS_QUEUE || 'workflow-queue';
  const deploymentId =
    config.deploymentId ||
    process.env.WORKFLOW_DEPLOYMENT_ID ||
    'azure-default';

  // Initialize Cosmos DB client if not provided
  const cosmosClient =
    config.cosmosClient ||
    (() => {
      const endpoint = process.env.COSMOS_ENDPOINT || 'https://localhost:8081';
      const key = process.env.COSMOS_KEY;

      // Determine if using emulator (localhost or self-signed cert)
      const isEmulator = endpoint.includes('localhost') || endpoint.includes('127.0.0.1');

      // Configure connection policy with SSL handling for emulator
      const connectionPolicy = isEmulator
        ? {
            requestTimeout: 30000,
          }
        : {
            requestTimeout: 10000,
          };

      // Configure HTTPS agent for emulator's self-signed certificate
      // See: https://learn.microsoft.com/en-us/azure/cosmos-db/local-emulator-export-ssl-certificates
      let agent;
      if (isEmulator) {
        const https = require('https');
        agent = new https.Agent({
          rejectUnauthorized: false, // Accept self-signed certificates for emulator
        });
      }

      if (key) {
        return new CosmosClientClass({
          endpoint,
          key,
          connectionPolicy,
          ...(agent && { agent }),
        });
      }

      // For Azure AD authentication in production
      try {
        const { DefaultAzureCredential } = require('@azure/identity');
        return new CosmosClientClass({
          endpoint,
          aadCredentials: new DefaultAzureCredential(),
          connectionPolicy,
        });
      } catch {
        // Fall back to emulator key for local development
        return new CosmosClientClass({
          endpoint,
          key: 'C2y6yDjf5/R+ob0N8A7Cgv30VRDJIWEHLM+4QDU5DE2nQ9nDuVTqobD4b8mGGyPMbIZnqyMsEcaGQy67XIw/Jw==',
          connectionPolicy,
          ...(agent && { agent }),
        });
      }
    })();

  // Service Bus client (optional for test mode)
  let serviceBusClient: ServiceBusClient | undefined = config.serviceBusClient;
  if (!serviceBusClient && process.env.SERVICE_BUS_CONNECTION_STRING) {
    serviceBusClient = new ServiceBusClientClass(
      process.env.SERVICE_BUS_CONNECTION_STRING
    );
  }

  // Lazy-initialized database reference
  let database: Database | undefined;

  async function getDatabase(): Promise<Database> {
    if (!database) {
      database = await ensureInfrastructure(cosmosClient, databaseName);
    }
    return database;
  }

  // Create the world components with lazy container access
  // We use a proxy pattern to defer container access until the database is initialized
  let storageInstance: ReturnType<typeof createStorage> | undefined;
  let streamerInstance: ReturnType<typeof createStreamer> | undefined;

  const queue = createQueue({
    client: serviceBusClient,
    queueName,
    deploymentId,
  });

  return {
    get runs() {
      if (!storageInstance) {
        throw new Error('Azure world not started. Call start() first.');
      }
      return storageInstance.runs;
    },

    get events() {
      if (!storageInstance) {
        throw new Error('Azure world not started. Call start() first.');
      }
      return storageInstance.events;
    },

    get steps() {
      if (!storageInstance) {
        throw new Error('Azure world not started. Call start() first.');
      }
      return storageInstance.steps;
    },

    get hooks() {
      if (!storageInstance) {
        throw new Error('Azure world not started. Call start() first.');
      }
      return storageInstance.hooks;
    },

    queue: queue.queue,
    createQueueHandler: queue.createQueueHandler,
    getDeploymentId: queue.getDeploymentId,

    get writeToStream() {
      if (!streamerInstance) {
        throw new Error('Azure world not started. Call start() first.');
      }
      return streamerInstance.writeToStream;
    },

    get closeStream() {
      if (!streamerInstance) {
        throw new Error('Azure world not started. Call start() first.');
      }
      return streamerInstance.closeStream;
    },

    get readFromStream() {
      if (!streamerInstance) {
        throw new Error('Azure world not started. Call start() first.');
      }
      return streamerInstance.readFromStream;
    },

    get listStreamsByRunId() {
      if (!streamerInstance) {
        throw new Error('Azure world not started. Call start() first.');
      }
      return streamerInstance.listStreamsByRunId;
    },

    get getStreamChunks() {
      if (!streamerInstance) {
        throw new Error('Azure world not started. Call start() first.');
      }
      return streamerInstance.getStreamChunks;
    },

    get getStreamInfo() {
      if (!streamerInstance) {
        throw new Error('Azure world not started. Call start() first.');
      }
      return streamerInstance.getStreamInfo;
    },

    async start() {
      const db = await getDatabase();

      storageInstance = createStorage({
        container: db.container(CONTAINER_WORKFLOW_RUNS),
        hooksByTokenContainer: db.container(CONTAINER_HOOKS_BY_TOKEN),
        deploymentId,
      });

      streamerInstance = createStreamer({
        streamsContainer: db.container(CONTAINER_WORKFLOW_STREAMS),
      });

      // Start the queue (embedded world in test mode)
      if (queue.start) {
        await queue.start();
      }
    },
  };
}

// Export createWorld as an alias for compatibility with @workflow/world
export { createAzureWorld as createWorld };

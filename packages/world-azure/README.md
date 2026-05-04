# @fantasticfour/world-azure

Azure Cosmos DB + Service Bus World implementation for the @fantasticfour/workflow ecosystem.

## Architecture

| Component | Service | Notes |
|-----------|---------|-------|
| Storage | Azure Cosmos DB (SQL API) | Single-container model with type discriminators |
| Queue | Azure Service Bus | FIFO, deduplication, sessions; embedded world-local in tests |
| Streaming | Cosmos DB polling | Sequence-based chunk ordering with polling for real-time updates |

### Container Strategy

All workflow entities live in a single `workflow_runs` container with `/runId` as the partition key. Documents are distinguished by a `type` discriminator field:

```
workflow_runs (partition key: /runId)
  type: "run"    - workflow run entities
  type: "event"  - event-sourced history
  type: "step"   - step entities
  type: "hook"   - webhook hooks

hooks_by_token (partition key: /token)
  O(1) hook lookup by token

workflow_streams (partition key: /streamId)
  Stream chunks for real-time streaming
```

This minimizes container count (lower cost, simpler management) while maintaining excellent query performance via partition isolation per run.

## Quick Start

```bash
pnpm add @fantasticfour/world-azure
```

```typescript
import { createAzureWorld } from '@fantasticfour/world-azure';

const world = createAzureWorld({
  databaseName: 'my-workflow-db',
  deploymentId: 'my-app-v1',
});

await world.start();
```

## Authentication

### Local Development (Cosmos DB Emulator)

```bash
# Start the Cosmos DB Linux emulator
docker run -p 8081:8081 -p 10251-10254:10251-10254 \
  mcr.microsoft.com/cosmosdb/linux/azure-cosmos-emulator:latest

# Set environment variables
export COSMOS_ENDPOINT=https://localhost:8081
export COSMOS_KEY=C2y6yDjf5/R+ob0N8A7Cgv30VRDJIWEHLM+4QDU5DE2nQ9nDuVTqobD4b8mGGyPMbIZnqyMsEcaGQy67XIw/Jw==
```

### Production (Azure AD / Managed Identity)

```typescript
import { DefaultAzureCredential } from '@azure/identity';
import { CosmosClient } from '@azure/cosmos';
import { createAzureWorld } from '@fantasticfour/world-azure';

const cosmosClient = new CosmosClient({
  endpoint: process.env.COSMOS_ENDPOINT!,
  aadCredentials: new DefaultAzureCredential(),
});

const world = createAzureWorld({ cosmosClient });
await world.start();
```

### Production (Connection String)

```typescript
import { CosmosClient } from '@azure/cosmos';
import { createAzureWorld } from '@fantasticfour/world-azure';

const cosmosClient = new CosmosClient(process.env.COSMOS_CONNECTION_STRING!);
const world = createAzureWorld({ cosmosClient });
await world.start();
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `COSMOS_ENDPOINT` | Cosmos DB endpoint URL | `https://localhost:8081` |
| `COSMOS_KEY` | Cosmos DB account key | Emulator key |
| `COSMOS_DATABASE` | Database name | `workflow` |
| `SERVICE_BUS_CONNECTION_STRING` | Service Bus connection string | (none, uses embedded) |
| `SERVICE_BUS_QUEUE` | Service Bus queue name | `workflow-queue` |
| `WORKFLOW_DEPLOYMENT_ID` | Deployment identifier | `azure-default` |

## Indexing

The `cosmos-indexes.json` file contains the recommended indexing policy with composite indexes for common query patterns:

- `workflowName + createdAt` (run listings filtered by workflow)
- `status + createdAt` (run listings filtered by status)
- `correlationId + createdAt` (event correlation lookups)

Apply via the Azure CLI:

```bash
az cosmosdb sql container update \
  --account-name <account> \
  --database-name workflow \
  --name workflow_runs \
  --resource-group <rg> \
  --idx @cosmos-indexes.json
```

## Cost Estimates

Autoscale 100-1000 RU/s, single region:

| Workload | Monthly Cost |
|----------|-------------|
| Low (100K workflows/month) | $25-50 |
| Medium (1M workflows/month) | $150-300 |
| High (10M workflows/month) | $800-1,500 |

Tips to reduce costs:
- Use autoscale to avoid paying for idle capacity
- Set appropriate TTL on completed runs
- Use `resolveData: 'none'` for list queries to reduce bandwidth
- Monitor RU consumption via Azure Portal metrics

## When to Use This World

**Choose world-azure when:**
- Your infrastructure runs on Azure
- You need Azure AD / Managed Identity integration
- You want a fully managed document database with global distribution
- You need enterprise compliance features (encryption, VNET, private endpoints)

**Consider alternatives when:**
- You need the lowest possible cost (use world-redis or world-postgres-*)
- You want self-hosted with no cloud dependencies (use world-nats-jetstream)
- Your team is on GCP (use world-firestore-tasks)
- Your team is on AWS (use world-postgres-* with RDS)

## Testing

Tests use the Cosmos DB Linux emulator via Testcontainers:

```bash
pnpm test
```

The emulator is large (~2GB) and takes 2-5 minutes to start. Test timeout is set to 120 seconds accordingly. In CI, consider running Azure tests as an optional workflow.

## License

Apache-2.0

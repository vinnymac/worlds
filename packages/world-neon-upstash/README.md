# @fantasticfour/world-neon-upstash

Serverless workflow backend using Neon Postgres for storage and Upstash QStash for HTTP-based queue management. Designed to scale to zero with pay-per-use pricing, perfect for cost-sensitive and variable workloads.

## Why Use This Package

- **Scales to Zero**: Both Neon and Upstash scale down when idle
- **Pay-Per-Use**: Only pay for what you use
- **Multi-Cloud**: No cloud provider lock-in
- **SQL Queryability**: Full Postgres SQL access to workflow data
- **HTTP-Based**: No persistent connections or connection pooling
- **Serverless-Native**: Designed for serverless platforms (Vercel, Netlify, etc.)

Best for side projects, MVPs, variable traffic patterns, and cost-conscious production deployments.

## Installation

```bash
pnpm add @fantasticfour/world-neon-upstash
```

## Prerequisites

- **Neon Database**: Create a serverless Postgres database at [neon.tech](https://neon.tech)
- **Upstash QStash**: Create a QStash account at [upstash.com](https://upstash.com)

## Usage

```typescript
import { createNeonUpstashWorld } from '@fantasticfour/world-neon-upstash';

const world = createNeonUpstashWorld({
  databaseUrl: process.env.NEON_DATABASE_URL!,
  qstash: {
    token: process.env.QSTASH_TOKEN!,
    targetUrl: process.env.QSTASH_TARGET_URL!, // Your API endpoint
  },
  deploymentId: 'production',
});

// Create a workflow run
const run = await world.runs.create({
  runId: ulid(),
  workflowName: 'my-workflow',
  status: 'pending',
  input: ['arg1', 'arg2'],
  deploymentId: 'production',
  executionContext: {},
  createdAt: new Date(),
  updatedAt: new Date(),
});
```

## Architecture

- **Storage**: Neon Serverless Postgres (HTTP-based, scales to zero)
- **Queue**: Upstash QStash (HTTP-based push queue)
- **Streaming**: HTTP polling with chunk storage in Postgres
- **Schema**: Drizzle ORM for type-safe operations
- **IDs**: ULID-based for sortable identifiers

## Queue Setup

QStash uses HTTP push for message delivery:

```typescript
// QStash pushes messages to your endpoint
app.post('/queue/:queueName', async (req, res) => {
  const handler = world.createQueueHandler('__wkf_workflow_', async (message, meta) => {
    // Process workflow step
  });

  return handler(req);
});
```

**QStash Benefits:**
- Push-based (no polling required)
- Built-in retries (3 attempts)
- Deduplication via idempotency
- Serverless-friendly

## Database Schema

Tables managed via Drizzle ORM:

- `workflow_runs` - Workflow execution state
- `workflow_events` - Event history
- `workflow_steps` - Step executions
- `workflow_hooks` - Lifecycle hooks
- `workflow_stream_chunks` - Streaming data

## Streaming Implementation

HTTP polling-based streaming (Neon HTTP driver doesn't support LISTEN/NOTIFY):

- Chunks stored in `workflow_stream_chunks` table
- Client polls for new chunks every 100ms
- EOF flag marks completion
- Trade-off: Polling overhead vs HTTP compatibility

## Cost Estimate

**Neon Postgres:**
- Free tier: 0.5 GB storage, 3 GB-month compute
- Paid: $0.16/compute hour (scales to zero when idle)
- Storage: $0.17/GB-month

**Upstash QStash:**
- Free tier: 100 requests/day
- Paid: $1.00 per million messages

**Estimated Monthly Cost:**
- **Development/Testing**: Free tier sufficient
- **Low usage** (10K workflows/month): $1-5
- **Medium usage** (100K workflows/month): $5-15
- **High usage** (1M workflows/month): $20-40

Far cheaper than provisioned infrastructure at low-to-medium scale.

## Environment Variables

```bash
# Required
export NEON_DATABASE_URL="postgresql://user:pass@host.neon.tech/dbname"
export QSTASH_TOKEN="your-qstash-token"
export QSTASH_TARGET_URL="https://your-app.com/queue"

# Optional
export DEPLOYMENT_ID="production"
```

## When to Choose This Package

**Use world-neon-upstash when:**
- Cost optimization for variable traffic
- Serverless deployment (Vercel, Netlify, Cloudflare Pages)
- Side projects or MVPs
- Multi-cloud strategy desired
- SQL queryability needed

**Consider alternatives when:**
- Sub-100ms latency required → use @fantasticfour/world-cloudflare
- On-prem or VPC deployments → use @fantasticfour/world-postgres-redis
- Pure speed over cost → use @fantasticfour/world-redis-bullmq
- AWS-native stack → use @fantasticfour/world-dynamodb-sqs

## Performance Characteristics

- **Latency**: 50-200ms per operation (HTTP overhead + cold starts)
- **Cold Starts**: ~100ms for Neon, minimal for QStash
- **Throughput**: Suitable for 1-100 workflows/second
- **Scaling**: Automatic, scales to zero when idle

## License

Apache License

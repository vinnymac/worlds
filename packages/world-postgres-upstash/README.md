# @fantasticfour/world-postgres-upstash

Workflow backend using PostgreSQL for storage and Upstash QStash for HTTP-based queue management. Works with any PostgreSQL provider including Neon, Supabase, AWS RDS, Railway, and more.

## Why Use This Package

- **PostgreSQL Flexibility**: Works with any PostgreSQL provider
- **Serverless-Friendly**: HTTP-based queue, no persistent connections
- **Multi-Cloud**: No cloud provider lock-in
- **SQL Queryability**: Full PostgreSQL access to workflow data
- **Provider Choice**: Use Neon for serverless, Supabase for auth integration, AWS RDS for enterprise, etc.

Best for applications that need PostgreSQL flexibility, serverless deployments, or multi-cloud strategies.

## Installation

```bash
pnpm add @fantasticfour/world-postgres-upstash
```

## Prerequisites

- **PostgreSQL Database**: Choose any provider (see supported providers below)
- **Upstash QStash**: Create a QStash account at [upstash.com](https://upstash.com)

## Supported PostgreSQL Providers

This package works with any PostgreSQL database:

### Neon (Serverless PostgreSQL)
```bash
# Scales to zero, pay-per-use
export DATABASE_URL="postgresql://user:pass@ep-xxx.neon.tech/dbname"
```
- **Best for**: Cost optimization, variable traffic, side projects
- **Benefits**: Scales to zero, branching, instant provisioning
- **Pricing**: Free tier available, $0.16/compute hour when active

### Supabase (PostgreSQL + Auth)
```bash
# Includes authentication and realtime
export DATABASE_URL="postgresql://postgres:pass@db.xxx.supabase.co:5432/postgres"
```
- **Best for**: Apps needing auth + database, realtime features
- **Benefits**: Built-in auth, storage, edge functions
- **Pricing**: Free tier available, $25/month pro tier

### AWS RDS (Managed PostgreSQL)
```bash
# Enterprise-grade managed PostgreSQL
export DATABASE_URL="postgresql://user:pass@xxx.rds.amazonaws.com:5432/dbname"
```
- **Best for**: Enterprise deployments, compliance requirements
- **Benefits**: High availability, automated backups, VPC isolation
- **Pricing**: Starts at ~$15/month for small instances

### Railway (Developer-Friendly PostgreSQL)
```bash
# Simple PostgreSQL hosting
export DATABASE_URL="postgresql://user:pass@xxx.railway.app:5432/dbname"
```
- **Best for**: Quick prototyping, developer convenience
- **Benefits**: One-click deploy, automatic migrations, fair pricing
- **Pricing**: $5/month for 8GB storage

### Self-Hosted PostgreSQL
```bash
# Your own PostgreSQL instance
export DATABASE_URL="postgresql://user:pass@your-host:5432/dbname"
```
- **Best for**: Complete control, on-premises requirements
- **Benefits**: Full control, no vendor lock-in, cost predictability

## Usage

```typescript
import { createPostgresUpstashWorld } from '@fantasticfour/world-postgres-upstash';

const world = createPostgresUpstashWorld({
  databaseUrl: process.env.DATABASE_URL!,
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

- **Storage**: PostgreSQL via standard `postgres` driver (wire protocol)
- **Queue**: Upstash QStash (HTTP-based push queue)
- **Streaming**: HTTP polling with chunk storage in PostgreSQL
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

Run migrations to set up the schema:

```bash
pnpm db:push
```

Tables managed via Drizzle ORM:

- `workflow_runs` - Workflow execution state
- `workflow_events` - Event history
- `workflow_steps` - Step executions
- `workflow_hooks` - Lifecycle hooks
- `workflow_stream_chunks` - Streaming data

## Streaming Implementation

HTTP polling-based streaming:

- Chunks stored in `workflow_stream_chunks` table
- Client polls for new chunks every 100ms
- EOF flag marks completion
- Trade-off: Polling overhead vs HTTP compatibility

## Environment Variables

```bash
# Required
export DATABASE_URL="postgresql://user:pass@host/dbname"
export QSTASH_TOKEN="your-qstash-token"
export QSTASH_TARGET_URL="https://your-app.com/queue"

# Optional
export DEPLOYMENT_ID="production"
```

## When to Choose This Package

**Use world-postgres-upstash when:**
- You need PostgreSQL flexibility and provider choice
- Serverless deployment (Vercel, Netlify, Cloudflare Pages)
- Multi-cloud strategy desired
- SQL queryability needed
- HTTP-based queue is acceptable

**Consider alternatives when:**
- Sub-100ms latency required → use @fantasticfour/world-cloudflare
- Need Redis Lists queue → use @fantasticfour/world-postgres-redis
- Pure speed over cost → use @fantasticfour/world-redis-bullmq
- AWS-native stack → use @fantasticfour/world-dynamodb-sqs

## Performance Characteristics

- **Latency**: 20-100ms per operation (varies by provider)
- **Provider Impact**:
  - Serverless providers (Neon): ~100ms cold starts
  - Managed providers (RDS, Supabase): ~20-50ms consistent
  - Self-hosted: Depends on your infrastructure
- **Throughput**: Suitable for 1-100 workflows/second
- **Scaling**: Depends on PostgreSQL provider configuration

## Cost Considerations

Costs vary significantly by provider:

**Neon (Serverless):**
- Free tier: 0.5 GB storage, 3 GB-month compute
- Scales to zero when idle
- Best for: Variable traffic, development

**Supabase:**
- Free tier: 500 MB database, 1 GB file storage
- Pro: $25/month with higher limits
- Best for: Apps needing auth + database

**AWS RDS:**
- Provisioned instances start at ~$15/month
- Reserved instances for discounts
- Best for: Predictable enterprise workloads

**Upstash QStash (constant across all options):**
- Free tier: 100 requests/day
- Paid: $1.00 per million messages

Choose your PostgreSQL provider based on your specific needs, traffic patterns, and budget.

## License

Apache License

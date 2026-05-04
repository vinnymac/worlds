# @fantasticfour/world-mysql-upstash

Workflow backend using MySQL for storage and Upstash QStash for HTTP-based queue management. Works with any MySQL provider including PlanetScale, AWS RDS, Aiven, Railway, and more.

## Why Use This Package

- **MySQL Flexibility**: Works with any MySQL provider
- **Serverless-Friendly**: HTTP-based queue, no persistent connections
- **Multi-Cloud**: No cloud provider lock-in
- **SQL Queryability**: Full MySQL access to workflow data
- **Provider Choice**: Use PlanetScale for serverless, AWS RDS for enterprise, Aiven for managed services, etc.

Best for applications that need MySQL compatibility, serverless deployments, or multi-cloud strategies.

## Installation

```bash
pnpm add @fantasticfour/world-mysql-upstash
```

## Prerequisites

- **MySQL Database**: Choose any provider (see supported providers below)
- **Upstash QStash**: Create a QStash account at [upstash.com](https://upstash.com)

## Supported MySQL Providers

This package works with any MySQL 8.0+ database:

### PlanetScale (Serverless MySQL)
```bash
# Serverless MySQL with branching and automatic scaling
export DATABASE_URL="mysql://user:pass@aws.connect.psdb.cloud/dbname?ssl={\"rejectUnauthorized\":true}"
```
- **Best for**: Serverless deployments, branching workflows, developer velocity
- **Benefits**: Scales to zero, git-like branching, instant schema changes
- **Pricing**: Free tier available, $29/month for production

### AWS RDS (Managed MySQL)
```bash
# Enterprise-grade managed MySQL
export DATABASE_URL="mysql://user:pass@xxx.rds.amazonaws.com:3306/dbname"
```
- **Best for**: Enterprise deployments, compliance requirements
- **Benefits**: High availability, automated backups, VPC isolation
- **Pricing**: Starts at ~$15/month for small instances

### Aiven (Multi-Cloud MySQL)
```bash
# Managed MySQL across AWS, GCP, Azure
export DATABASE_URL="mysql://user:pass@xxx.aivencloud.com:3306/dbname?ssl-mode=REQUIRED"
```
- **Best for**: Multi-cloud deployments, open source stack
- **Benefits**: Choose your cloud, transparent pricing, excellent support
- **Pricing**: Starts at $30/month

### Railway (Developer-Friendly MySQL)
```bash
# Simple MySQL hosting
export DATABASE_URL="mysql://user:pass@xxx.railway.app:3306/dbname"
```
- **Best for**: Quick prototyping, developer convenience
- **Benefits**: One-click deploy, automatic migrations, fair pricing
- **Pricing**: $5/month for 8GB storage

### Self-Hosted MySQL
```bash
# Your own MySQL instance
export DATABASE_URL="mysql://user:pass@your-host:3306/dbname"
```
- **Best for**: Complete control, on-premises requirements
- **Benefits**: Full control, no vendor lock-in, cost predictability

## Usage

```typescript
import { createMysqlUpstashWorld } from '@fantasticfour/world-mysql-upstash';

const world = createMysqlUpstashWorld({
  databaseUrl: process.env.DATABASE_URL!,
  qstash: {
    token: process.env.QSTASH_TOKEN!,
    targetUrl: process.env.QSTASH_TARGET_URL!, // Your API endpoint
  },
  deploymentId: 'production',
});

// Use the world
await world.events.create('run_id', {
  eventType: 'run_created',
  eventData: {
    workflowName: 'my-workflow',
    deploymentId: 'production',
    input: ['arg1', 'arg2'],
  }
});
```

## Architecture

- **Storage**: MySQL via `mysql2` driver (promise-based connection pool)
- **Queue**: Upstash QStash (HTTP-based push queue)
- **Streaming**: Polling-based with sequence numbers (100ms poll interval)
- **Schema**: Drizzle ORM for type-safe operations
- **IDs**: ULID-based for sortable identifiers

## Streaming Implementation

MySQL lacks PostgreSQL's NOTIFY/LISTEN, so we use a polling-based approach:

- Chunks stored in `workflow_stream_chunks` table with sequence numbers
- Client polls for chunks where `sequence > lastSequence`
- Poll interval: 100ms (provides ~200ms p95 latency)
- Trade-off: Acceptable latency for most workflows, HTTP-compatible

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
- `workflow_stream_chunks` - Streaming data with sequence numbers

## Environment Variables

```bash
# Required
export DATABASE_URL="mysql://user:pass@host:3306/dbname"
export QSTASH_TOKEN="your-qstash-token"
export QSTASH_TARGET_URL="https://your-app.com/queue"

# Optional
export DEPLOYMENT_ID="production"
```

## When to Choose This Package

**Use world-mysql-upstash when:**
- You need MySQL compatibility (existing MySQL infrastructure)
- Serverless deployment (Vercel, Netlify, Cloudflare Pages)
- Multi-cloud strategy desired
- SQL queryability with MySQL tooling
- HTTP-based queue is acceptable

**Consider alternatives when:**
- You prefer PostgreSQL → use @fantasticfour/world-postgres-upstash
- Sub-100ms latency required → use @fantasticfour/world-cloudflare
- Need Redis Lists queue → use @fantasticfour/world-postgres-redis
- Pure speed over cost → use @fantasticfour/world-redis-bullmq
- AWS-native stack → use @fantasticfour/world-dynamodb-sqs

## Performance Characteristics

- **Latency**: 20-200ms per operation (varies by provider)
- **Provider Impact**:
  - Serverless providers (PlanetScale): ~100ms cold starts, excellent warm performance
  - Managed providers (RDS, Aiven): ~20-50ms consistent
  - Self-hosted: Depends on your infrastructure
- **Streaming Latency**: ~100-200ms p95 (polling-based)
- **Throughput**: Suitable for 1-100 workflows/second
- **Scaling**: Depends on MySQL provider configuration

## Cost Considerations

Costs vary significantly by provider:

**PlanetScale (Serverless):**
- Free tier: 5 GB storage, 1 billion row reads/month
- Scaler plan: $29/month
- Best for: Variable traffic, development, serverless apps

**AWS RDS:**
- Provisioned instances start at ~$15/month
- Reserved instances for discounts
- Best for: Predictable enterprise workloads

**Aiven:**
- Starts at $30/month
- Transparent pricing, no surprises
- Best for: Multi-cloud, open source preference

**Railway:**
- $5/month for 8GB storage
- Usage-based compute pricing
- Best for: Prototypes, small apps

**Upstash QStash (constant across all options):**
- Free tier: 100 requests/day
- Paid: $1.00 per million messages

Choose your MySQL provider based on your specific needs, traffic patterns, and budget.

## Differences from PostgreSQL World

If you're familiar with `@fantasticfour/world-postgres-upstash`, here are the key differences:

1. **Streaming**: Polling-based (sequence numbers) instead of NOTIFY/LISTEN
2. **Schema Syntax**: MySQL enums, BLOB instead of bytea, explicit VARCHAR lengths
3. **Driver**: `mysql2/promise` instead of `postgres`
4. **No RETURNING**: MySQL doesn't support RETURNING clause, requires separate SELECT queries

The storage logic and queue implementation are otherwise identical.

## License

Apache License

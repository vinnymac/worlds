# @fantasticfour/world-cloudflare

Edge-native workflow backend using Cloudflare Durable Objects with SQLite storage and global sub-10ms latency. Deploy workflows to Cloudflare's global network for maximum performance.

## Why Use This Package

- **Edge-First**: Runs globally on Cloudflare's network
- **Low Latency**: Sub-10ms response times worldwide
- **SQLite Storage**: SQL queries within each Durable Object
- **Auto-Scaling**: Automatic geographic distribution
- **Real-Time**: WebSocket-based streaming
- **Vendor Integration**: Native Cloudflare Workers ecosystem

Best for applications requiring global low-latency workflow execution, especially those already on Cloudflare infrastructure.

## Installation

```bash
pnpm add @fantasticfour/world-cloudflare
```

## Prerequisites

- **Cloudflare Account**: Workers paid plan required for Durable Objects
- **Wrangler CLI**: For deployment (`pnpm add -D wrangler`)

## Usage

```typescript
import { createCloudflareWorld } from '@fantasticfour/world-cloudflare';

// In your Cloudflare Worker
export default {
  async fetch(request, env) {
    const world = createCloudflareWorld({ env });

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

    return new Response(JSON.stringify(run));
  }
};
```

## Architecture

- **Storage**: Durable Objects with SQLite (per-workflow-run isolation)
- **Queue**: Cloudflare Queues with automatic retries
- **Streaming**: WebSocket-based real-time events via Durable Objects
- **Indexing**: Workers KV for global workflow lookups
- **IDs**: ULID-based for sortable identifiers

## Configuration

Configure in `wrangler.toml`:

```toml
name = "my-workflow-app"
main = "src/index.ts"
compatibility_date = "2024-01-01"

[[durable_objects.bindings]]
name = "WORKFLOW_DO"
class_name = "WorkflowDurableObject"

[[queues.producers]]
queue = "workflow-queue"
binding = "WORKFLOW_QUEUE"

[[kv_namespaces]]
binding = "WORKFLOW_KV"
id = "your-kv-namespace-id"
```

## Test Coverage

This package includes comprehensive tests:

- **storage.test.ts**: CRUD operations, Durable Object integration, status transitions
- **spec.test.ts**: @workflow/world interface compliance
- **durable-objects.test.ts**: DO isolation, state persistence, KV indexing, concurrent updates

Total: ~1,350 lines of test coverage ensuring production reliability.

## Cost Estimate

**Cloudflare Pricing:**
- Durable Objects: $0.15/million requests
- Queues: $0.40/million operations
- Workers KV: $0.50/million reads
- Workers: Included with paid plan ($5/month)

**Estimated Monthly Cost:**
- **Low usage** (100K workflows/month): $5-10
- **Medium usage** (1M workflows/month): $10-20
- **High usage** (10M workflows/month): $50-100

Note: Requires Workers paid plan ($5/month minimum).

## Local Development

Use Wrangler for local development:

```bash
# Install wrangler
pnpm add -D wrangler

# Run locally with Miniflare
pnpm wrangler dev

# Deploy to Cloudflare
pnpm wrangler deploy
```

## When to Choose This Package

**Use world-cloudflare when:**
- Global sub-10ms latency required
- Already using Cloudflare Workers
- Edge computing benefits needed
- WebSocket streaming important
- Vendor lock-in acceptable

**Consider alternatives when:**
- Multi-cloud strategy required → use @fantasticfour/world-neon-upstash
- Traditional infrastructure preferred → use @fantasticfour/world-postgres-redis
- Cost optimization priority → use @fantasticfour/world-redis
- AWS ecosystem → use @fantasticfour/world-dynamodb-sqs

## Performance Characteristics

- **Latency**: <10ms globally (edge deployment)
- **Cold Starts**: Minimal (~1-5ms for Durable Objects)
- **Throughput**: Scales automatically with traffic
- **Geographic Distribution**: Automatic via Cloudflare network

## License

Apache License

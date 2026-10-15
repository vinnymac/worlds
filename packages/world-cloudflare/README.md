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

The world talks to its Durable Objects over RPC through the `WORKFLOW_DB` and
`WORKFLOW_STREAMS` bindings, so it cannot register those classes for you: only
your Worker's entrypoint can. Re-export them from your entrypoint or `wrangler
deploy` fails with `Your Worker depends on the following Durable Objects, which
are not exported in your entrypoint file`.

```typescript
import { createCloudflareWorld } from '@fantasticfour/world-cloudflare';

// Required: wrangler binds these to the classes named in wrangler.toml.
export { StreamDO, WorkflowRunDO } from '@fantasticfour/world-cloudflare/worker';

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
  },
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

All four bindings are required, and the binding names are fixed: `createCloudflareWorld`
reads them off `env` by name.

```toml
name = "my-workflow-app"
main = "src/index.ts" # the entrypoint that re-exports StreamDO and WorkflowRunDO
compatibility_date = "2024-11-27"
compatibility_flags = ["nodejs_compat"]

[[durable_objects.bindings]]
name = "WORKFLOW_DB"
class_name = "WorkflowRunDO"

[[durable_objects.bindings]]
name = "WORKFLOW_STREAMS"
class_name = "StreamDO"

# Both classes use DO SQLite storage, so they must be introduced as
# new_sqlite_classes. Without this migration the bindings resolve but every
# storage call fails at runtime.
[[migrations]]
tag = "v1"
new_sqlite_classes = ["WorkflowRunDO", "StreamDO"]

[[queues.producers]]
queue = "workflow-queue"
binding = "WORKFLOW_QUEUE"

[[kv_namespaces]]
binding = "WORKFLOW_INDEX"
id = "your-kv-namespace-id"
```

## Test Coverage

This package includes comprehensive tests:

- **storage.test.ts**: CRUD operations, Durable Object integration, status transitions, and the shared v5 storage suite (slot-numbered events, bump-and-report, lazy step start)
- **spec.test.ts**: the `@workflow/world-testing` conformance suite, run against the in-memory bindings in `src/test-mocks.ts` through `test/conformance/harness.ts`
- **real-workers.test.ts** (`pnpm test:workers`): the same transactions against real Durable Objects in workerd, including concurrent writers racing for one run's slots
- **durable-objects.test.ts**: DO isolation, state persistence, KV indexing, concurrent updates

## Workflow SDK v5

This World implements World spec version 8 (`workflow` 5.2, `@workflow/world` 5.0.x) and declares it with `mintedSpecVersion()`, so `WORKFLOW_SEALED_LOG=0` stamps new runs at 6 instead. Event IDs are slot positions in the run's log, allocated inside the run's Durable Object transaction, so a run's log has no holes and this World never writes a `noop`. Hook token takeover (`capabilities.hookForceClaim`) is not implemented.

Runs created by a 4.x release cannot be replayed by this release. Drain in-flight runs, including any messages still on the retired step queue, before deploying it.

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

- Multi-cloud strategy required -> use @fantasticfour/world-upstash
- Traditional infrastructure preferred -> use @fantasticfour/world-postgres-redis
- Cost optimization priority -> use @fantasticfour/world-redis
- AWS ecosystem -> use @fantasticfour/world-dynamodb-sqs

## Performance Characteristics

- **Latency**: <10ms globally (edge deployment)
- **Cold Starts**: Minimal (~1-5ms for Durable Objects)
- **Throughput**: Scales automatically with traffic
- **Geographic Distribution**: Automatic via Cloudflare network

## License

Apache License

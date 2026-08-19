# @fantasticfour/world-upstash

Serverless World implementation using [Upstash Redis](https://upstash.com/docs/redis) and [QStash](https://upstash.com/docs/qstash) for edge-ready durable workflows.

## Features

- **Serverless-first**: Built for edge runtimes and serverless environments
- **Global distribution**: Upstash Redis provides global replication with sub-millisecond latency
- **HTTP-based queue**: QStash delivers reliable HTTP-based job queuing without persistent connections
- **Zero infrastructure**: No Redis or queue servers to manage
- **Pay-per-use**: Cost-effective pricing model based on actual usage

## Installation

```bash
pnpm add @fantasticfour/world-upstash
```

## Prerequisites

You'll need:

1. **Upstash Redis database** - [Create one for free](https://console.upstash.com/redis)
2. **QStash queue** - [Get your QStash token](https://console.upstash.com/qstash)

## Configuration

Set these environment variables:

```bash
# Upstash Redis (required)
UPSTASH_REDIS_REST_URL=https://your-redis.upstash.io
UPSTASH_REDIS_REST_TOKEN=your-redis-token

# QStash (required)
QSTASH_TOKEN=your-qstash-token
QSTASH_TARGET_URL=https://your-app.com/api/workflow

# Optional
WORKFLOW_REDIS_KEY_PREFIX=workflow:
```

### Retry budget

When a delivery's handler responds with a non-2xx status, QStash redelivers the
message. QStash's own default retry count is small (3 on the free plan), which
is well below the workflow runtime's expectation of up to 48 total deliveries
before a run is marked failed. This world therefore defaults to **47 retries
(48 total deliveries)** so transient failures are not dropped prematurely.

Override it with `qstashRetries` (QStash clamps the value to your plan's
maximum):

```typescript
const world = createWorld({
  qstashRetries: 20,
});
```

## Usage

### Basic Setup

```typescript
import { createWorld } from '@fantasticfour/world-upstash';

const world = createWorld({
  redisUrl: process.env.UPSTASH_REDIS_REST_URL,
  redisToken: process.env.UPSTASH_REDIS_REST_TOKEN,
  qstashToken: process.env.QSTASH_TOKEN,
  qstashTargetUrl: 'https://your-app.com/api/workflow',
  keyPrefix: 'workflow:',
});
```

### With Environment Variables

```typescript
import { createWorld } from '@fantasticfour/world-upstash';

// Uses env vars: UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, QSTASH_TOKEN, QSTASH_TARGET_URL
const world = createWorld();
```

### Vercel Edge Runtime

This world works seamlessly with Vercel Edge Runtime:

```typescript
// app/api/workflow/route.ts
import { createWorld } from '@fantasticfour/world-upstash';
import { WorkflowRegistry } from '@workflow/core';

export const runtime = 'edge';

const world = createWorld();
const registry = new WorkflowRegistry();

export async function POST(request: Request) {
  const { runId } = await request.json();
  // Handle workflow execution
}
```

## Real-time Streaming

This world does not support real-time event streaming via `streamEvents()`. For serverless environments, use polling instead:

```typescript
// Poll for events
const events = await world.events.list({
  runId: 'wrun_...',
  pagination: { limit: 100, sortOrder: 'desc' },
});

// Check run status
const run = await world.runs.get('wrun_...');
```

## QStash Webhook Handler

Your workflow endpoint receives QStash webhook calls:

```typescript
// app/api/workflow/route.ts
export async function POST(request: Request) {
  const { runId } = await request.json();

  // Process workflow run
  const run = await world.runs.get(runId);
  // ... execute workflow logic

  return new Response('OK', { status: 200 });
}
```

## Comparison with Other Worlds

| Feature             | world-upstash     | world-redis-bullmq | world-firestore-tasks       |
| ------------------- | ----------------- | ------------------ | --------------------------- |
| Infrastructure      | None (serverless) | Redis + BullMQ     | GCP Firestore + Cloud Tasks |
| Real-time streaming | No (use polling)  | Yes                | Yes                         |
| Edge runtime        | Yes               | No                 | No                          |
| Global replication  | Yes               | No                 | Yes                         |
| Cost model          | Pay-per-use       | Fixed server costs | Pay-per-use                 |
| Local development   | Limited           | Yes                | Yes (emulators)             |

## Local Development

For local development, we recommend using `@fantasticfour/world-redis-bullmq` or `@workflow/world-local` instead. Upstash is optimized for production serverless environments.

## License

Apache-2.0

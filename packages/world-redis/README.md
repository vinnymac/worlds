# @fantasticfour/world-redis

Pure Redis-based workflow backend using Redis Lists for lightweight queue management. Ideal for simple deployments, development environments, and small to medium-scale production workloads.

## Why Use This Package

- **Minimal Dependencies**: Single Redis instance for both storage and queuing
- **Simple Setup**: No additional queue infrastructure required
- **Cost-Effective**: Pure Redis solution without external services
- **Fast Development**: Quick local setup with Docker
- **Proven Patterns**: Based on @workflow/world-local architecture

Best for applications that need reliable workflow execution without the complexity of advanced queue systems.

## Installation

```bash
pnpm add @fantasticfour/world-redis
```

## Usage

### Environment Variables

```bash
# Required
export WORKFLOW_REDIS_URL="redis://localhost:6379"
export PORT="3000"                               # Port for embedded world HTTP server

# Optional
export WORKFLOW_REDIS_KEY_PREFIX="workflow:"     # Default: 'workflow:'
export WORKFLOW_REDIS_WORKER_CONCURRENCY="10"   # Default: 10
```

### Programmatic Usage

```typescript
import { createWorld } from '@fantasticfour/world-redis';

const world = createWorld({
  redis: 'redis://localhost:6379',
  // or use RedisOptions object:
  // redis: { host: 'localhost', port: 6379, password: 'secret' },

  keyPrefix: 'workflow:',       // optional
  queueConcurrency: 10,          // optional
});

await world.start();
```

## Architecture

- **Storage**: Redis Hashes and Sorted Sets
- **Queue**: Redis Lists (LPUSH/BRPOP pattern)
- **Streaming**: Redis Pub/Sub
- **IDs**: ULID-based for monotonic ordering

## Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `redis` | `string \| RedisOptions` | `redis://localhost:6379` | Redis connection URL or ioredis options |
| `keyPrefix` | `string` | `workflow:` | Prefix for all Redis keys |
| `queueConcurrency` | `number` | `10` | Number of concurrent queue workers |

## Redis Data Structures

**Hashes** - Individual records:
- `workflow:run:{runId}`
- `workflow:step:{runId}:{stepId}`
- `workflow:event:{eventId}`
- `workflow:hook:{hookId}`

**Sorted Sets** - Indexes for queries:
- `workflow:runs:index`
- `workflow:runs:by_name:{workflowName}`
- `workflow:runs:by_status:{status}`
- `workflow:steps:by_run:{runId}`
- `workflow:events:by_run:{runId}`

**Lists** - Job queues:
- `workflow:queue:flows`
- `workflow:queue:steps`

## Local Development

```bash
# Start Redis with Docker
docker run -d -p 6379:6379 redis:7-alpine

# Set environment
export WORKFLOW_REDIS_URL="redis://localhost:6379"
export PORT="3000"

# Run your workflows
```

## When to Choose This Package

**Use world-redis when:**
- You need a simple, single-dependency solution
- Development or small-scale production
- Redis persistence (AOF/RDB) meets your durability needs
- Basic queue functionality is sufficient

**Consider alternatives when:**
- You need advanced queue features (priorities, delays, retries) → use @fantasticfour/world-redis-bullmq
- You need SQL queryability → use @fantasticfour/world-postgres-redis
- You're on serverless platforms → use @fantasticfour/world-postgres-upstash

## License

Apache License

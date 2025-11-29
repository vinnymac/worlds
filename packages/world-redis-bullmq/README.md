# @fantasticfour/world-redis-bullmq

Production-grade Redis workflow backend powered by BullMQ. Uses Redis for storage and BullMQ for advanced job queue management with priorities, delays, retries, and observability.

## Why Use This Package

- **Production-Ready**: Battle-tested BullMQ queue system
- **Advanced Queue Features**: Job priorities, delays, retries, rate limiting
- **Observability**: Built-in queue monitoring and metrics via BullMQ
- **Reliable Processing**: Automatic retries and dead letter queues
- **Scalable Workers**: Horizontal scaling with multiple worker processes

Best for production deployments that require robust job processing, queue management, and operational visibility.

## Installation

```bash
pnpm add @fantasticfour/world-redis-bullmq
```

## Usage

### Environment Variables

```bash
# Required
export WORKFLOW_REDIS_URL="redis://localhost:6379"

# Optional
export WORKFLOW_REDIS_KEY_PREFIX="workflow:"      # Default: 'workflow:'
export WORKFLOW_REDIS_JOB_PREFIX="workflow_"      # Default: 'workflow_'
export WORKFLOW_REDIS_WORKER_CONCURRENCY="10"    # Default: 10
```

### Programmatic Usage

```typescript
import { createWorld } from '@fantasticfour/world-redis-bullmq';

const world = createWorld({
  redis: 'redis://localhost:6379',
  // or use RedisOptions object:
  // redis: { host: 'localhost', port: 6379, password: 'secret' },

  keyPrefix: 'workflow:',       // optional, for storage keys
  jobPrefix: 'workflow_',       // optional, for BullMQ queue names
  queueConcurrency: 10,          // optional, worker concurrency
});

await world.start();
```

## Architecture

- **Storage**: Redis Hashes and Sorted Sets (same as world-redis)
- **Queue**: BullMQ with Redis-backed job processing
- **Streaming**: Redis Pub/Sub
- **IDs**: ULID-based for monotonic ordering

## BullMQ Features

This package provides advanced queue capabilities through BullMQ:

- **Job Priorities**: Process high-priority workflows first
- **Delayed Jobs**: Schedule workflows for future execution
- **Automatic Retries**: Configurable retry logic with exponential backoff
- **Rate Limiting**: Control job processing rate
- **Job Events**: Monitor job lifecycle (completed, failed, progress)
- **Queue Metrics**: Track throughput, latency, and failure rates
- **Worker Management**: Multiple workers with different concurrency settings

## Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `redis` | `string \| RedisOptions` | `redis://localhost:6379` | Redis connection URL or ioredis options |
| `keyPrefix` | `string` | `workflow:` | Prefix for storage keys |
| `jobPrefix` | `string` | `workflow_` | Prefix for BullMQ queue names |
| `queueConcurrency` | `number` | `10` | Number of concurrent queue workers |

## Redis Data Structures

**Storage (same as world-redis):**
- Hashes: `workflow:run:{runId}`, `workflow:step:{runId}:{stepId}`
- Sorted Sets: `workflow:runs:index`, `workflow:runs:by_status:{status}`

**BullMQ Queues:**
- `{jobPrefix}flows` - Workflow invocations
- `{jobPrefix}steps` - Step executions
- Plus BullMQ internal structures for job management

## Monitoring

BullMQ provides built-in monitoring capabilities:

```typescript
import { Queue } from 'bullmq';

// Access queue metrics
const flowQueue = new Queue('workflow_flows', {
  connection: { host: 'localhost', port: 6379 }
});

const counts = await flowQueue.getJobCounts();
console.log(counts); // { waiting, active, completed, failed, delayed }
```

Use tools like:
- **Bull Board**: Web UI for monitoring BullMQ queues
- **BullMQ Metrics**: Prometheus metrics exporter
- **Redis Commander**: View queue data structures

## Local Development

```bash
# Start Redis with Docker
docker run -d -p 6379:6379 redis:7-alpine

# Set environment
export WORKFLOW_REDIS_URL="redis://localhost:6379"

# Run your workflows
```

## When to Choose This Package

**Use world-redis-bullmq when:**
- Production deployments requiring reliability
- You need job priorities, delays, or retries
- Observability and monitoring are important
- Multiple worker processes for horizontal scaling
- Advanced queue features justify the complexity

**Consider alternatives when:**
- You need simplicity over features → use @fantasticfour/world-redis
- You need SQL queryability → use @fantasticfour/world-postgres-redis
- You're on serverless platforms → use @fantasticfour/world-postgres-upstash

## Performance Considerations

- **BullMQ Overhead**: Slightly higher Redis memory usage than pure Lists
- **Worker Scaling**: Add more worker processes to increase throughput
- **Redis Configuration**: Use Redis Sentinel or Cluster for high availability
- **Job Retention**: Configure job retention policies to manage memory

## License

Apache License

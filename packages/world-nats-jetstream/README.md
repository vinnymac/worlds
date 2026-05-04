# @fantasticfour/world-nats-jetstream

NATS JetStream-based World implementation for self-hosted workflow execution with built-in clustering and native streaming capabilities.

## Why NATS JetStream?

NATS JetStream is the **ultimate self-hosted workflow infrastructure**:

- **Single Binary Deployment**: One executable handles storage, queuing, and streaming
- **Trivial Clustering**: Add `--cluster` and `--routes` flags for instant multi-node setup
- **Native Streaming**: Purpose-built streams (no EventEmitter coordination needed)
- **Zero External Dependencies**: No separate Redis, PostgreSQL, or message queue required
- **Exceptional Performance**: 500k-1M msgs/sec, sub-millisecond latency
- **Built-in Observability**: HTTP monitoring endpoint on :8222 (/varz, /connz, /jsz)

## Quick Start

### Installation

```bash
npm install @fantasticfour/world-nats-jetstream
```

### Basic Usage

```typescript
import { createWorld } from '@fantasticfour/world-nats-jetstream';

const world = await createWorld({
  nats: 'nats://localhost:4222',
  keyPrefix: 'workflow_',
  queueConcurrency: 10,
});

await world.start();

// Your workflow is now running on NATS JetStream!
```

### Configuration

```typescript
interface NatsJetStreamWorldConfig {
  // NATS connection URL or connection options
  nats: string | ConnectionOptions;
  
  // Optional prefix for job queue streams (default: 'workflow_')
  jobPrefix?: string;
  
  // Number of concurrent workers (default: 10)
  queueConcurrency?: number;
  
  // Optional key prefix for KV buckets and streams (default: 'workflow_')
  keyPrefix?: string;
}
```

## Self-Hosting Guide

### Single Server (Development)

The simplest possible deployment:

```bash
# Download NATS server (one binary, ~15MB)
curl -L https://github.com/nats-io/nats-server/releases/download/v2.10.0/nats-server-v2.10.0-linux-amd64.zip -o nats-server.zip
unzip nats-server.zip

# Run with JetStream enabled
./nats-server -js -m 8222

# Monitor at http://localhost:8222
```

### Production Cluster (3 Nodes)

**Node 1:**
```bash
nats-server \
  -js \
  --name nats-1 \
  --cluster_name workflow \
  --cluster nats://0.0.0.0:6222 \
  --routes nats://node2:6222,nats://node3:6222 \
  --http_port 8222 \
  --store_dir /data/nats \
  -m 8GB
```

**Node 2:**
```bash
nats-server \
  -js \
  --name nats-2 \
  --cluster_name workflow \
  --cluster nats://0.0.0.0:6222 \
  --routes nats://node1:6222,nats://node3:6222 \
  --http_port 8222 \
  --store_dir /data/nats \
  -m 8GB
```

**Node 3:**
```bash
nats-server \
  -js \
  --name nats-3 \
  --cluster_name workflow \
  --cluster nats://0.0.0.0:6222 \
  --routes nats://node1:6222,nats://node2:6222 \
  --http_port 8222 \
  --store_dir /data/nats \
  -m 8GB
```

**Application Connection:**
```typescript
const world = await createWorld({
  nats: {
    servers: [
      'nats://node1:4222',
      'nats://node2:4222',
      'nats://node3:4222',
    ],
  },
});
```

### Docker Compose (Local Development)

See `examples/docker-compose.yml` for a ready-to-run 3-node cluster:

```bash
docker compose -f examples/docker-compose.yml up
```

Includes:
- 3 NATS servers with JetStream
- Cluster routing configured
- Health monitoring on :8222, :8223, :8224
- Persistent volumes for data

## Architecture

### Storage: JetStream KV Store

Five KV buckets for entity storage:

```
workflow_runs:          WorkflowRun entities (key: runId)
workflow_steps:         Step entities (key: "runId:stepId")
workflow_events:        Event entities (key: eventId)
workflow_hooks:         Hook entities (key: hookId)
workflow_hooks_by_token: Token->hookId mapping
```

**Benefits:**
- Built-in versioning (10 revisions retained)
- Atomic operations
- Watch support for real-time updates
- Automatic compaction

### Queuing: JetStream Work Queues

Two streams for job processing:

```
workflow_flows:  Workflow execution jobs
workflow_steps:  Step execution jobs
```

**Features:**
- Native deduplication via `Nats-Msg-Id` (2-minute window)
- Exactly-once semantics with `AckPolicy.Explicit`
- Automatic retry via `MaxDeliver=3`
- Work queue mode for load balancing
- 7-day retention for job replay

### Streaming: Native JetStream Streams

Per-workflow-stream JetStream streams:

```
Subject: "workflow_stream_{streamId}.data"
Retention: Interest-based (auto-cleanup)
Consumer: Ephemeral for real-time, durable for replay
```

**Advantages over Redis:**
- No EventEmitter coordination needed
- No manual sequence queries
- Built-in replay via `DeliverPolicy.StartSequence`
- Push or pull consumer models
- Automatic cleanup via interest-based retention

## Unique Features

### 1. Time-Travel Debugging

Replay messages from any point in time:

```typescript
// Read workflow stream starting from chunk 10
const stream = await world.readFromStream('my-stream', 10);
```

### 2. Subject-Based Routing

Powerful filtering via NATS subjects:

```typescript
// All workflow jobs
workflow_flows.>

// Specific workflow
workflow_flows.wrun_abc123

// Pattern matching
workflow_flows.wrun_*
```

### 3. Built-in Monitoring

HTTP monitoring endpoint provides real-time metrics:

```bash
# Server stats
curl http://localhost:8222/varz

# Connection info
curl http://localhost:8222/connz

# JetStream stats
curl http://localhost:8222/jsz
```

### 4. Multi-Tenancy

Isolate tenants via key prefixes:

```typescript
// Tenant A
const worldA = await createWorld({
  nats: 'nats://localhost:4222',
  keyPrefix: 'tenant_a_',
});

// Tenant B
const worldB = await createWorld({
  nats: 'nats://localhost:4222',
  keyPrefix: 'tenant_b_',
});
```

## Performance Characteristics

Based on NATS benchmarks and testing:

- **Throughput**: 500,000 - 1,000,000 msgs/sec (single server)
- **Latency**: Sub-millisecond (local network)
- **Storage**: Memory-mapped files (very fast)
- **Clustering**: Linear scalability
- **Memory**: ~100MB base + workload (configurable via `-m` flag)

### Recommended Resource Limits

**Development:**
```bash
nats-server -js -m 512MB
```

**Production (per node):**
```bash
nats-server -js -m 8GB --store_dir /fast/ssd/path
```

## When to Use This World

**Choose NATS JetStream when you need:**
- ✅ Self-hosted infrastructure with minimal operational complexity
- ✅ Built-in clustering without external coordination (etcd, Consul)
- ✅ Exceptional performance (500k+ msgs/sec)
- ✅ Single binary deployment (no Docker required)
- ✅ Native streaming capabilities
- ✅ Zero cloud dependencies

**Consider alternatives if you:**
- ❌ Already use Redis/PostgreSQL and want to minimize infrastructure
- ❌ Need managed cloud service (use Cloudflare, Firestore, or Upstash)
- ❌ Require SQL query capabilities (use PostgreSQL worlds)
- ❌ Have existing NATS expertise bottleneck

## Migration Guide

### From Redis World

Storage is similar (key-value), but NATS provides:
- Built-in versioning (vs manual history)
- Subject-based filtering (vs SCAN)
- Simpler streaming (native vs Pub/Sub + EventEmitter)

### From PostgreSQL Worlds

Trade SQL queries for:
- Faster writes (no relational overhead)
- Simpler deployment (no schema migrations)
- Better scalability (distributed by default)

Note: Listing/filtering is in-memory (fine for most use cases).

## Monitoring and Observability

### Health Checks

```bash
# Server health
curl http://localhost:8222/healthz

# JetStream health
curl http://localhost:8222/jsz
```

### Metrics

NATS exposes Prometheus-compatible metrics:

```bash
# Varz endpoint (JSON)
curl http://localhost:8222/varz

# Convert to Prometheus format with nats-surveyor
nats-surveyor -s nats://localhost:4222
```

### Logging

Enable debug logging:

```bash
nats-server -js -DV
```

Logs include:
- Client connections
- Stream operations
- Consumer activity
- Cluster events

## Troubleshooting

### "no stream matches subject"

Ensure JetStream is enabled:

```bash
nats-server -js
```

### "maximum outstanding bytes exceeded"

Increase memory limit:

```bash
nats-server -js -m 8GB
```

### "duplicate message ID"

Idempotency window is 2 minutes. This is expected for duplicate submissions.

### "consumer not found"

Consumer might have expired due to inactivity (30s threshold). This is normal for ephemeral consumers.

## Contributing

Issues and pull requests welcome at [github.com/vinnymac/worlds](https://github.com/vinnymac/worlds).

## License

Apache-2.0

# FantasticFour Workflow

Various implementations of [Vercel workflow](https://useworkflow.dev/) [Worlds](https://useworkflow.dev/docs/deploying/world)

## Packages

This monorepo contains various packages representing worlds published under the `@fantasticfour` organization:

### [@fantasticfour/world-redis](./packages/world-redis)

Pure Redis-based World implementation using Redis Lists for queue management. Lightweight and simple, ideal for development and smaller-scale deployments.

**Features:**

- Custom Redis Lists queue (LPUSH/BRPOP)
- Minimal dependencies
- CLI setup tool included
- Full Redis Streams support for real-time data

### [@fantasticfour/world-redis-bullmq](./packages/world-redis-bullmq)

Production-grade Redis World implementation using BullMQ for robust job queue management.

**Features:**

- BullMQ for reliable job processing
- Advanced queue features (delayed jobs, priority, etc.)
- Production-ready with persistence
- Recommended for production deployments

### [@fantasticfour/world-postgres-redis](./packages/world-postgres-redis)

Hybrid implementation using PostgreSQL for durable storage and Redis for queue management.

**Features:**

- PostgreSQL storage via Drizzle ORM
- Redis Lists for queue
- Database migrations included
- Best for applications already using Postgres


### [@fantasticfour/world-upstash](./packages/world-upstash)

MySQL storage with Upstash QStash for serverless queue management.

**Features:**

- MySQL storage via Drizzle ORM with CBOR serialization
- Upstash QStash for HTTP-based queuing
- Polling-based streaming (100ms interval)
- Compatible with PlanetScale, AWS RDS, Aiven

### [@fantasticfour/world-azure](./packages/world-azure)

Azure Cosmos DB storage with Service Bus queue management.

**Features:**

- Cosmos DB single-container model with type discriminators
- Azure Service Bus for reliable queuing
- Polling-based streaming (100ms interval)
- Enterprise-ready cloud deployment
- Cost: ~$25-1500/month depending on scale

### [@fantasticfour/world-nats-jetstream](./packages/world-nats-jetstream)

NATS JetStream for self-hosted, distributed workflow execution.

**Features:**

- JetStream KV Store for entity storage
- Native JetStream streams for workflow streaming
- Work queue consumers for job processing
- Single binary deployment, trivial clustering
- Ideal for self-hosted, on-premise deployments

### [@fantasticfour/world-cloudflare](./packages/world-cloudflare)

Cloudflare-native implementation using Durable Objects, D1, and Queues.

**Features:**

- Cloudflare Durable Objects for storage
- Cloudflare Queues for job management
- Edge-native deployment
- Global distribution

### [@fantasticfour/world-firestore-tasks](./packages/world-firestore-tasks)

Google Cloud Firestore with Cloud Tasks for queue management.

**Features:**

- Firestore document storage
- Cloud Tasks for reliable queuing
- Real-time streaming via onSnapshot
- Serverless GCP deployment

## Development

### Prerequisites

- Node.js >= 18
- pnpm >= 9
- Docker (for running tests with testcontainers)

### Setup

```bash
# Install dependencies
pnpm install

# Build all packages
pnpm build

# Run tests
pnpm test

# Type check
pnpm typecheck

# Format code
pnpm format

# Lint code
pnpm lint
```

### Package-specific commands

```bash
# Build a specific package
pnpm --filter @fantasticfour/world-redis build

# Test a specific package
pnpm --filter @fantasticfour/world-redis test

# Run dev mode for a package
pnpm --filter @fantasticfour/world-redis dev
```

## Publishing

This monorepo uses [Changesets](https://github.com/changesets/changesets) for version management.

```bash
# Add a changeset
pnpm changeset

# Version packages
pnpm version

# Publish to npm
pnpm publish-packages
```

## License

Apache-2.0

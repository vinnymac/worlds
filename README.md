# FantasticFour Workflow

Various implementations of [Vercel workflow](https://useworkflow.dev/) [Worlds](https://useworkflow.dev/docs/deploying/world)

## Worlds

This monorepo contains various World implementations published under the `@fantasticfour` organization:

- **[@fantasticfour/world-redis](./packages/world-redis)** — Pure Redis-based World implementation using Redis Lists for lightweight and simple workflow execution.

- **[@fantasticfour/world-redis-bullmq](./packages/world-redis-bullmq)** — Production-grade Redis World implementation using BullMQ for robust job queue management.

- **[@fantasticfour/world-postgres-redis](./packages/world-postgres-redis)** — Hybrid World implementation using PostgreSQL for durable storage with Redis Lists for queue management.

- **[@fantasticfour/world-mysql](./packages/world-mysql)** — World implementation using pure MySQL for storage, queueing, and streaming - no external dependencies (no Redis, no QStash).

- **[@fantasticfour/world-mysql-redis](./packages/world-mysql-redis)** — Hybrid World implementation using MySQL for durable storage with Redis Lists for queue management.

- **[@fantasticfour/world-upstash](./packages/world-upstash)** — Serverless World implementation using Upstash Redis and QStash for edge-ready durable workflows.

- **[@fantasticfour/world-nats-jetstream](./packages/world-nats-jetstream)** — NATS JetStream-based World implementation for self-hosted workflow execution with built-in clustering.

- **[@fantasticfour/world-azure](./packages/world-azure)** — Azure Cosmos DB + Service Bus World implementation with Change Feed streaming.

- **[@fantasticfour/world-cloudflare](./packages/world-cloudflare)** — Cloudflare Durable Objects World implementation with edge-native SQLite storage and global <10ms latency.

- **[@fantasticfour/world-firestore-tasks](./packages/world-firestore-tasks)** — GCP Firestore + Cloud Tasks World implementation with real-time streaming and excellent developer experience.

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

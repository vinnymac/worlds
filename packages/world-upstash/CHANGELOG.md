# @fantasticfour/world-upstash

## 1.1.0

### Minor Changes

- b8e251a: feat(world-upstash): Add serverless Upstash Redis + QStash world implementation

  Implements a pure Upstash world using Upstash Redis for storage and QStash for queueing, optimized for serverless and edge runtimes.

  **Architecture:**

  - Storage: Upstash Redis with REST API and CBOR serialization
  - Queue: Upstash QStash for HTTP-based job delivery
  - Streaming: Polling-based via getStreamChunks() (no real-time streaming)

  **Key Features:**

  - Zero infrastructure management required
  - Global distributed storage with Upstash Redis REST API
  - HTTP-based queue with QStash for reliable job delivery
  - Compatible with edge runtimes (Cloudflare Workers, Vercel Edge, Deno Deploy)
  - Pay-per-use pricing model
  - Replaces removed mysql-upstash and postgres-upstash packages

  **Use Cases:**

  - Serverless environments without persistent infrastructure
  - Edge runtime deployments
  - Pay-per-use cost model preference
  - Global distribution requirements

# @fantasticfour/world-redis

## 1.0.3

### Patch Changes

- d44be4d: Sync with upstream changes from world-postgres such as cbor-x

## 1.0.2

### Patch Changes

- c2b739f: Clean up package dependencies

  - Remove unused `@vercel/queue` dependency from world-cloudflare, world-firestore-tasks, and world-postgres-upstash
  - Move `dotenv` to devDependencies in world-postgres-redis, world-postgres-upstash, world-redis, and world-redis-bullmq (only used in CLI setup tools, not runtime)

  This reduces bundle sizes for consumers.

## 1.0.1

### Patch Changes

- 3899935: Initial release

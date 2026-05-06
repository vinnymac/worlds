---
"@fantasticfour/world-redis-bullmq": patch
"@fantasticfour/world-upstash": patch
"@fantasticfour/world-redis": patch
"@fantasticfour/world-postgres-redis": patch
"@fantasticfour/world-mysql": patch
"@fantasticfour/world-mysql-redis": patch
"@fantasticfour/world-cloudflare": patch
"@fantasticfour/world-firestore-tasks": patch
"@fantasticfour/world-azure": patch
"@fantasticfour/world-nats-jetstream": patch
---

Fix event idempotency bugs and add comprehensive test coverage across all world packages

## Critical Bug Fixes

**BREAKING BUG** - Event-sourced systems must be idempotent. Replaying events (for recovery, debugging, or state reconstruction) should produce the same result. This release fixes critical bugs where duplicate creation events caused entities to become invisible in list queries.

### Affected Packages with Implementation Fixes

- `world-redis-bullmq`: Fixed SETNX-based idempotency bug where duplicate `run_created`, `step_created`, and `hook_created` events skipped index updates and didn't return existing entities
- `world-upstash`: Fixed identical SETNX bug
- `world-redis`: Fixed identical SETNX bug
- `world-postgres-redis`: Fixed Drizzle `.onConflictDoNothing()` bug where duplicate events returned undefined instead of existing entities

### Root Cause

The bug was in the "Always-Add Pattern" implementation:

**Before (Broken)**:
```typescript
const existed = await redis.setnx(stepKey, newStep);
if (existed) {  // Only runs when SETNX returns 1 (newly created)
  await redis.zadd(stepsIndex, score, stepId); // Index update
  step = StepSchema.parse(newStep);
}
// When SETNX returns 0 (exists): NO index, NO entity returned
```

**After (Fixed)**:
```typescript
const wasCreated = await redis.setnx(stepKey, newStep);

// Always add to index (ZADD is idempotent - safe to call repeatedly)
await redis.zadd(stepsIndex, score, stepId);

if (wasCreated === 1) {
  step = StepSchema.parse(newStep);
} else {
  // Event replay: fetch existing entity
  const existingData = await redis.get(stepKey);
  if (existingData) {
    step = StepSchema.parse(existingData);
  }
}
```

## Test Coverage Added

All 10 world packages now have comprehensive idempotency test coverage:

### New Test Suites Created

- `world-mysql/test/storage.test.ts` - New file with idempotency tests
- `world-mysql-redis/test/storage.test.ts` - New file with idempotency tests
- `world-azure/test/storage.test.ts` - New file with mocked Cosmos DB tests
- `world-nats-jetstream/test/storage.test.ts` - New file with NATS container tests

### Expanded Existing Test Suites

- `world-redis-bullmq/test/storage.test.ts` - Added 3 idempotency tests
- `world-upstash/test/storage.test.ts` - Created new test file with full suite
- `world-redis/test/storage.test.ts` - Added 3 idempotency tests (24 tests total now pass)
- `world-postgres-redis/test/storage.test.ts` - Added 3 idempotency tests (48 tests total now pass)
- `world-cloudflare/test/storage.test.ts` - Added 3 idempotency tests (25 tests total now pass)
- `world-firestore-tasks/test/storage.test.ts` - Added 3 idempotency tests (36 tests total now pass)

### Test Pattern

Each package now verifies that:
1. Creating an entity twice returns the existing entity (not undefined/error)
2. Duplicate events don't create duplicate entries
3. Entities always appear in list/index queries after duplicate events

## Impact

**Before**: Event replay (for recovery or debugging) would cause:
- Missing entities in queries
- "Unconsumed event" errors
- Inconsistent state between entity storage and indexes

**After**: Event replay is safe and idempotent across all world packages.

## Migration

No breaking changes. These are pure bug fixes with additional test coverage. All existing functionality preserved.

---
"@fantasticfour/world-redis": major
"@fantasticfour/world-redis-bullmq": major
"@fantasticfour/world-postgres-redis": major
"@fantasticfour/world-postgres-upstash": major
"@fantasticfour/world-firestore-tasks": major
"@fantasticfour/world-cloudflare": major
---

Migrate to @workflow 4.1.0-beta with event-sourced architecture

This is a major update that migrates all 6 world implementations from @workflow 4.0.1-beta to 4.1.0-beta, implementing the new event-sourced architecture and API changes.

## Breaking Changes

### Event-Sourced Architecture
All entity mutations now flow through `events.create()` instead of direct entity methods:
- Removed: `runs.create()`, `runs.update()`, `runs.cancel()`, `runs.pause()`, `runs.resume()`
- Removed: `steps.create()`, `steps.update()`
- Removed: `hooks.create()`, `hooks.dispose()`
- Updated: `events.create()` now accepts `runId: string | null` and returns `EventResult` containing the event plus affected entities

### API Signature Changes
- `Events.create()` return type changed from `Event` to `EventResult`
- `runs.get()` and `runs.list()` now support `resolveData` parameter ('all' | 'none')
- `steps.get()` and `steps.list()` now support `resolveData` parameter ('all' | 'none')

### New Types
- `EventResult` - contains event + affected run/step/hook/wait entities
- `WorkflowRunWithoutData` / `StepWithoutData` - for `resolveData: 'none'`
- `RunCreatedEventRequest` - for creating runs via events

### Dependency Updates
- @workflow/errors: 4.0.1-beta.5 → 4.1.0-beta.20
- @workflow/world: 4.0.1-beta.6 → 4.1.0-beta.17
- @workflow/world-local: 4.0.1-beta.11 → 4.1.0-beta.51
- @workflow/world-testing: 4.0.1-beta.20 → 4.1.0-beta.53
- zod: 4.1.11 → 4.3.6
- ulid: 3.0.1 → 3.0.2
- ioredis: 5.8.2 → 5.10.1
- drizzle-orm: 0.44.7 → 0.45.2
- postgres: 3.4.7 → 3.4.9
- testcontainers: 11.8.1 → 11.14.0

### Schema Changes (PostgreSQL packages)
New columns added to support 4.1.0-beta:
- `runs`: specVersion, expiredAt
- `events`: specVersion
- `steps`: specVersion
- `hooks`: specVersion, isWebhook

**Note**: Database migrations required for PostgreSQL packages. Run `pnpm --filter @fantasticfour/world-postgres-* run setup` to apply schema changes.

### Streamer Interface
Added new required methods:
- `listStreamsByRunId(runId: string): Promise<string[]>`
- `getStreamChunks(name: string, runId: string, options?: GetChunksOptions): Promise<StreamChunksResponse>`
- `getStreamInfo(name: string, runId: string): Promise<StreamInfoResponse>`

## Migration Guide

### Creating a Run
```typescript
// Before (4.0.1-beta)
const run = await world.runs.create({
  deploymentId,
  workflowName,
  input: [serializedInput]
});

// After (4.1.0-beta)
const { run, event } = await world.events.create(null, {
  eventType: 'run_created',
  eventData: { deploymentId, workflowName, input: serializedInput }
});
```

### Updating a Run
```typescript
// Before (4.0.1-beta)
const run = await world.runs.update(runId, {
  status: 'completed',
  output: serializedOutput
});

// After (4.1.0-beta)
const { run, event } = await world.events.create(runId, {
  eventType: 'run_completed',
  eventData: { output: serializedOutput }
});
```

### Creating a Hook
```typescript
// Before (4.0.1-beta)
const hook = await world.hooks.create(runId, {
  hookId,
  token,
  metadata
});

// After (4.1.0-beta)
const { hook, event } = await world.events.create(runId, {
  eventType: 'hook_created',
  correlationId: hookId,
  eventData: { token, metadata }
});
```

## Test Status
- world-redis: 21/21 storage tests passing
- world-redis-bullmq: 21/21 storage tests passing
- world-postgres-redis: TypeScript compiles, requires database migration
- world-postgres-upstash: TypeScript compiles, requires database migration
- world-firestore-tasks: 33/33 storage tests passing
- world-cloudflare: 59/59 storage tests passing

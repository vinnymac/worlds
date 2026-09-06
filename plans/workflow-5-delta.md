# Workflow DevKit v4 -> v5 beta: World contract delta

Research date: 2026-09-05. Compared npm tarballs, extracted under this directory
(`world-4/` vs `world-5/`, `testing-4/` vs `testing-5/`, `local-4/` vs `local-5/`,
`errors-4/` vs `errors-5/`, `utils-4/` vs `utils-5/`). Raw diffs: `world.dts.diff`,
`testing.full.diff`, `local.dts.diff`, `local.js.diff`, `errors.full.diff`,
`utils.full.diff`. Official migration guide saved as `upgrading-to-v5.mdx`
(from vercel/workflow `docs/content/worlds/v5/`), plus `building-a-world-v5.mdx`.

## 1. Dist-tag table (as of 2026-09-05)

| Package                  | latest (4.x) | beta (5.x)    |
| ------------------------ | ------------ | ------------- |
| workflow                 | 4.8.5        | 5.0.0-beta.48 |
| @workflow/world          | 4.5.0        | 5.0.0-beta.33 |
| @workflow/world-local    | 4.4.0        | 5.0.0-beta.42 |
| @workflow/world-postgres | 4.3.5        | 5.0.0-beta.40 |
| @workflow/world-testing  | 4.1.20       | 5.0.0-beta.48 |
| @workflow/errors         | 4.2.1        | 5.0.0-beta.20 |
| @workflow/utils          | 4.1.4        | 5.0.0-beta.10 |
| @workflow/core           | 4.8.5        | 5.0.0-beta.48 |
| @workflow/cli            | 4.3.9        | 5.0.0-beta.48 |

Repo: https://github.com/vercel/workflow (release tags `workflow@5.0.0-beta.N`).
world-testing beta.48 depends on `@workflow/world 5.0.0-beta.33`, `@workflow/core
5.0.0-beta.48`, `@workflow/cli 5.0.0-beta.48`, `workflow 5.0.0-beta.48`, zod ~4.3.6.

## 2. Spec versions

v4 (`world-4/dist/spec-version.js`):

```js
SPEC_VERSION_LEGACY = 1;
SPEC_VERSION_SUPPORTS_EVENT_SOURCING = 2;
SPEC_VERSION_SUPPORTS_CBOR_QUEUE_TRANSPORT = 3;
SPEC_VERSION_CURRENT = 3;
```

v5 (`world-5/dist/spec-version.js`):

```js
SPEC_VERSION_LEGACY = 1;
SPEC_VERSION_SUPPORTS_EVENT_SOURCING = 2;
SPEC_VERSION_SUPPORTS_CBOR_QUEUE_TRANSPORT = 3;
SPEC_VERSION_SUPPORTS_ATTRIBUTES = 4;
SPEC_VERSION_SUPPORTS_COMPRESSION = 5; // zstd/gzip payloads allowed
SPEC_VERSION_SUPPORTS_SLOT_IDENTITY = 6; // slot-numbered event ids
SPEC_VERSION_SUPPORTS_SEALED_LOG = 7; // noop-sealed pre-assigned slots
SPEC_VERSION_CURRENT = 7; // floor the runtime accepts
SPEC_VERSION_MAX_SUPPORTED = 7; // ceiling the runtime reads
```

New exports: `mintedSpecVersion(env?)` (what a World stamps on new runs;
returns sealed-log version unless `WORKFLOW_SEALED_LOG=0`, then slot-identity),
`SEALED_LOG_ENV_VAR = "WORKFLOW_SEALED_LOG"`, `SPEC_VERSION_MAX_SUPPORTED`.
`requiresNewerWorld` now compares against `SPEC_VERSION_MAX_SUPPORTED`.

`World.specVersion` is now REQUIRED (was optional). The runtime checks it against
`[SPEC_VERSION_CURRENT, SPEC_VERSION_MAX_SUPPORTED]` at startup and refuses a
World outside the range. Declare `SPEC_VERSION_CURRENT` (world-local actually
declares `mintedSpecVersion()`), never a literal, and never
`SPEC_VERSION_SUPPORTS_SLOT_IDENTITY` (a literal by another name).

## 3. World interface delta (`interfaces.d.ts`)

### 3.1 World

Before:

```ts
export interface World extends Queue, Storage, Streamer {
  specVersion?: number;
  start(): Promise<void>;
  close?(): Promise<void>;
  clear?(): Promise<void>;
  resolveLatestDeploymentId?(): Promise<string>;
  getEncryptionKeyForRun?(run: WorkflowRun): Promise<Uint8Array | undefined>;
  getEncryptionKeyForRun?(
    runId: string,
    context?: Record<string, unknown>,
  ): Promise<Uint8Array | undefined>;
}
```

After:

```ts
export interface World extends Queue, Streamer, Storage {
  specVersion: number;                                   // now REQUIRED
  analytics?: Analytics;                                 // NEW optional read namespace
  capabilities?: WorldCapabilities;                      // NEW, fail-closed
  getRuntimeDeadline?(): Promise<Date | undefined>;      // NEW: invocation kill time; sizes inline replay budget (default flat 2 min without it)
  start(): Promise<void>;
  close?(): Promise<void>;
  clear?(): Promise<void>;
  resolveLatestDeploymentId?(): Promise<string>;
  getEncryptionKeyForRun?(...): ...;                     // unchanged (2 overloads)
  createRunId?(options?: Readonly<Record<string, unknown>>): string;  // NEW: mint bare run ULID (no wrun_ prefix); may embed metadata (e.g. region)
  getEnvironment?(): string | undefined;                 // NEW: sync, side-effect free; omit for single-tenant worlds
  describeRun?(run: Readonly<Record<string, unknown>>): Record<string, string | null> | null | Promise<...>;  // NEW: CLI/observability display fields; cheap, pure, must not throw
}
```

### 3.2 WorldCapabilities (NEW)

```ts
export interface WorldCapabilities {
  hookRetention?: { active: boolean }; // supports experimental_minRetention on hooks
  maxConcurrency?: boolean; // queue supports maxConcurrency-limited consumption (per-run serialization); declarative only today
  hookResumeDedup?: boolean; // events.create dedups hook_received on (runId, resumeId); ALSO requires events.list to round-trip resumeId
  deploymentAffinity?: boolean; // deployment ids are atomic/immutable; enables misroute guard + DEPLOYMENT_MISMATCH. Leave unset for synthetic ids like dpl_local@<version>
}
```

Every capability defaults to unsupported; only declare what is truly enforced
(advertising an unenforced capability removes a runtime guard).
Note: v5 briefly had a `preconditionGuard` capability; it is GONE from the final
contract. Our 4.x `stateUpdatedAt` 412 guard has no replacement and should be
deleted (see 3.5: bump-and-report replaces rejection).

### 3.3 Streamer: methods moved into a `streams` namespace, runId first

Before (methods flat on World):

```ts
export interface Streamer {
  streamFlushIntervalMs?: number; // default was 10ms
  writeToStream(name: string, runId: string, chunk: string | Uint8Array): Promise<void>;
  writeToStreamMulti?(name: string, runId: string, chunks: (string | Uint8Array)[]): Promise<void>;
  closeStream(name: string, runId: string): Promise<void>;
  readFromStream(name: string, startIndex?: number): Promise<ReadableStream<Uint8Array>>;
  listStreamsByRunId(runId: string): Promise<string[]>;
  getStreamChunks(
    name: string,
    runId: string,
    options?: GetChunksOptions,
  ): Promise<StreamChunksResponse>;
  getStreamInfo(name: string, runId: string): Promise<StreamInfoResponse>;
}
```

After (namespace object, runId is ALWAYS the first parameter):

```ts
export interface Streamer {
  streamFlushIntervalMs?: number; // default is now 0 (first chunk flushes immediately); WORKFLOW_STREAM_FLUSH_INTERVAL_MS env overrides
  streams: {
    write(runId: string, name: string, chunk: string | Uint8Array): Promise<void>;
    writeMulti?(runId: string, name: string, chunks: (string | Uint8Array)[]): Promise<void>;
    close(runId: string, name: string): Promise<void>;
    get(runId: string, name: string, startIndex?: number): Promise<ReadableStream<Uint8Array>>; // note: now takes runId (v4 readFromStream did not)
    list(runId: string): Promise<string[]>;
    getChunks(
      runId: string,
      name: string,
      options?: GetChunksOptions,
    ): Promise<StreamChunksResponse>;
    getInfo(runId: string, name: string): Promise<StreamInfoResponse>;
  };
}
```

Rename map: writeToStream -> streams.write, writeToStreamMulti -> streams.writeMulti,
closeStream -> streams.close, readFromStream -> streams.get,
listStreamsByRunId -> streams.list, getStreamChunks -> streams.getChunks,
getStreamInfo -> streams.getInfo. Argument order flips to (runId, name, ...).

### 3.4 Storage.runs

- `create`, `get`, `list` overloads unchanged in shape; `list` doc-deprecates
  observability use in favor of `analytics.runs.list`.
- NEW optional `waitForTerminalStatus?`: long poll returning the same entity as
  `get`; resolves when the run is terminal or roughly at `params.timeoutMs`
  (upper bound; may resolve early with a non-terminal snapshot; timeout is a
  normal return, not an error; missing run throws WorkflowRunNotFoundError):

```ts
waitForTerminalStatus?: {
  (id: string, params: WaitForTerminalRunStatusParams & { resolveData: 'none' }): Promise<WorkflowRunWithoutData>;
  (id: string, params?: WaitForTerminalRunStatusParams & { resolveData?: 'all' }): Promise<WorkflowRun>;
  (id: string, params?: WaitForTerminalRunStatusParams): Promise<WorkflowRun | WorkflowRunWithoutData>;
};
// WaitForTerminalRunStatusParams extends GetWorkflowRunParams { timeoutMs?: number; signal?: AbortSignal }
```

- NEW optional `getMany?`: batch snapshot, input order preserved, `null` for
  missing ids (same three resolveData overloads).
- NEW optional `experimentalSetAttributes?(runId, changes: AttributeChange[], options?: { allowReservedAttributes?: boolean }): Promise<ExperimentalSetAttributesResult>`.
  Stopgap until `attr_set` dispatches through events.create; SDK no-ops with a
  warning if absent. Without it `setAttributes()` is unavailable (and the
  lineage conformance tests fail, see section 7).
- NEW optional `cancelMany?(request: BulkCancelWorkflowRunsRequest): Promise<BulkCancelWorkflowRunsResult>`.
  Up to `BULK_CANCEL_MAX_RUN_IDS = 500` unique ids, `cancelReason` <= 512 chars,
  per-run outcome union: `cancelled | already_cancelled | not_cancellable (status) | not_found | failed (code, retryable)` plus summary counts.

### 3.5 Storage.events (the big one)

Doc contract on the namespace itself: the World allocates every event id, and
every id IS a slot: `evnt_` + dense 1-based position zero-padded to 26 chars.
Not a capability; the runtime calls `requireEventSlot` on every id it loads and
fails the run (`Event id is not slot-numbered` / `CORRUPTED_EVENT_LOG`) if an id
does not decode.

Four binding rules (from upgrading-to-v5.mdx):

1. Uniqueness: settle slot races in the STORE (unique constraint on
   `(runId, eventId)` or conditional write), never read-max-plus-one in process.
2. Density: positions run from 1 with no holes; a losing writer re-derives its
   position from the store.
3. Bump and report: `CreateEventParams.eventCount` states the writer's snapshot;
   expected slot is `eventCount + 1`. If taken, DO NOT reject: commit at the next
   free slot and return the skipped events on the success response
   (`EventResult.events`/`cursor`/`hasMore`). A stale count is the normal case
   for a parallel fan-out.
4. Allocate at the commit: take the position in the same operation that appends
   the event, so a reader's log is always a strict prefix (no holes behind a
   reader). Only a World that pre-assigns positions needs sealed-log `noop`
   sealing (spec 7 reader contract) or `PreconditionFailedError`.

Signatures:

```ts
// v4
create(runId: string | null, data: RunCreatedEventRequest, params?: CreateEventParams): Promise<EventResult>;
create(runId: string, data: CreateEventRequest, params?: CreateEventParams): Promise<EventResult>;
// v5 (generic over event type)
create<T extends RunCreatedEventRequest>(runId: string | null, data: T, params?: CreateEventParams): Promise<EventResult<T['eventType']>>;
create<T extends CreateEventRequest>(runId: string, data: T, params?: CreateEventParams): Promise<EventResult<T['eventType']>>;
// v5 NEW optional batch (presence IS the capability declaration; world-local does NOT implement it)
createBatch?(runId: string, events: BatchEventRequest[], params?: CreateEventBatchParams): Promise<EventBatchResult>;
get(runId, eventId, params?): Promise<Event>;                       // unchanged
list(params: ListEventsParams): Promise<PaginatedResponse<Event>>;  // unchanged; "omit limit to return every remaining event"
listByCorrelationId(params): Promise<PaginatedResponse<Event>>;     // params.runId is now REQUIRED (was optional)
```

`createBatch` contract: events land in request order at consecutive slots;
atomic per attempt (lost race leaves nothing); per-event outcomes index-aligned
(`BatchEventItemResult = { status: 200, event, run?, step?, wait? } | { status, error, message }`);
mixed 200/409 allowed; NOT expressible in a batch: `run_created`, `run_started`,
`run_cancelled`, `hook_created`, `hook_disposed`, `attr_set`; the one legal
multi-event-per-entity combo is `step_created` + `step_started` for the same
step (born-running; input rides step_created).

### 3.6 CreateEventParams delta

Removed: `stateUpdatedAt?: number` (the 4.x optimistic-concurrency 412 guard;
delete our marker plumbing).

Kept: `v1Compat?`, `resolveData?`, `requestId?`, `occurredAt?`.

New fields:

```ts
resumeId?: string;                 // lazy hook resume idempotency key (hook_received only)
resumePayloadDigest?: string;      // content digest paired with resumeId
viaStepDispatch?: boolean;         // advisory: queue consumer re-ensure of a resilient step_created
computeInstanceId?: string;        // ambient per-event compute identity (analytics)
eventCount?: number;               // writer's loaded-log size; drives bump-and-report (replaces stateUpdatedAt)
replayDivergenceCount?: number;    // telemetry only; must not affect materialization or persist
sinceCursor?: string;              // inline-delta opt-in: MAY return events after this cursor on the EventResult (step-terminal + hook-create writes); a World answering on hook_created MUST answer on hook_conflict too
skipPreload?: true;                // run_started only: skip the events preload (turbo write barrier)
preloadEvents?: true;              // hook_received only: return the COMPLETE replay log + run + maxEvents with the create (strict conditions, else return normal result)
replayEventObserver?: (event: Event) => void;  // sync observer of streamed replay-log responses; must be idempotent; throwing aborts
```

### 3.7 EventResult delta

v4: plain interface `{ event?, run?, step?, hook?, wait?, events?, cursor?, hasMore?, maxEvents? }`.

v5: generic `EventResult<T extends EventType = EventType>` =
base `{ event?, run?, step?, hook?, wait?, stepCreated?: true, maxEvents? }`
AND an all-or-nothing events group
`{ events: Event[]; cursor: string | null; hasMore: boolean } | { events?: undefined; cursor?: undefined; hasMore?: undefined }`
AND typed entity guarantees:
`T = 'run_created' -> { run: WorkflowRun }`,
`T = 'run_started' -> { run: StartedWorkflowRun }` (startedAt: Date materialized),
`T = 'step_started' -> { step: StartedStep }`.

`stepCreated: true` is new: set only when a lazy `step_started` carrying
step-creation data atomically created the step (caller won the create claim);
it is the exactly-once inline-execution ownership signal.

`events` now has five producers: run_started preload, step-terminal delta via
sinceCursor, hook-create delta via sinceCursor, hook_received preload via
preloadEvents, and the bump-and-report skipped-slot report.

### 3.8 Storage.steps

`get(runId: string | undefined, stepId, ...)` -> `get(runId: string, stepId, ...)`:
runId is now required on all three overloads. `list` unchanged.
`UpdateStepRequest.error` changed type: `StructuredError` -> `SerializedData`.
New type `StartedStep = Step & { startedAt: Date }`.
StepSchema `error` field: structured `{message, stack?, code?}` object -> serialized data union (opaque).

### 3.9 Storage.hooks

Signatures unchanged (`get`, `getByToken`, `list`) but semantics changed:
hooks kept by minimum retention remain READABLE after their run ends (all three
methods must return them) but cannot be resumed. v4 auto-disposed hooks at run
terminal state; v5: worlds normally remove them, but a hook with
`tokenRetentionUntil` keeps its token unavailable until retention ends;
`hook_disposed` always removes immediately.

## 4. Events model delta (`events.d.ts`)

### 4.1 EventType enum

Added: `noop` (sealed-log filler, spec 7) and `attr_set`. Full v5 set:
`noop, run_created, run_started, run_completed, run_failed, run_cancelled,
attr_set, step_created, step_completed, step_failed, step_retrying,
step_started, hook_created, hook_received, hook_disposed, hook_conflict,
wait_created, wait_completed`.

### 4.2 New classification exports

- `RunEventTypeSchema` / `RunEventType` / `RUN_EVENT_TYPES` / `isRunEventType`
- `StepEventTypeSchema` / `STEP_EVENT_TYPES` / `isStepEventType`
- `TerminalStepEventTypeSchema` / `TERMINAL_STEP_EVENT_TYPES` / `isTerminalStepEventType` (step_completed, step_failed)
- `HookLifecycleEventTypeSchema` / `HOOK_LIFECYCLE_EVENT_TYPES` / `isHookLifecycleEventType`
- `HookEventRequiringExistenceTypeSchema` / `HOOK_EVENTS_REQUIRING_EXISTENCE` / `isHookEventRequiringExistence` (hook_received, hook_disposed)
- `WaitEventTypeSchema` / `WAIT_EVENT_TYPES` / `isWaitEventType`
- `ChildEntityCreationEventTypeSchema` / `CHILD_ENTITY_CREATION_EVENT_TYPES` / `isChildEntityCreationEventType` (step_created, hook_created, wait_created)
- `isChildEntityCreationEvent(event)` also matches lazy `step_started` requests carrying `{ stepName, input }`
- From new `event-metadata.d.ts` (re-exported): `isSealedNoopEvent`,
  `entityEventClass`, `classifyEntityEvent`, `EntityEventClass`,
  `TERMINAL_EVENT_CLASSES`, `RUN_ENTITY_KEY`,
  `getEventDataRefFields(eventType)`, `getEventDataPayloadField(eventType)`.
- REMOVED export: `EVENT_DATA_REF_FIELDS` constant (replaced by
  `getEventDataRefFields`; ref-field map now: run_created/run_started -> input,
  run_completed -> output, run_failed -> error, step_created/step_started -> input,
  step_completed -> result, step_failed/step_retrying -> error,
  hook_created -> metadata, hook_received -> payload). `stripEventDataRefs` kept.
- New helper types: `EventOfType<T>`, `EventRequestOfType<T>`,
  `HookCreatedEventRequest`.

### 4.3 Event schema field changes

- Envelope: new optional `resumeId` (top-level, must round-trip through
  events.list when hookResumeDedup declared).
- `run_created` / `run_started`.eventData: new optional `attributes:
Record<string,string>`, `allowReservedAttributes: true`, `encryptionPublicKey: string`.
- `run_failed`.eventData: `error` was `z.any()`, now serialized-data union;
  `errorCode?` kept.
- `run_cancelled`: now has optional eventData `{ cancelReason?: string }` (v4 had none).
- NEW `attr_set` event: eventData `{ changes: {key, value: string|null}[],
writer: { type: 'workflow' } | { type: 'step', stepId, attempt }, allowReservedAttributes?: true }`.
- `step_completed` / `step_failed`.eventData: new optional telemetry numbers
  `ttfs, stso, stepCount, eventCount, rsfs, finalSchedulingReplay` and
  `optimizations?: string[]`; `error` -> serialized union; `stack` field REMOVED
  (folded into serialized error).
- `step_retrying`.eventData: `error` -> serialized union, `stack` removed,
  `retryAfter` kept.
- `step_started`.eventData: new optional `input` (serialized union) and
  `ownerMessageId` (lazy step start: creates the step on demand; ownerMessageId
  is the inline-ownership liveness lease keyed to queue messageId).
- `hook_created` / `hook_received`.eventData: new optional `tokenRetentionUntil`
  (date) and `isSystem` (boolean).
- NEW `noop` event: optional loose eventData `{ sealed?: boolean }`.
- `ListEventsByCorrelationIdParams.runId`: optional -> REQUIRED.

### 4.4 Batch types (NEW)

```ts
interface BatchEventRequest { event: CreateEventRequest; occurredAt?: Date; computeInstanceId?: string }
interface CreateEventBatchParams { resolveData?: ResolveData; requestId?: string }
type BatchEventItemResult = { status: 200; error?: undefined; message?: undefined; event: Event; run?; step?; wait? }
                          | { status: number; error: string; message: string; event?: undefined; ... };
interface EventBatchResult { results: BatchEventItemResult[] }
```

Under slot identity `BatchEventRequest.occurredAt` is the source of the durable
event's `createdAt` (a slot id carries no time).

## 5. Slot identity module (NEW `slot-identity.d.ts`)

```ts
EVENT_ID_BODY_LENGTH = 26
FIRST_EVENT_SLOT = 1
MAX_EVENT_SLOT: number
EVENT_ID_PREFIX = "evnt_"
isSlotBody(body: string): boolean
isSlotEventId(eventId: string): boolean
slotToEventId(slot: number): string          // canonical zero-padded format
eventIdToSlot(eventId: string): number | null
requireEventSlot(eventId: string): number    // throws; the runtime calls this on every loaded id
```

`ulidToDate` now returns null for slot ids (they parse as ULIDs with epoch
time); callers fall back to `createdAt`. New: `workflowRunIdSchema`
(`wrun_${ULID}` template literal) + `WorkflowRunId` type.

## 6. Queue delta (`queue.d.ts`)

- `QueueKind`: `'workflow' | 'step'` -> `'workflow'` only. Step queue topics are
  RETIRED: queued steps travel on the workflow topic with `stepId`/`stepName` in
  the payload and execute in the combined flow handler. Drop `__wkf_step_*`
  provisioning.
- REMOVED: `getQueuePrefixKind`, `StepInvokePayloadSchema`, `StepInvokePayload`.
- `parseQueueName` no longer returns `kind`: `{ prefix, id }`.
- `WorkflowInvokePayloadSchema` new fields: `preconditionReinvocations?`,
  `deploymentMismatchRetryCount?`, `waitContinuation?` (zod-catch optional
  `{ correlationId, attempt }`; waits are now ordinary queue continuations with
  `delaySeconds`, the `{timeoutSeconds}` wait-return contract is gone),
  `stepId?`, `stepName?`, `hookInput?` (HookResumeInput: `{ resumeId, hookId,
token, payload, payloadDigest, deploymentId? }`), `stepInput?`
  (`{ input: Uint8Array }`, resilient step dispatch re-ensure), and
  `hookResumeTiming?` (advisory TTR telemetry `{ resumeRequestedAtMs,
queuePublishRequestedAtMs, strategy?, consumerStartedAtMs?,
replayStartedAtMs?, nextStepEncounteredAtMs?, setupSource? }`).
  `runInput` gains `attributes?`, `allowReservedAttributes?`, `environment?`.
- `QueuePayloadSchema` union: health check member now FIRST (ordering matters:
  probe carries optional runId and would be swallowed by the invoke member),
  and the step-invoke member is gone. `HealthCheckPayloadSchema` gains
  `runId?`.
- `QueueOptions`: new `region?: string` routing hint (ignore if no regional
  dimension).
- `Queue` interface: new optional
  `isDeploymentUnavailableError?(error: unknown): boolean` (return true only
  when the targeted deployment definitively cannot receive the message).
- `createQueueHandler` contract note: `meta.messageId` SHOULD be stable across
  redeliveries of one message. It is used as the inline-step ownership liveness
  lease (`ownerMessageId`); a queue minting fresh ids per delivery degrades to
  the delayed-backstop recovery path (slower recovery, still correct).
- A suspension now dispatches its waits and steps as ONE parallel batch; a
  queue that assumed one message per suspension must handle the fan-out.

## 7. Runs / hooks / shared schema deltas

### runs.d.ts

- `WorkflowRunSchema.error`: structured `{message, stack?, code?}` ->
  serialized-data union; new top-level `errorCode?: string`.
- New fields on every run variant: `attributes: Record<string,string>`
  (zod default `{}`), `encryptionPublicKey?: string`.
- `completed` variant: `output` is now OPTIONAL (was required).
- `failed` variant: `error` is now OPTIONAL serialized union (was required
  structured object).
- New `StartedWorkflowRun = WorkflowRun & { startedAt: Date }`.
- `CreateWorkflowRunRequest`: new `attributes?: Record<string,string>`.
- New `WaitForTerminalRunStatusParams { timeoutMs?, signal? }`.
- New bulk-cancel schemas/consts (see 3.4): `BULK_CANCEL_MAX_RUN_IDS`,
  `BulkCancelWorkflowRunsRequestSchema`, `BulkCancelWorkflowRunResultSchema`,
  `BulkCancelWorkflowRunsResultSchema`.

### hooks.d.ts

- `Hook` type is now purely `z.infer<typeof HookSchema>` (v4 added a manual
  intersection; gone).
- HookSchema new fields: `isSystem?: boolean`, `tokenRetentionUntil?: Date`,
  `resumeContext?: HookResumeContext`, `resumeCapabilities?: HookResumeCapabilities`.
- NEW `HookResumeContextSchema` `{ deploymentId, workflowName, runSpecVersion?,
workflowCoreVersion?, traceCarrier?, encryptionPublicKey?,
hookResumeInputVersion? }` (immutable slice of the owning run persisted on
  the hook so resume can skip runs.get).
- NEW constants `HOOK_RESUME_INPUT_VERSION = 1`, `HOOK_RESUME_DEDUP_VERSION = 1`,
  `HookResumeCapabilitiesSchema { hookResumeDedupVersion: number }`
  (response-only, computed fresh per by-token lookup; the per-lookup alternative
  to the static hookResumeDedup capability).

### shared.d.ts

- `PaginatedResponseSchema` gains optional `pageInfo` (`PageInfoSchema`:
  `{ currentLookbackDays, maxLookbackDays, currentWindowStart, maxWindowStart,
upgradeAvailable }`, plan-aware lookback metadata).

### attributes.d.ts (NEW)

`AttributeKeySchema`, `AttributeValueSchema` (string|null),
`AttributeChangeSchema`, `AttributeChangesSchema`, `AttributeValidationError`,
`applyAttributeChanges`, `validateAttributeChanges`,
`ATTRIBUTE_KEY_MAX_LENGTH`, `ATTRIBUTE_MAX_PER_RUN`, `ATTRIBUTE_VALUE_MAX_BYTES`,
`RESERVED_ATTRIBUTE_KEY_PREFIX` (`$`), `PARENT_RUN_ID_ATTRIBUTE` (`$parentRunId`),
`ROOT_RUN_ID_ATTRIBUTE` (`$rootRunId`), `ExperimentalSetAttributesResult`.

### analytics.d.ts (NEW, all optional via `world.analytics`)

Metadata-only read namespace: `Analytics` with `runs.get/list`,
`attributes.list`, `steps.get/list`, `events.get/getMany/list/listByCorrelationId`,
`hooks.get/list`, `waits.get/list`; schemas `AnalyticsRunSchema` etc.; limits
`ANALYTICS_EVENTS_GET_MANY_LIMIT = 100`, `ANALYTICS_RUN_SCOPED_PAGE_LIMIT = 1000`,
`ANALYTICS_PAGE_LIMIT = 100`, `ANALYTICS_MAX_ATTRIBUTE_FILTERS = 8`.

## 8. @workflow/world-testing delta (4.1.20 -> 5.0.0-beta.48)

- `createTestSuite(pkgName: string): void` signature UNCHANGED (still no
  world-injection seam; resolves the world via `WORKFLOW_TARGET_WORLD` env in
  its spawned server).
- New test modules registered: `event-ids`, `lineage`, `inline-execution`,
  `inline-batches-debug` (debug reporter), alongside existing addition, errors,
  event-limit, hooks, idempotency, jsonlines, null-byte.
- `event-ids` ("numbers events by position") is the slot-identity conformance
  test: runs an addition workflow, then asserts
  (a) `run.specVersion >= mintedSpecVersion()` and `<= SPEC_VERSION_MAX_SUPPORTED`,
  (b) every eventId decodes via `eventIdToSlot` (no nulls),
  (c) slots are exactly `FIRST_EVENT_SLOT + index` in returned order (dense from 1),
  (d) ids equal canonical `slotToEventId(slot)` (exact zero-pad width).
- `lineage` asserts child runs spawned from a workflow body carry
  `attributes.$parentRunId` / `$rootRunId` (three-level chain shares one root).
  Requires attributes support end to end (runs.attributes + start plumbing).
- `inline-execution` asserts flow invocation counts: sequential steps complete
  in ONE flow invocation (with and without streams, with AbortSignal), sleep
  workflow takes exactly 2, parallel Promise.all takes 1-3. This exercises
  inline step execution (stepCreated ownership signal, stable messageId lease,
  sinceCursor deltas) and will punish worlds that force a queue round trip per
  step.
- Harness additions in `util.mts`: `getEvents(runId)` (every event oldest first
  with ids) and `getFlowInvocationCount(runId)`; server exposes
  `/_flow-invocations/:runId` and counts POSTs to the combined
  `/.well-known/workflow/v1/flow` endpoint (the `/step` endpoint is GONE;
  bundles are now `flow.mjs` / `webhook.mjs` ESM).
- Run shape assertions now include `attributes`, `errorCode?`,
  `encryptionPublicKey?`; failed-run `error` is `unknown` (serialized) instead
  of `{message, stack?, code?}`; completed `output` optional.

## 9. How @workflow/world-local adapted (4.4.0 -> 5.0.0-beta.42)

Change weight (diff lines): events-storage.js 1866, streamer.js 738,
helpers.js 434, fs.js 233, queue.js 199, hooks-storage.js 196,
runs-storage.js 140. New modules: `storage/run-status-signal.js`,
`storage/hook-index.js`, `build-target-mismatch.js`.

- Factory RENAMED: `createLocalWorld()` -> `createWorld()` (v5 injects worlds
  into host bundles at build time; every world package must export
  `createWorld`).
- World assembly:
  `specVersion: mintedSpecVersion()`,
  `capabilities: { hookRetention: { active: true }, hookResumeDedup: true }`,
  streams built as `instrumentObject('world.streams', { ...createStreamer(...) })`.
  Does NOT implement `createBatch`, `analytics`, `cancelMany`,
  `deploymentAffinity` (synthetic dpl_local@version id), or `maxConcurrency`.
  DOES implement `waitForTerminalStatus` (in-process emitter
  `run-status-signal` + cross-process poll backstop
  `WORKFLOW_LOCAL_RUN_STATUS_POLL_INTERVAL_MS`), `getMany`, and
  `experimentalSetAttributes`.
- Slot identity in events-storage: slot chosen as
  `max(state.published + 1, FIRST_EVENT_SLOT, atLeast)`; event files named
  `${runId}-${slotToEventId(slot)}`; exclusive-publish arbitration where the
  loser BUMPS to the next slot and retries, with carve-outs where bumping is
  forbidden (hook resume convergence: two writers must converge on ONE event,
  so the resume path answers the `(runId, resumeId)` sidecar claim before any
  bump; `claimHookResume` filesystem claim). `reportSkippedSlots(result,
eventCount, resolveData)` implements the report half when the committed slot
  exceeds `eventCount + 1`.
- Streamer: interface renames applied at the object level (write/writeMulti/
  close/get/list/getChunks/getInfo with runId first); chunk files moved from a
  flat dir to per-stream dirs `streams/chunks/<streamName>/<chunkId>.{tag}.bin`
  (old flat-layout chunks are not read back; local 4.x state can be deleted);
  monotonic chunk ULID factory moved into a `globalSingleton` (survives
  multiple module instances in a bundled host).
- Hooks: new persistent token index and by-run markers (`hook-index.js`) with
  one-time backfill; retention (`tokenRetentionUntil`) honored via
  `getHookRetentionLimitMs`, releasability checks
  (`isHookTokenClaimReleasable`).
- Queue: single workflow topic; new undici/node-http agent tuning
  (`DEFAULT_HEADERS_TIMEOUT_MS = 30000`, `DEFAULT_BODY_TIMEOUT_MS = 30000`,
  `getQueueAgentOptions()` with `connections: 1000`, `keepAliveTimeout: 30000`).
- New export `UnwritableDataDirError` (build-target mismatch guard, warns when
  running inside a Vercel deployment).

## 10. @workflow/errors delta (4.2.1 -> 5.0.0-beta.20)

New error classes (all with `static is()`):

- `WorkflowBuildError extends WorkflowError` `{ readonly hint?: string }`,
  ctor `(message, options?: WorkflowBuildErrorOptions)`.
- `SerializationError extends WorkflowError` `{ readonly hint?: string;
readonly fatal = true }` (deterministic, skips step retry; recognized by
  `FatalError.is`).
- `WorkflowDeploymentMismatchError extends WorkflowRuntimeError`
  `(runId, expectedDeploymentId, actualDeploymentId, options?: {
recoveryAttempts?, cause? })` with readonly fields incl. `recoveryAttempts`.
- `StreamError extends WorkflowWorldError` `(message, options?: { cause?,
url?, status? })`.
- `StreamExpiredError extends WorkflowWorldError` `(message, runId?, streamId?,
expiredAt?)`.

New error codes: `STREAM_ERROR`, `DEPLOYMENT_MISMATCH`.
`ReplayDivergenceError` signature unchanged (implementation/formatting only).
New framed-detail formatting (`hint:` lines, internal ansi/internal-chalk
modules; not part of the public contract).
`PreconditionFailedError` still exists but no shipped World throws it.

## 11. @workflow/utils delta (4.1.4 -> 5.0.0-beta.10)

Added exports: `debugLog`, `isWorkflowDebugEnabled` (debug-log.js);
`globalSingleton`, `resetGlobalSingletonForTest` (global-singleton.js;
world-local uses it for the streamer ULID factory: adopt for any per-process
state that must survive duplicated module instances in bundled hosts);
`formatStepName`, `formatWorkflowName`, `stepDisplayName`,
`workflowDisplayName` (parse-name.js additions).
No removals. `get-port` gained a `get-port-internals` module (internal).

## 12. Migration notes from the official guide (upgrading-to-v5.mdx)

Required, in order of effort:

1. Event ID allocation (section 3.5 / 5 above). NOT visible from types.
   HARD COMPATIBILITY BREAK: ULID-numbered runs already in the store CANNOT be
   replayed by v5 code; no mixed-scheme mode, no per-run fallback. Drain
   in-flight runs on 4.x before deploying a v5 World.
2. Interface changes: streams namespace + arg order; `steps.get` requires
   runId; `events.listByCorrelationId` requires runId (cursor comparison must
   scope by run too); export `createWorld()` (rename from createXxxWorld);
   `specVersion` required (`SPEC_VERSION_CURRENT`); worlds are injected into
   host bundles at build time (module graph must survive bundling; getWorld and
   createWorld are async).
3. Contract changes (compile clean, fail at runtime): waits are queue
   continuations with delaySeconds (no `{timeoutSeconds}` return); suspension
   dispatches steps + waits as one parallel batch; step queue kind retired;
   capabilities fail closed; the `preconditionGuard` / `stateUpdatedAt` 412
   guard is REMOVED (delete ours; bump-and-report replaces it).

Optional adoption (perf, never correctness): capabilities flags, analytics,
experimentalSetAttributes (needed for lineage tests / setAttributes),
cancelMany, getRuntimeDeadline, getEnvironment, createRunId, describeRun,
waitForTerminalStatus, createBatch, sinceCursor/preloadEvents deltas,
streams.streamFlushIntervalMs (default now 0), hook token retention,
hook resume dedup (requires `(runId, resumeId)` constraint AND round-tripping
`resumeId` through events.list).

There is an official migration skill:
`npx skills add https://github.com/vercel/workflow --skill migrating-world-v4-to-v5`
(distinct from `migrating-workflow-v4-to-v5` for app code; run the app one
first if the repo has both). Reference implementations: `packages/world-local`,
`packages/world-postgres` on the main branch;
`git diff stable...workflow@5.x -- packages/world packages/world-vercel packages/world-postgres`.

Verification checklist from the guide: suspend on step and on wait (batched
dispatch); parallel fan-out racing on one position; hook resumed after run
progressed; retained hook token past run end; stream written/read incl. closed
before reader attaches; old-spec run read back. Run `@workflow/world-testing`
first: `numbers events by position` catches slot bugs as one test line instead
of a first-replay production failure.

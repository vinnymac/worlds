---
'@fantasticfour/world-azure': minor
---

Aligns `world-azure` with `@workflow/world` 4.2.1 and closes four confirmed
correctness bugs.

Event and entity writes now commit in a single same-partition transactional
batch guarded by `_etag`, closing the resurrection race where a crashed writer
could leave orphaned terminal events. The Cosmos SDK wraps batch failures in a
plain `Error`, discarding the inner 409/429 status; that wrapper is now unwrapped
so conflict and throttle handling actually runs.

Service Bus honors `timeoutSeconds` and `delaySeconds` via
`scheduledEnqueueTimeUtc` on redelivered messages, replacing the previous
in-process `setTimeout` that lost all pending retries on restart. `start()` now
provisions the queue with duplicate detection enabled and throws loudly if an
existing queue was created without it. The streamer is rewritten on ULID
`chunkId` ordering and exposes the full contract surface
(`getStreamChunks`, `getStreamInfo`, `listStreamsByRunId`).

`specVersion` is declared with a binary-safe queue transport and a transactional
`run_started` bootstrap so the resilient-start path in core 4.6.0 works
correctly. The typed error taxonomy (`EntityConflictError`, `RunExpiredError`,
`TooEarlyError`, `WorkflowRunNotFoundError`) replaces generic
`WorkflowWorldError` throws so core's static `.is()` checks match by name.
`hook_created` follows the 4.2.1 conflict semantics: same-entity duplicates
throw `EntityConflictError`, crash orphans are completed, and foreign holders
emit a `hook_conflict` event with `conflictingRunId`. Wait entities and
`World.close()` are added.

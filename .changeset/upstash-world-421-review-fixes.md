---
'@fantasticfour/world-upstash': minor
---

Align world-upstash with the @workflow/world 4.2.1 contract and fix several
reliability bugs.

`specVersion` is now declared and the body is transmitted as binary-safe
base64, so the handshake succeeds on any QStash plan without content-encoding
surprises. The typed error taxonomy from `@workflow/core` is adopted throughout,
meaning `WorkflowNotFoundError`, `RunNotFoundError`, and friends are thrown by
name rather than as generic errors, which lets `@workflow/core` route them
correctly. Creation events and hook tokens are now claimed via `SETNX`, fixing
a replay self-conflict where a run could fight itself on redelivery and a
last-writer-wins race when two deliveries arrived in close succession.

`opts.idempotencyKey` is forwarded as `deduplicationId` on every publish. The
previous code generated a fresh ULID per call, so QStash deduplication was
effectively disabled and callers who relied on it received duplicate processing.
`isWebhook` is now persisted so the flag survives a redelivery cycle. The
stream-closed flag comparison is also corrected: Upstash auto-deserializes the
stored `"1"` to the number `1`, so the `=== '1'` guard always missed and streams
never reported closed. Stream chunks are consistently base64 encoded, preventing
string-chunk corruption that corrupted payloads like `'hello world'` on
round-trip.

`retryAfter` is now enforced on rate-limit responses, and `hook_created` conflict
semantics match the 4.2.1 spec so a repeated webhook delivery is idempotent
rather than raising an error.

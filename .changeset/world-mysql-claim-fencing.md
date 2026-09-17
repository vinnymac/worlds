---
'@fantasticfour/world-mysql': minor
---

Fence queue settles by claim. Completing, retrying, rescheduling, and failing a job matched its row by id alone, so an executor that outlived the visibility timeout could delete, reset, or fail the row after it was reclaimed and redelivered to another worker, and release its idempotency key while the redelivery was still running. Each claim now writes a fresh `claim_token`, and settles only apply while the token and `locked_by` still match; a stale settle is a debug-logged no-op and is left out of the queue metrics. A job the reclaimer already marked failed stays failed when its slow executor later succeeds. Run `world-mysql-setup` to apply the additive `0005_jobs_claim_token` migration.

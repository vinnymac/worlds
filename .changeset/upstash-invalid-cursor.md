---
'@fantasticfour/world-upstash': patch
---

Reject an unresolvable pagination cursor instead of silently skipping an entry.

Every paginated list resolved its cursor with `(rank ?? 0) + 1`. When `ZRANK`
could not find the cursor in the index it returns null, so the expression
produced `1` and the page started at rank 1, dropping the index's first entry
without any signal. Callers got a page that looked complete and quietly lost an
event, step, hook, or run.

The six call sites now share one `resolveCursorRank` helper that throws
`WorkflowWorldError` with status 400 for a cursor that is not in the index,
matching world-redis. This is a behaviour change: a caller that previously
passed a stale or fabricated cursor got a silently shifted page and now gets a
400. That is the intent, since the previous result was wrong data rather than a
smaller page.

Noticed while adding correlation-id pagination coverage, which surfaced that the
three Redis-family worlds disagreed here: world-redis threw, world-redis-bullmq
restarts at rank 0 and repeats entries, and this world skipped one.

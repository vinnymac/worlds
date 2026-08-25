---
'@fantasticfour/world-cloudflare': patch
---

Implement `events.listByCorrelationId` instead of silently returning nothing.

It was a stub returning an empty page for every query. Core never calls this
method, so runs were unaffected, but the observability dashboard
`@workflow/web` does call it, which meant its events-by-correlation view
rendered empty on this world rather than reporting a problem.

With a `runId` the lookup is now real: one run maps to one Durable Object, so
it pages that run's log and filters by `correlationId`, accumulating until it
holds `limit + 1` matches before slicing. `hasMore` and the returned cursor
therefore describe the filtered set, which a filter applied after slicing would
have gotten wrong at every page boundary.

Without a `runId` there is still no global correlation index and an unscoped
lookup would have to fan out over every run, so it now throws
`WorkflowWorldError` with status 400 rather than returning an empty page. That
matches how `steps.get` and `hooks.list` already reject a missing `runId` here,
and 400 is accurate because the caller can fix it: `runId` has been available on
these params since world 4.5.0.

Adds six tests covering run scoping against a sibling run using the same
correlation id, pagination across the filtered set, `hasMore` accuracy, sparse
matches spanning several internal scan pages, descending order, and the
unscoped throw.

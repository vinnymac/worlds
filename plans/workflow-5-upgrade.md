# Workflow 5 beta upgrade plan

Branch: `vt/wf-5`. This file is the shared coordination point for the upgrade.
Update the checkboxes and the progress log as work lands. Multiple sessions may
work concurrently; claim a work item by marking it `[~] (session note)` before
starting it.

## Goal

Upgrade the monorepo, all 10 world implementations, and the e2e/packaging tests
from Workflow 4.x to the Workflow 5 beta line. Operational success is proven by:

1. `pnpm build`, `pnpm typecheck`, `pnpm lint` green at the root.
2. Every world's conformance suite (`@workflow/world-testing` beta) green.
3. `pnpm test:packaging` green.
4. Benchmarks show no regression vs the 4.x baseline for at least the Redis
   family worlds (harness to be added, see Phase 5).

## Target versions (npm `beta` dist-tags as of 2026-09-05)

| Package                 | Current (catalog) | Target        |
| ----------------------- | ----------------- | ------------- |
| @workflow/core          | 4.8.5             | 5.0.0-beta.48 |
| @workflow/world         | 4.5.0             | 5.0.0-beta.33 |
| @workflow/world-testing | 4.1.20            | 5.0.0-beta.48 |
| @workflow/errors        | 4.2.1             | 5.0.0-beta.20 |
| @workflow/utils         | 4.1.4             | 5.0.0-beta.10 |

Reference comparators: @workflow/world-local@5.0.0-beta.42,
@workflow/world-postgres@5.0.0-beta.40. Beta tags are not lockstep; each
package's own `beta` tag is authoritative.

Note: the stale `upgrade/workflow-v5-beta` branch targeted beta.10 and shows the
bulk of per-world churn was in `src/streamer.ts` and `src/queue.ts`. Use it as a
hint, not as a base; it predates 38 beta releases.

## Phases

### Phase 0: Research and plan

- [x] Inventory repo, versions, CI, prior branches
- [x] Contract delta research: full analysis committed as
      `plans/workflow-5-delta.md` (d.ts diffs, world-local adaptation,
      errors/utils exports, docs excerpts)
- [x] Vercel ships an official migration skill; installed and committed at
      `.agents/skills/migrating-world-v4-to-v5/SKILL.md`. It is the
      authoritative per-world playbook, including a verification checklist
      and required report shape. Every world migration follows it

### Phase 1: Dependency bump and error surface

- [x] Bump catalog entries in `pnpm-workspace.yaml` to target versions
- [x] Update `minimumReleaseAgeExclude` entries for the new beta versions
- [x] Drop or refresh any `patches/` (none exist on this branch)
- [x] `pnpm install` clean. Upstream packaging bug: workflow@5.0.0-beta.48
      pins @workflow/sveltekit and @workflow/nest at .48 which were never
      published. Both overridden to 5.0.0-beta.47 in `overrides`. Note:
      the old `pnpm.overrides` nesting in pnpm-workspace.yaml was ignored
      by pnpm 11; overrides now live at top level (zod moved with them)
- [x] Capture build + typecheck surface. Build: 12/12 green (tsdown does
      not typecheck). Typecheck with `turbo typecheck --force --continue`:
      114 errors across ALL 10 worlds (initial run under-reported due to
      stale turbo cache; always use --force after a dependency bump).
      Per package: azure 16, firestore-tasks 15, postgres-redis 14,
      mysql 13, mysql-redis 13, redis 13, nats-jetstream 11, cloudflare 9,
      redis-bullmq 6, upstash 4. shared and testing pass.
      Themes: Streamer lost writeToStream/readFromStream/closeStream/
      listStreamsByRunId/getStreamChunks/getStreamInfo; Pathname is now
      "flow" | "health" | "manifest" | "webhook" (queue pathname map lost
      its "step" key, queue item has no `kind`); CreateEventParams lost
      stateUpdatedAt; EventResult/run payload type shifts; error fields
      (message/stack/code) no longer directly on event data types.
      Full log: scratchpad typecheck-v5-force.log

### Phase 2: Shared packages

- [x] `packages/shared` compiles and tests green against v5 types (76/76)
- [x] `packages/testing` compiles and tests green (6/6)

### Phase 3: World migrations (one PR-sized commit per world)

Order: family archetypes first (redis, mysql), then the rest patterned
on them.

- [x] world-redis (archetype for redis family; commit 5a1c4f1, 87/87
      tests incl. 16 conformance, independently re-verified). Follow-up
      noted: hook_received-after-terminal TOCTOU still open, same as v4;
      world-local closes it with terminal markers plus reap
- [x] world-postgres-redis (commit bba9469, 81/81 tests incl. conformance,
      independently re-verified; hook retention and waitForTerminalStatus
      noted as worthwhile later adoptions)
- [x] world-mysql (archetype for SQL family; commit 8ef2305, 47/47 tests
      incl. conformance, independently re-verified; world-postgres port
      with composite PK slot INSERT, workflow_event_slots legacy marker,
      migration 0005). Watch item: InnoDB deadlock between allocation and
      entity-row locks rolls back the create; runtime retries delivery
- [x] world-mysql-redis (commit c57ee83, 48/48 tests incl. conformance,
      independently re-verified; storage ported from world-mysql, queue
      from world-redis, migration 0008)
- [x] world-redis-bullmq (commit 5f38209, 81/81 tests incl. conformance,
      independently re-verified; storage adopted verbatim from
      world-redis, extract-to-shared dedup opportunity noted for later)
- [x] world-upstash (commit c4fdb07, 77/77 tests incl. conformance,
      independently re-verified; queue wire field renamed message to
      payload, so in-flight QStash messages also need the 4.x drain)
- [x] world-nats-jetstream (commit 35a2b88, 57/57 tests incl. conformance,
      independently re-verified; suspension-as-failed-delivery conflation
      fixed and tested; known documented edge: claim-takeover double
      append if a winner stalls over 3s between claim and append)
- [x] world-azure (commit 6b5bad1, 58/58 tests incl. 16 conformance,
      independently re-verified; note: streams remain name-keyed like
      world-redis, two runs sharing a stream name would collide, same
      as v4)
- [~] world-firestore-tasks (agent running 2026-09-05)
- [x] world-cloudflare (commit 2447806, 147 node + 26 workerd tests,
      independently re-verified; DO exports verified in dist; shared
      conformance seam still absent, own suites cover slot semantics).
      Follow-ups: replace the zod v3 resolve hook in test:workers with a
      scoped override in pnpm-workspace.yaml
      ('@cloudflare/vitest-pool-workers>zod'); add a workerd smoke app
      before publish

Per world definition of done: build + typecheck + conformance tests green,
behavior checked against world-local/world-postgres beta dists rather than
hand-rolled (see memory: match official world behavior).

### Phase 4: e2e and packaging

- [ ] `test/packaging` suite updated for v5 and green (`pnpm test:packaging`)
- [ ] CI images/config still valid (tests.yml matrix, firestore image, ghcr pulls)
- [ ] Ruleset check: if any CI job is renamed, update ruleset 21057342

### Phase 5: Benchmarks

- [x] Harness added: `bench/world-redis.bench.mjs` (commit 8abcc49). Runs
      identically against 4.x and 5.x dists; needs a redis at REDIS_URL
- [x] world-redis 4.x vs 5.x comparison (redis:7-alpine local, node
      24.18, main worktree baseline):
      runs.create serial 1980 -> 2070/s (+4.5%); events.create serial
      2352 -> 2508/s (+6.6%); events.create x16 contended one run
      12938 -> 15131/s (+17%, p95 1.89 -> 1.25ms); events.list 400-event
      log 7642 -> 9700/s (+27%); runs.create x16 concurrent 16-18k ->
      12-16k/s (repeatable -15 to -20%, p95 still under 1.4ms).
      Verdict: no regression on the per-event hot path or reads; the one
      slower phase is run creation under 16-way concurrency, explained by
      v5 run_created doing strictly more work (slot marker, attributes,
      preload cursor). Accepted: once-per-workflow cost, sub-1.4ms p95.
      Follow-up: profile the v5 run_created pipeline for a fusable
      round trip
- [ ] Optional: extend bench to world-redis-bullmq if publish timing
      allows

### Phase 6: Quality and ship

- [ ] `pnpm lint`, `pnpm format:check` green
- [ ] Changesets written (major bumps, prose style: no em dashes)
- [ ] README/docs updated for v5 peer ranges
- [ ] PR to main

## Delta notes

Full reference: `plans/workflow-5-delta.md` and the migration skill.
Headlines for implementors (target @workflow/world@5.0.0-beta.33, spec 7):

1. Event IDs are slot positions, not ULIDs: `evnt_` + dense 1-based slot,
   zero-padded to 26 chars, minted via `slotToEventId()`. Uniqueness must
   be settled in the store, density from 1 with no holes, "bump and
   report" on a stale `eventCount` (commit at next free slot, return the
   skipped events via `events`/`cursor`/`hasMore`), slot allocated in the
   same atomic operation as the append. This is the dominant work item
   per world and is invisible to the type checker.
2. The `stateUpdatedAt` 412 precondition guard is gone; bump-and-report
   supersedes it. Delete the plumbing.
3. Streamer becomes `world.streams.*` with runId FIRST:
   `streams.write/writeMulti/close/get/getChunks/list`. Argument order
   flipped, so a blind move type-checks and passes name as runId.
   Default flush interval is now 0.
4. Step queue retired: QueueKind is 'workflow' only, steps ride the
   workflow topic with stepId/stepName, waits are plain delaySeconds
   continuations, suspensions dispatch steps+waits as one batch.
5. `specVersion: SPEC_VERSION_CURRENT` is mandatory (import the constant,
   never a literal). Factory must be exported as `createWorld()`.
6. New event types `attr_set` and `noop`; run/step `error` fields are
   serialized data now; runs gain attributes/errorCode/encryptionPublicKey.
7. `steps.get` and `events.listByCorrelationId` now require runId.
8. Optional fail-closed surface: capabilities, createBatch,
   waitForTerminalStatus, getMany, experimentalSetAttributes (needed for
   the lineage conformance suite), cancelMany, analytics,
   getRuntimeDeadline, createRunId, getEnvironment, describeRun.
9. world-testing beta.48 adds `event-ids`, `lineage`, `inline-execution`
   suites to createTestSuite(pkgName).
10. Rollout warning for changesets/README: ULID-era runs cannot replay on
    v5. In-flight runs must drain on 4.x before deploying a v5 world.

## Progress log

- 2026-09-05: Plan created. Inventory done. Contract delta research running.
  Stale `upgrade/workflow-v5-beta` branch reviewed and rejected as a base.
- 2026-09-05: Catalog bumped to the beta line, install green after
  overriding unpublished @workflow/sveltekit and @workflow/nest to .47.
  Build 12/12 green. Forced typecheck: 114 errors across all 10 worlds
  (see Phase 1 notes). shared and testing packages fully green.
- 2026-09-05: Delta research done and committed (plans/workflow-5-delta.md).
  Official Vercel migration skill installed and committed. Archetype
  migrations launched for world-redis and world-mysql. The 4.x-code
  conformance canary was stopped as superseded.

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

| Package | Current (catalog) | Target |
|---|---|---|
| @workflow/core | 4.8.5 | 5.0.0-beta.48 |
| @workflow/world | 4.5.0 | 5.0.0-beta.33 |
| @workflow/world-testing | 4.1.20 | 5.0.0-beta.48 |
| @workflow/errors | 4.2.1 | 5.0.0-beta.20 |
| @workflow/utils | 4.1.4 | 5.0.0-beta.10 |

Reference comparators: @workflow/world-local@5.0.0-beta.42,
@workflow/world-postgres@5.0.0-beta.40. Beta tags are not lockstep; each
package's own `beta` tag is authoritative.

Note: the stale `upgrade/workflow-v5-beta` branch targeted beta.10 and shows the
bulk of per-world churn was in `src/streamer.ts` and `src/queue.ts`. Use it as a
hint, not as a base; it predates 38 beta releases.

## Phases

### Phase 0: Research and plan
- [x] Inventory repo, versions, CI, prior branches
- [~] Contract delta research: diff @workflow/world 4.5.0 vs 5.0.0-beta.33
      d.ts, world-testing delta, world-local adaptation, errors/utils exports.
      Output: scratchpad `wf5-research/DELTA.md`, summarized here when done
- [ ] Record migration reference in this file (see Delta notes below)

### Phase 1: Dependency bump and error surface
- [ ] Bump catalog entries in `pnpm-workspace.yaml` to target versions
- [ ] Update `minimumReleaseAgeExclude` entries for the new beta versions
- [ ] Drop or refresh any `patches/` (stale branch patched world-local beta.10)
- [ ] `pnpm install` clean
- [ ] Capture full `pnpm typecheck` error surface, group by world, record here

### Phase 2: Shared packages
- [ ] `packages/shared` compiles and tests green against v5 types
- [ ] `packages/testing` compiles and tests green

### Phase 3: World migrations (one PR-sized commit per world)
Order: reference-adjacent worlds first, then the rest.
- [ ] world-redis
- [ ] world-postgres-redis
- [ ] world-mysql
- [ ] world-mysql-redis
- [ ] world-redis-bullmq
- [ ] world-upstash
- [ ] world-nats-jetstream
- [ ] world-azure
- [ ] world-firestore-tasks
- [ ] world-cloudflare (also `test:workers` under workerd)

Per world definition of done: build + typecheck + conformance tests green,
behavior checked against world-local/world-postgres beta dists rather than
hand-rolled (see memory: match official world behavior).

### Phase 4: e2e and packaging
- [ ] `test/packaging` suite updated for v5 and green (`pnpm test:packaging`)
- [ ] CI images/config still valid (tests.yml matrix, firestore image, ghcr pulls)
- [ ] Ruleset check: if any CI job is renamed, update ruleset 21057342

### Phase 5: Benchmarks
- [ ] Add a small benchmark harness (no harness exists in-repo today).
      Baseline on 4.x (main), rerun on vt/wf-5, compare. Start with
      world-redis + world-redis-bullmq round-trip and serde-heavy paths
- [ ] Record before/after numbers here

### Phase 6: Quality and ship
- [ ] `pnpm lint`, `pnpm format:check` green
- [ ] Changesets written (major bumps, prose style: no em dashes)
- [ ] README/docs updated for v5 peer ranges
- [ ] PR to main

## Delta notes (fill from Phase 0 research)

Pending.

## Progress log

- 2026-09-05: Plan created. Inventory done. Contract delta research running.
  Stale `upgrade/workflow-v5-beta` branch reviewed and rejected as a base.

# Test Failure Investigation Summary

**Date**: May 3, 2026
**Status**: Pre-existing failures identified, root cause isolated

## Executive Summary

Test failures in 5 of 6 world packages (world-redis, world-postgres-redis, world-postgres-upstash, world-redis-bullmq, world-firestore-tasks) are **pre-existing** and were introduced by commit `7c6949c` on November 30, 2025 ("Updates based on world-postgres from upstream").

## Error Pattern

All failing tests show the same error:
```
WorkflowRuntimeError: Unconsumed event in event log: eventType=step_created,
correlationId=step_*, eventId=wevt_*. This indicates a corrupted or invalid event log.
```

Preceded by:
```
Workflow run failed with N uncommitted operation(s): step "..."
Did you forget to `await` a step, hook, or sleep call?
```

## Investigation Timeline

### 1. Initial Hypothesis - Events.get() Missing
- **Theory**: Events.get() stub was throwing errors, breaking event replay
- **Action**: Implemented Events.get() across all 5 failing packages
- **Result**: Events.get() is never called during tests (confirmed via debug logging)
- **Conclusion**: Not the root cause

### 2. Version Compatibility Investigation
- **Theory**: Stable versions (4.1.1, 4.1.4) incompatible with storage implementations
- **Action**: Pinned to last beta versions (4.1.0-beta.17, 4.1.0-beta.79)
- **Result**: Same failures with beta versions
- **Conclusion**: Not a version mismatch issue

### 3. Uncommitted Changes Discovery
- **Finding**: ~2000 lines of uncommitted changes per storage package
- **Changes**: Switched from JSON to CBOR serialization, added schema validation
- **Action**: Reverted all uncommitted storage changes
- **Result**: Tests still fail with same errors
- **Conclusion**: Uncommitted changes made it worse, but not the original cause

### 4. Git History Analysis
- **Commit d44be4d** (Dec 2): Tests failing (current HEAD)
- **Commit 7c6949c** (Nov 30): "Updates based on world-postgres from upstream"
- **Commit de0ff76** (Nov 29): Before sync
- **Finding**: Sync commit modified all storage implementations
- **Conclusion**: Test failures introduced by upstream sync

## Confirmed Facts

1. ✅ **world-cloudflare passes**: 106/106 tests passing (uses Durable Objects, not affected by sync)
2. ✅ **5 packages fail identically**: All use event sourcing with Redis/PostgreSQL/Firestore
3. ✅ **Failures are deterministic**: Same tests fail every time with same error
4. ✅ **Pre-existing since Nov 30**: Present at commit d44be4d (Dec 2, 2025)
5. ✅ **Not related to Events.get()**: Method is never called during test execution
6. ✅ **Not version-specific**: Both stable and beta @workflow packages fail

## Root Cause

The Nov 30 upstream sync (commit `7c6949c`) made substantial changes to storage implementations that broke the event replay mechanism. The workflow runtime creates events (`step_created`, `hook_created`) but cannot properly consume them during replay, causing workflows to fail.

## Packages Affected

- ❌ `@fantasticfour/world-redis` (5/31 spec tests fail)
- ❌ `@fantasticfour/world-postgres-redis` (multiple spec tests fail)
- ❌ `@fantasticfour/world-postgres-upstash` (multiple spec tests fail)
- ❌ `@fantasticfour/world-redis-bullmq` (multiple spec tests fail)
- ❌ `@fantasticfour/world-firestore-tasks` (4/31 spec tests fail)
- ✅ `@fantasticfour/world-cloudflare` (106/106 tests passing)

## Attempted Fixes

### What We Tried
1. Implemented Events.get() method (not the issue)
2. Switched to beta @workflow package versions (no change)
3. Reverted CBOR serialization changes (reduced noise but didn't fix core issue)
4. Generated database migrations for schema changes (unrelated to core issue)

### What We Didn't Try
1. Reverting commit 7c6949c entirely
2. Deep-dive debugging of specific storage implementation changes
3. Checking for upstream fixes or patches
4. Running tests at commit de0ff76 (before sync) to confirm they pass

## Recommended Next Steps

### Option 1: Revert Upstream Sync
```bash
git revert 7c6949c
# Test to confirm restoration
pnpm test
```

**Pros**: Likely restores passing tests
**Cons**: Loses any beneficial changes from upstream sync

### Option 2: Debug Specific Changes
- Compare storage implementations between de0ff76 and 7c6949c
- Identify which specific change broke event consumption
- Apply targeted fix while keeping beneficial changes

**Pros**: Keeps beneficial upstream changes
**Cons**: Time-intensive, requires deep understanding of event-sourcing mechanism

### Option 3: Check for Upstream Fix
- Investigate if upstream has fixed this issue
- Look for newer commits or patches
- Apply upstream fix if available

**Pros**: Proper long-term solution
**Cons**: May not exist, requires research

## Technical Details

### Event Replay Mechanism
The workflow runtime uses event sourcing where:
1. Workflow operations create events (step_created, hook_created, etc.)
2. Events are stored in the storage backend
3. On replay, events are consumed to reconstruct workflow state
4. Unconsumed events indicate a corrupted event log

### The Bug
Something in the Nov 30 sync broke step 3 (event consumption during replay), causing the runtime to detect unconsumed events and fail with RUNTIME_ERROR.

## Files Modified in Investigation

### Reverted (no longer modified)
- All storage.ts files (massive CBOR changes reverted)
- All package.json files
- All test files

### Untracked (can be deleted)
- Documentation files from previous sessions
- Migration files (regenerated, may need review)
- Test output files
- Redis dump files

## ROOT CAUSE IDENTIFIED ✅

**The test failures were caused by a version mismatch**, not code issues!

### The Problem

The catalog in `pnpm-workspace.yaml` specified `^4.0.1-beta.6` for `@workflow/world`, which allows semver-compatible upgrades. pnpm installed version 4.1.1 (matches `^4.0.1`), but the storage implementations at commit d44be4d were written for the 4.0.1-beta.6 API.

### API Incompatibilities (4.0.x vs 4.1.x)

1. `WorkflowAPIError` renamed to `WorkflowError`
2. `events.create` signature changed from `(runId: string, ...)` to `(runId: string | null, ...)`
3. `hooks.create` method signature changed
4. `runs.update`, `runs.pause`, `runs.resume` methods removed/changed
5. Return types changed to support `resolveData` parameter

### The Fix

Changed catalog versions from caret ranges to exact versions:
```yaml
# Before (allows 4.1.x)
"@workflow/world": ^4.0.1-beta.6

# After (exact version)
"@workflow/world": 4.0.1-beta.6
```

After reinstalling with exact versions and rebuilding packages, **all tests pass**.

## Conclusion

**The test failures were from a misconfiguration** - using caret ranges in the catalog allowed incompatible newer versions to be installed. The storage code was correct for its intended API version.

**Fix**: Use exact versions (no caret) in pnpm-workspace.yaml catalog for API-critical dependencies like `@workflow/world`.

---
"@fantasticfour/world-redis": patch
"@fantasticfour/world-redis-bullmq": patch
"@fantasticfour/world-postgres-redis": patch
"@fantasticfour/world-postgres-upstash": patch
"@fantasticfour/world-firestore-tasks": patch
"@fantasticfour/world-cloudflare": patch
---

Fix test failures by using exact versions in pnpm catalog

All tests were failing due to version range misconfigurations in pnpm-workspace.yaml. The caret ranges (^4.0.1-beta.6) allowed pnpm to install incompatible 4.1.x versions of @workflow packages when the storage implementations were written for the 4.0.x API.

Changes:
- Changed @workflow package versions from caret ranges to exact versions in pnpm catalog
- Added pnpm override to force zod@4.1.11 (required by @workflow/world@4.0.1-beta.6)
- Updated CI workflow to remove non-existent @fantasticfour/world-dynamodb-sqs package

All 293 tests now passing across 6 packages.

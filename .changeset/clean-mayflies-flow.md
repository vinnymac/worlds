---
"@fantasticfour/world-cloudflare": patch
"@fantasticfour/world-firestore-tasks": patch
"@fantasticfour/world-mysql": patch
"@fantasticfour/world-mysql-redis": patch
"@fantasticfour/world-postgres-redis": patch
"@fantasticfour/world-redis": patch
"@fantasticfour/world-redis-bullmq": patch
---

docs: rename world-mysql-upstash to world-upstash and fix Docker images

**Documentation updates:**
- Renamed `@fantasticfour/world-mysql-upstash` to `@fantasticfour/world-upstash` across all package documentation
- Updated cross-references in README files and migration guides

**CI/Test fixes:**
- Replaced deprecated AWS ECR public mirror images (`public.ecr.aws/docker/library/*`) with official Docker Hub images
- Fixed HTTP 404 errors in GitHub Actions workflows and testcontainers
- Updated to use: `postgres:15-alpine`, `redis:7-alpine`, `mysql:8.0`, `nats:2.10-alpine`

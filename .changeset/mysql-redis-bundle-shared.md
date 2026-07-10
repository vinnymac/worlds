---
'@fantasticfour/world-mysql-redis': patch
---

Bundle `@fantasticfour/shared` into the published output instead of importing it
at runtime.

`@fantasticfour/shared` is a private, unpublished workspace package, but
`world-mysql-redis` listed it under `dependencies`, so tsdown left it external
and the published bundle (and its `.d.ts`) imported a package that does not
exist on npm — breaking `npm install`. Moving it to `devDependencies` (matching
every other world) lets tsdown inline it, producing a self-contained artifact.

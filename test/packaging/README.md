# Packaging conformance

```bash
pnpm test:packaging   # builds, then packs and probes every published world
```

Every suite under `packages/*/test` imports from `../src/*`. That exercises
neither the `exports` map, nor `files`, nor the tsdown entry list, so a package
can be built, published, and completely unusable without a single test going
red. That is how `@fantasticfour/world-cloudflare` shipped from 1.0.0 through
2.4.0 without its Durable Object classes, and how
`@fantasticfour/world-mysql-redis` shipped `dist/health.js` with no `./health`
subpath to reach it.

This suite `pnpm pack`s each published world, extracts the tarball into
`node_modules/<name>` of a synthetic package in a temp dir, symlinks **only the
dependencies the packed manifest declares**, and probes it with plain `node`.
Node's resolver is the one that matters here; Vite would resolve subpaths the
`exports` map never declares. It asserts:

- every `exports` subpath resolves, and every JavaScript one imports and has exports
- every `exports` target, `files` entry, and `bin` target is actually in the tarball
- the tsdown `entry` map and the `exports` map agree **in both directions**.
  Built but unreachable is as much a failure as exported but never built.
- no `catalog:` or `workspace:` protocol survives into the published manifest
- each world's root exports `createWorld`

Because only declared dependencies are linked, a devDependency the bundler
failed to inline fails here the way it would for a user, not in an issue report.

## Adding a world

Nothing to do. Any non-private package under `packages/` is discovered and
packed automatically.

Two lists in `packaging.test.ts` are hand-maintained, both for things no static
check can infer:

- `RUNTIME_STUBS`: builtins of other runtimes (`cloudflare:workers`) stubbed so
  a module written for workerd can still be loaded and its export names checked.
- `REQUIRED_EXPORTS`: names a subpath must ship. This is the only guard for a
  public entrypoint missing from _both_ the tsdown entry map and the exports
  map, since in that state nothing in the repo knows it was meant to exist.

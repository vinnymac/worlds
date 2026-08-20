import { afterAll, describe, expect, it } from 'vitest';
import {
  cleanupPacked,
  collectExportTargets,
  discoverPublishedPackages,
  expandSubpath,
  packAll,
  type ProbeTarget,
  readTsdownEntries,
  runProbe,
  runtimeExportTarget,
} from './harness.js';

/**
 * Packaging conformance.
 *
 * Every other suite imports `../src/*`, which exercises neither the
 * `exports` map, `files`, nor the tsdown entry list. This one packs each world
 * and drives it from outside the monorepo, so drift between what gets built,
 * shipped, and exported fails here instead of in an `npm install`.
 */

/** Builtins of other runtimes, stubbed so their modules still load here. */
const RUNTIME_STUBS: Record<string, Record<string, string>> = {
  // The DO classes extend a workerd builtin. Consumers must re-export them
  // from their entrypoint or wrangler refuses to deploy, so the names are part
  // of the package contract.
  '@fantasticfour/world-cloudflare/worker': {
    'cloudflare:workers': 'export class DurableObject {}\nexport class WorkerEntrypoint {}\n',
  },
};

/** Export names a subpath must ship, beyond simply being non-empty. */
const REQUIRED_EXPORTS: Record<string, string[]> = {
  '@fantasticfour/world-cloudflare/worker': ['StreamDO', 'WorkflowRunDO'],
};

/** Dependency ranges that never survive publish, because npm cannot install them. */
const UNPUBLISHABLE_PROTOCOLS = ['catalog:', 'workspace:', 'link:', 'file:'];

const workspaces = await discoverPublishedPackages();
const packages = await packAll(workspaces);

afterAll(async () => {
  await cleanupPacked();
});

it('discovers the published worlds', () => {
  expect(packages.map((pkg) => pkg.name)).toEqual(workspaces.map((pkg) => pkg.name));
  expect(packages.length).toBeGreaterThan(0);
});

describe.each(packages.map((pkg) => [pkg.name, pkg] as const))('%s', (_name, pkg) => {
  const exportsMap = pkg.packedManifest.exports ?? {};
  const subpaths = Object.keys(exportsMap);

  it('declares an exports map', () => {
    expect(subpaths.length).toBeGreaterThan(0);
    expect(subpaths).toContain('.');
  });

  it('ships every file its exports map points at', () => {
    const shipped = new Set(pkg.packedFiles);
    const missing: string[] = [];

    for (const [subpath, entry] of Object.entries(exportsMap)) {
      for (const target of collectExportTargets(entry)) {
        const relative = target.replace(/^\.\//, '');
        if (relative.includes('*')) {
          const [prefix, suffix] = relative.split('*');
          const matched = pkg.packedFiles.some(
            (file) => file.startsWith(prefix) && file.endsWith(suffix),
          );
          if (!matched) missing.push(`${subpath} -> ${target} (no files match)`);
          continue;
        }
        if (!shipped.has(relative)) missing.push(`${subpath} -> ${target}`);
      }
    }

    expect(missing, 'exports targets absent from the tarball').toEqual([]);
  });

  it('ships every path listed in files', () => {
    const declared = pkg.packedManifest.files ?? [];
    const missing = declared.filter(
      (entry) => !pkg.packedFiles.some((file) => file === entry || file.startsWith(`${entry}/`)),
    );
    expect(missing, '`files` entries absent from the tarball').toEqual([]);
  });

  it('ships every bin target', () => {
    const bin = pkg.packedManifest.bin;
    if (!bin) return;
    const targets = typeof bin === 'string' ? [bin] : Object.values(bin);
    const missing = targets.filter(
      (target) => !pkg.packedFiles.includes(target.replace(/^\.\//, '')),
    );
    expect(missing, '`bin` targets absent from the tarball').toEqual([]);
  });

  it('publishes dependency ranges npm can install', () => {
    const ranges = Object.entries({
      ...pkg.packedManifest.dependencies,
      ...pkg.packedManifest.peerDependencies,
    });
    const unpublishable = ranges
      .filter(([, range]) => UNPUBLISHABLE_PROTOCOLS.some((proto) => range.startsWith(proto)))
      .map(([dep, range]) => `${dep}@${range}`);
    expect(unpublishable, 'workspace-only protocols left in the published manifest').toEqual([]);
  });

  it('keeps the tsdown entry map and the exports map in agreement', async () => {
    const entries = await readTsdownEntries(pkg.sourceDir);

    // tsdown names each chunk after its entry key: `health` -> `dist/health.js`.
    // Built but unexported is unreachable; exported but unbuilt is broken.
    const built = new Set(Object.keys(entries).map((key) => `./dist/${key}.js`));
    const exported = new Set(
      Object.values(exportsMap)
        .map(runtimeExportTarget)
        .filter((target): target is string => target !== null && target.startsWith('./dist/')),
    );

    const builtButNotExported = [...built].filter((target) => !exported.has(target)).sort();
    const exportedButNotBuilt = [...exported].filter((target) => !built.has(target)).sort();

    expect(
      builtButNotExported,
      'built by tsdown but unreachable: add a subpath to package.json#exports',
    ).toEqual([]);
    expect(
      exportedButNotBuilt,
      'exported but never built: add an entry to tsdown.config.ts',
    ).toEqual([]);
  });

  describe('consumer resolution', () => {
    it('resolves and imports every declared subpath', async () => {
      const plain: ProbeTarget[] = [];
      const stubbed = new Map<string, ProbeTarget[]>();

      for (const [subpath, entry] of Object.entries(exportsMap)) {
        for (const concrete of expandSubpath(subpath, entry, pkg.packedFiles)) {
          const specifier =
            concrete === '.' ? pkg.name : `${pkg.name}/${concrete.replace(/^\.\//, '')}`;
          // Only JavaScript is importable. For asset subpaths like `.sql`,
          // resolving through the exports map is the whole contract.
          const target = runtimeExportTarget(entry) ?? '';
          const mode: ProbeTarget['mode'] = /\.(js|mjs|cjs)$/.test(target) ? 'import' : 'resolve';

          const stubs = RUNTIME_STUBS[specifier];
          if (stubs) {
            const key = JSON.stringify(stubs);
            const bucket = stubbed.get(key) ?? [];
            bucket.push({ specifier, mode });
            stubbed.set(key, bucket);
          } else {
            plain.push({ specifier, mode });
          }
        }
      }

      const results = await runProbe(pkg, plain);
      for (const [key, targets] of stubbed) {
        for (const [specifier, result] of await runProbe(pkg, targets, JSON.parse(key))) {
          results.set(specifier, result);
        }
      }

      const failures: string[] = [];
      for (const [specifier, result] of results) {
        if (result.resolveError) {
          failures.push(`${specifier}: does not resolve: ${result.resolveError}`);
          continue;
        }
        if (result.importError) {
          failures.push(`${specifier}: resolves but fails to import: ${result.importError}`);
          continue;
        }
        if (result.mode === 'import' && (result.exportNames?.length ?? 0) === 0) {
          failures.push(`${specifier}: imports but exports nothing`);
        }
      }

      expect(failures, 'subpaths a consumer cannot use').toEqual([]);
      expect(results.size).toBeGreaterThan(0);
    });

    it('exports a world factory from the package root', async () => {
      const results = await runProbe(pkg, [{ specifier: pkg.name, mode: 'import' }]);
      const root = results.get(pkg.name);
      expect(root?.importError).toBeUndefined();
      expect(root?.exportNames).toContain('createWorld');
    });

    it('exports the names its subpaths promise', async () => {
      const required = Object.entries(REQUIRED_EXPORTS).filter(([specifier]) =>
        specifier.startsWith(`${pkg.name}/`),
      );
      if (required.length === 0) return;

      for (const [specifier, names] of required) {
        const results = await runProbe(
          pkg,
          [{ specifier, mode: 'import' }],
          RUNTIME_STUBS[specifier],
        );
        const result = results.get(specifier);

        expect(
          result?.resolveError,
          `${specifier} does not resolve; declare it in package.json#exports`,
        ).toBeUndefined();
        expect(result?.importError, `${specifier} failed to import`).toBeUndefined();
        expect(result?.exportNames ?? [], `${specifier} must export ${names.join(', ')}`).toEqual(
          expect.arrayContaining(names),
        );
      }
    });
  });
});

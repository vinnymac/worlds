/**
 * Consumer-side probe, run with plain `node` from a synthetic package outside
 * the monorepo. Node's resolver is the one that matters: Vite would resolve
 * subpaths the `exports` map never declares.
 *
 * argv[2]: JSON `{ specifier, mode }[]`.
 * argv[3]: JSON map of specifier -> stub source, for builtins of other runtimes.
 *
 * Failures are reported as data on stdout, never thrown, so one broken subpath
 * cannot hide the others.
 */

import { registerHooks } from 'node:module';

const targets = JSON.parse(process.argv[2]);
const stubs = JSON.parse(process.argv[3] ?? '{}');

const STUB_PREFIX = 'packaging-stub:';

if (Object.keys(stubs).length > 0) {
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (Object.hasOwn(stubs, specifier)) {
        return { url: STUB_PREFIX + specifier, shortCircuit: true };
      }
      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      if (url.startsWith(STUB_PREFIX)) {
        return {
          format: 'module',
          shortCircuit: true,
          source: stubs[url.slice(STUB_PREFIX.length)],
        };
      }
      return nextLoad(url, context);
    },
  });
}

const results = [];

for (const target of targets) {
  const result = { specifier: target.specifier, mode: target.mode };

  try {
    result.resolved = import.meta.resolve(target.specifier);
  } catch (error) {
    result.resolveError = String(error?.message ?? error);
    results.push(result);
    continue;
  }

  if (target.mode === 'import') {
    try {
      const namespace = await import(target.specifier);
      result.exportNames = Object.keys(namespace).sort();
    } catch (error) {
      result.importError = String(error?.stack ?? error?.message ?? error);
    }
  }

  results.push(result);
}

process.stdout.write(JSON.stringify(results));

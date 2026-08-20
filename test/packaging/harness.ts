import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const FIXTURES = path.resolve(import.meta.dirname, 'fixtures');

/** A leaf of an `exports` map: a file target, a condition object, or null. */
export type ExportsEntry = string | { [condition: string]: ExportsEntry } | null;

export interface Manifest {
  name: string;
  version: string;
  private?: boolean;
  files?: string[];
  bin?: string | Record<string, string>;
  exports?: Record<string, ExportsEntry>;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}

export interface PackedPackage {
  /** Package name as published, e.g. `@fantasticfour/world-redis`. */
  name: string;
  /** Source directory inside the monorepo. */
  sourceDir: string;
  /** Manifest as it exists inside the tarball, after pnpm resolves `catalog:`. */
  packedManifest: Manifest;
  /** Where the tarball was extracted: `<consumer>/node_modules/<name>`. */
  installDir: string;
  /** Synthetic consumer package the probe runs from. */
  consumerDir: string;
  /** Every file in the tarball, as paths relative to the package root. */
  packedFiles: string[];
}

export interface ProbeTarget {
  specifier: string;
  /** `import` evaluates the module; `resolve` only walks the exports map. */
  mode: 'import' | 'resolve';
}

export interface ProbeResult extends ProbeTarget {
  resolved?: string;
  resolveError?: string;
  importError?: string;
  exportNames?: string[];
}

const scratchRoots: string[] = [];

/** Every workspace package that actually gets published to npm. */
export async function discoverPublishedPackages(): Promise<Array<{ name: string; dir: string }>> {
  const packagesDir = path.join(REPO_ROOT, 'packages');
  const entries = await readdir(packagesDir, { withFileTypes: true });
  const found: Array<{ name: string; dir: string }> = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(packagesDir, entry.name);
    let raw: string;
    try {
      raw = await readFile(path.join(dir, 'package.json'), 'utf8');
    } catch {
      continue;
    }
    const manifest = JSON.parse(raw) as Manifest;
    if (manifest.private) continue;
    found.push({ name: manifest.name, dir });
  }

  return found.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Pack every published package into a consumer-shaped layout: tarball contents
 * under `node_modules/<name>`, declared runtime dependencies symlinked as
 * siblings. Nothing else is reachable, so an import of an undeclared dependency
 * fails here exactly as it would for a user.
 */
export async function packAll(
  packages: Array<{ name: string; dir: string }>,
): Promise<PackedPackage[]> {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), 'ff-packaging-'));
  scratchRoots.push(root);
  return Promise.all(packages.map((pkg) => packOne(pkg, root)));
}

export async function cleanupPacked(): Promise<void> {
  await Promise.all(scratchRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
}

async function packOne(pkg: { name: string; dir: string }, root: string): Promise<PackedPackage> {
  const workspace = path.join(root, path.basename(pkg.dir));
  const tarballDir = path.join(workspace, 'tarball');
  const consumerDir = path.join(workspace, 'consumer');
  const nodeModules = path.join(consumerDir, 'node_modules');
  const installDir = path.join(nodeModules, pkg.name);

  // `pnpm test:packaging` builds first, so a missing dist means someone ran
  // vitest directly. Say so, rather than packing an empty tarball and failing
  // every subpath assertion downstream.
  if (!existsSync(path.join(pkg.dir, 'dist'))) {
    throw new Error(`${pkg.name}: dist/ is missing. Run \`pnpm build\` first.`);
  }

  await mkdir(tarballDir, { recursive: true });
  await mkdir(installDir, { recursive: true });

  await exec('pnpm', ['pack', '--pack-destination', tarballDir], { cwd: pkg.dir });
  const tarball = (await readdir(tarballDir)).find((file) => file.endsWith('.tgz'));
  if (!tarball) {
    throw new Error(`${pkg.name}: pnpm pack produced no tarball in ${tarballDir}`);
  }

  // Drop the tarball's leading `package/` so installDir mirrors an
  // installed package root.
  await exec('tar', [
    '-xzf',
    path.join(tarballDir, tarball),
    '-C',
    installDir,
    '--strip-components=1',
  ]);

  const packedManifest = JSON.parse(
    await readFile(path.join(installDir, 'package.json'), 'utf8'),
  ) as Manifest;

  await linkRuntimeDependencies(pkg.dir, nodeModules, packedManifest);

  await writeFile(
    path.join(consumerDir, 'package.json'),
    `${JSON.stringify({ name: 'packaging-probe', private: true, type: 'module' }, null, 2)}\n`,
  );
  await writeFile(
    path.join(consumerDir, 'probe.mjs'),
    await readFile(path.join(FIXTURES, 'probe.mjs'), 'utf8'),
  );

  return {
    name: pkg.name,
    sourceDir: pkg.dir,
    packedManifest,
    installDir,
    consumerDir,
    packedFiles: await walk(installDir),
  };
}

async function linkRuntimeDependencies(
  sourceDir: string,
  nodeModules: string,
  manifest: Manifest,
): Promise<void> {
  const required = Object.keys(manifest.dependencies ?? {});
  const optionalPeers = new Set(
    Object.entries(manifest.peerDependenciesMeta ?? {})
      .filter(([, meta]) => meta.optional)
      .map(([name]) => name),
  );
  const peers = Object.keys(manifest.peerDependencies ?? {});

  for (const dep of new Set([...required, ...peers])) {
    const source = path.join(sourceDir, 'node_modules', dep);
    let target: string;
    try {
      // Point at the store, not pnpm's symlink: transitive deps resolve from
      // there without installing anything.
      target = await realpath(source);
    } catch {
      if (optionalPeers.has(dep)) continue;
      throw new Error(
        `${manifest.name}: declared dependency "${dep}" is not installed at ${source}. ` +
          'Run `pnpm install` before the packaging tests.',
      );
    }
    const link = path.join(nodeModules, dep);
    await mkdir(path.dirname(link), { recursive: true });
    await symlink(target, link, 'dir');
  }
}

/**
 * Run the consumer-side probe against a packed package.
 *
 * A stub applies to every import in the probe process, so stubbed and unstubbed
 * targets must go in separate invocations.
 */
export async function runProbe(
  pkg: PackedPackage,
  targets: ProbeTarget[],
  stubs: Record<string, string> = {},
): Promise<Map<string, ProbeResult>> {
  if (targets.length === 0) return new Map();
  const { stdout } = await exec(
    process.execPath,
    ['probe.mjs', JSON.stringify(targets), JSON.stringify(stubs)],
    { cwd: pkg.consumerDir, maxBuffer: 64 * 1024 * 1024 },
  );
  const results = JSON.parse(stdout) as ProbeResult[];
  return new Map(results.map((result) => [result.specifier, result]));
}

/** Read a world's tsdown `entry` map by evaluating its config in plain Node. */
export async function readTsdownEntries(sourceDir: string): Promise<Record<string, string>> {
  const configPath = path.join(sourceDir, 'tsdown.config.ts');
  const { stdout } = await exec(
    process.execPath,
    [path.join(FIXTURES, 'read-tsdown-entry.mjs'), pathToFileURL(configPath).href],
    { cwd: sourceDir },
  );
  const entries = JSON.parse(stdout) as Array<Record<string, string> | string[] | null>;

  const merged: Record<string, string> = {};
  for (const entry of entries) {
    if (entry === null || Array.isArray(entry)) {
      throw new Error(
        `${configPath}: expected an object \`entry\` map so build outputs have stable names, got ${JSON.stringify(entry)}`,
      );
    }
    Object.assign(merged, entry);
  }
  return merged;
}

/** All file targets reachable from an exports entry, across every condition. */
export function collectExportTargets(entry: ExportsEntry, out = new Set<string>()): Set<string> {
  if (entry === null) return out;
  if (typeof entry === 'string') {
    out.add(entry);
    return out;
  }
  for (const value of Object.values(entry)) collectExportTargets(value, out);
  return out;
}

/** The target a runtime `import` resolves to, ignoring the `types` condition. */
export function runtimeExportTarget(entry: ExportsEntry): string | null {
  if (entry === null) return null;
  if (typeof entry === 'string') return entry;
  for (const [condition, value] of Object.entries(entry)) {
    if (condition === 'types') continue;
    const target = runtimeExportTarget(value);
    if (target) return target;
  }
  return null;
}

/** Expand a wildcard subpath (`./migrations/*.sql`) into concrete subpaths. */
export function expandSubpath(
  subpath: string,
  entry: ExportsEntry,
  packedFiles: string[],
): string[] {
  if (!subpath.includes('*')) return [subpath];

  const target = runtimeExportTarget(entry);
  if (!target || !target.includes('*')) {
    throw new Error(`Wildcard subpath "${subpath}" maps to a non-wildcard target ${target}`);
  }

  // Node's exports spec allows exactly one `*`. Splitting on more would
  // silently drop segments and under-report what the package exposes.
  const parts = target.split('*');
  if (parts.length !== 2) {
    throw new Error(
      `Exports target "${target}" must contain exactly one "*", found ${parts.length - 1}`,
    );
  }

  const [prefix, suffix] = parts;
  return packedFiles
    .map((file) => `./${file}`)
    .filter((file) => file.startsWith(prefix) && file.endsWith(suffix))
    .map((file) => subpath.replace('*', file.slice(prefix.length, file.length - suffix.length)));
}

/** Every file under `dir`, as posix paths relative to it. */
async function walk(dir: string, base = dir): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(full, base)));
    } else {
      files.push(path.relative(base, full).split(path.sep).join('/'));
    }
  }
  return files.sort();
}

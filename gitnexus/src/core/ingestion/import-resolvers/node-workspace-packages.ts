/**
 * In-repo `package.json` manifests, as module-resolution input (#2953).
 *
 * A bare specifier (`@acme/telemetry/nest`, `@repo/utils`, `lodash/fp`) names a
 * PACKAGE, not a path, and the manifest is the only thing that says which
 * packages exist and where their entry points are. Without it a resolver can do
 * nothing but guess — which is what the old suffix matcher did, landing
 * `@acme/telemetry/nest` on the repo's only path ending in `nest/index.ts`
 * while `@repo/utils`, a real first-party package, resolved to nothing because
 * its name appears in no file path at all.
 *
 * Both directions come from the same missing input, so both are fixed by
 * reading it: every in-repo `package.json` contributes its `name`, its `exports`
 * map (including subpath patterns), its legacy entry fields, and its `imports`
 * map for `#`-prefixed specifiers.
 */

import fs from 'fs/promises';
import path from 'path';

import { isHardcodedIgnoredDirectory } from '../../../config/ignore-service.js';
import { logger } from '../../logger.js';
import { resolveFile } from '../languages/typescript/file-candidates.js';

/** One in-repo package. */
export interface NodeWorkspacePackage {
  /** Repo-relative directory holding the `package.json` (`''` for the root). */
  readonly dir: string;
  /**
   * Repo-relative entry stems for the package root (`import '@repo/utils'`),
   * best first: declared `exports["."]`, then `module` / `main` / `types`, then
   * the conventional `src/index` and `index`.
   *
   * A published `dist/...` entry simply fails to match an indexed source file
   * (build output is not indexed) and the next candidate is tried, which is why
   * the conventional fallbacks stay at the end rather than being a guess: they
   * are what the package resolves to when it is consumed from source, which in
   * a workspace it always is.
   */
  readonly entries: readonly string[];
  /**
   * Declared `exports` subpaths, specifier suffix -> repo-relative stems.
   * Keys are as written minus the leading `./`, so `"./nest"` is stored `nest`;
   * a pattern key keeps its `*` (`"./features/*"` -> `features/*`).
   */
  readonly subpathExports: ReadonlyMap<string, readonly string[]>;
  /** Declared `imports` map, `#name` -> repo-relative stems. */
  readonly subpathImports: ReadonlyMap<string, readonly string[]>;
}

export interface NodeWorkspacePackages {
  /** Package name (`@repo/utils`, `utils`) -> that package. */
  readonly byName: ReadonlyMap<string, NodeWorkspacePackage>;
}

const SCAN_MAX_DIRS = 20_000;
const SCAN_MAX_DEPTH = 24;

/**
 * The package name a bare specifier addresses, or `null` when the specifier
 * names a path rather than a package.
 *
 * `@acme/telemetry/nest` -> `@acme/telemetry`, `lodash/fp` -> `lodash`.
 */
export function nodePackageNameOf(specifier: string): string | null {
  if (specifier === '' || specifier.startsWith('.') || specifier.startsWith('/')) return null;
  if (specifier.startsWith('#')) return null;
  if (specifier.startsWith('@')) {
    const parts = specifier.split('/');
    return parts.length >= 2 && parts[0].length > 1 && parts[1] !== ''
      ? `${parts[0]}/${parts[1]}`
      : null;
  }
  return specifier.split('/')[0] || null;
}

/** The in-repo package whose directory most closely contains `filePath`. */
export function owningPackage(
  filePath: string,
  packages: NodeWorkspacePackages | null | undefined,
): NodeWorkspacePackage | null {
  if (!packages) return null;
  let best: NodeWorkspacePackage | null = null;
  for (const pkg of packages.byName.values()) {
    const inside = pkg.dir === '' || filePath.startsWith(`${pkg.dir}/`);
    if (inside && (best === null || pkg.dir.length > best.dir.length)) best = pkg;
  }
  return best;
}

/**
 * Resolve a bare specifier that names an in-repo package.
 *
 * `null` means the specifier names no in-repo package — an external dependency,
 * whose correct in-repo resolution is nothing — or names one that does not
 * export the requested subpath.
 */
export function resolveNodeWorkspaceImport(
  specifier: string,
  packages: NodeWorkspacePackages | null | undefined,
  allFiles: ReadonlySet<string>,
): string | null {
  if (!packages) return null;
  const packageName = nodePackageNameOf(specifier);
  if (packageName === null) return null;
  const pkg = packages.byName.get(packageName);
  if (pkg === undefined) return null;

  const subpath = specifier.slice(packageName.length).replace(/^\//, '');
  for (const stem of entryStemsFor(pkg, subpath)) {
    const hit = resolveFile(stem, allFiles);
    if (hit !== null) return hit;
  }
  return null;
}

/** Candidate stems for one specifier into `pkg`, best first. */
function entryStemsFor(pkg: NodeWorkspacePackage, subpath: string): readonly string[] {
  if (subpath === '') return pkg.entries;

  const exact = pkg.subpathExports.get(subpath);
  if (exact !== undefined) return exact;

  // Pattern exports: `"./features/*": "./src/features/*.ts"`. Longest literal
  // prefix wins, matching Node's own subpath-pattern precedence.
  const patterns = [...pkg.subpathExports.entries()]
    .filter(([key]) => key.includes('*'))
    .map(([key, stems]) => {
      const star = key.indexOf('*');
      return { prefix: key.slice(0, star), suffix: key.slice(star + 1), stems };
    })
    .filter(
      ({ prefix, suffix }) =>
        subpath.startsWith(prefix) &&
        subpath.endsWith(suffix) &&
        subpath.length >= prefix.length + suffix.length,
    )
    .sort((a, b) => b.prefix.length - a.prefix.length);

  for (const { prefix, suffix, stems } of patterns) {
    const stem = subpath.slice(prefix.length, subpath.length - suffix.length);
    return stems.map((s) => s.replace('*', stem));
  }

  // A package with NO `exports` map is not restricted: Node resolves any
  // subpath against its directory. A package WITH one exposes only what it
  // lists, so an unlisted subpath resolves to nothing — that restriction is
  // real, and honouring it is part of the difference between resolving and
  // guessing.
  if (pkg.subpathExports.size > 0) return [];
  return [joinRepoPath(pkg.dir, subpath), joinRepoPath(pkg.dir, `src/${subpath}`)];
}

/**
 * Collect every in-repo `package.json`.
 *
 * Directory-only BFS: the sole files opened are manifests, so this is far
 * cheaper than the C# namespace scan next door, which reads every `.cs` file.
 */
export async function loadNodeWorkspacePackages(
  repoRoot: string,
): Promise<NodeWorkspacePackages | null> {
  const byName = new Map<string, NodeWorkspacePackage>();
  const queue: { dir: string; depth: number }[] = [{ dir: repoRoot, depth: 0 }];
  let dirsScanned = 0;

  while (queue.length > 0) {
    if (dirsScanned >= SCAN_MAX_DIRS) {
      logger.warn(
        `[node] package.json scan of ${repoRoot} hit the ${SCAN_MAX_DIRS}-directory cap; workspace packages below it will not resolve`,
      );
      break;
    }
    const { dir, depth } = queue.shift()!;
    dirsScanned++;

    let entries: import('fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (isHardcodedIgnoredDirectory(entry.name)) continue;
        if (depth < SCAN_MAX_DEPTH) {
          queue.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
        }
        continue;
      }
      if (!entry.isFile() || entry.name !== 'package.json') continue;

      const pkg = await readManifest(path.join(dir, entry.name), repoRoot, dir);
      // First declaration wins: BFS visits shallower directories first, so a
      // top-level package outranks a nested one that reuses the name.
      if (pkg !== null && !byName.has(pkg.name)) byName.set(pkg.name, pkg.package);
    }
  }

  return byName.size === 0 ? null : { byName };
}

async function readManifest(
  manifestPath: string,
  repoRoot: string,
  dir: string,
): Promise<{ name: string; package: NodeWorkspacePackage } | null> {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(await fs.readFile(manifestPath, 'utf-8')) as Record<string, unknown>;
  } catch {
    return null;
  }
  const name = typeof parsed.name === 'string' ? parsed.name : '';
  if (name === '') return null;

  const relDir = path.relative(repoRoot, dir).split(path.sep).join('/');
  const packageDir = relDir === '.' ? '' : relDir;
  const rebase = (raw: string): string => joinRepoPath(packageDir, stripEntryPrefixes(raw));

  const subpathExports = new Map<string, readonly string[]>();
  const rootExports: string[] = [];
  collectExports(parsed.exports, subpathExports, rootExports, rebase);

  const entries: string[] = [...rootExports];
  for (const field of ['module', 'main', 'types', 'typings']) {
    const value = parsed[field];
    if (typeof value === 'string') push(entries, rebase(value));
  }
  for (const conventional of ['src/index', 'index', 'lib/index']) {
    push(entries, joinRepoPath(packageDir, conventional));
  }

  const subpathImports = new Map<string, readonly string[]>();
  collectImports(parsed.imports, subpathImports, rebase);

  return { name, package: { dir: packageDir, entries, subpathExports, subpathImports } };
}

/**
 * Walk an `exports` value into the root-entry list and the subpath map.
 *
 * `exports` nests three ways at once — a bare string, a subpath map, and
 * condition maps (`import` / `require` / `types` / `default`) at any depth — so
 * this collects string leaves per subpath rather than assuming a shape.
 */
function collectExports(
  node: unknown,
  subpaths: Map<string, readonly string[]>,
  rootStems: string[],
  rebase: (raw: string) => string,
  currentSubpath: string | null = '',
): void {
  if (typeof node === 'string') {
    if (currentSubpath === null) return;
    if (currentSubpath === '') {
      push(rootStems, rebase(node));
      return;
    }
    subpaths.set(currentSubpath, [...(subpaths.get(currentSubpath) ?? []), rebase(node)]);
    return;
  }
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return;

  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key.startsWith('.')) {
      // A subpath key: `"."` is the package root, `"./nest"` the subpath `nest`.
      collectExports(
        value,
        subpaths,
        rootStems,
        rebase,
        key === '.' ? '' : key.replace(/^\.\//, ''),
      );
    } else {
      // A condition key — stays on whatever subpath we were already resolving.
      collectExports(value, subpaths, rootStems, rebase, currentSubpath);
    }
  }
}

/** Walk an `imports` map (`"#env": "./src/env.node.ts"`) into stems. */
function collectImports(
  node: unknown,
  out: Map<string, readonly string[]>,
  rebase: (raw: string) => string,
  currentKey: string | null = null,
): void {
  if (typeof node === 'string') {
    if (currentKey === null) return;
    out.set(currentKey, [...(out.get(currentKey) ?? []), rebase(node)]);
    return;
  }
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    collectImports(value, out, rebase, key.startsWith('#') ? key : currentKey);
  }
}

/** `"./src/index.ts"` -> `"src/index"`; leaves an extension-less path alone. */
function stripEntryPrefixes(entry: string): string {
  const withoutDot = entry.replace(/^\.\//, '').replace(/^\//, '');
  return withoutDot.replace(/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|vue)$/, '');
}

function push(list: string[], value: string): void {
  if (value !== '' && !list.includes(value)) list.push(value);
}

function joinRepoPath(dir: string, rest: string): string {
  return dir === '' ? rest : `${dir}/${rest}`;
}

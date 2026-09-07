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
import { createRequire } from 'node:module';

import { isHardcodedIgnoredDirectoryAtPath } from '../../../config/ignore-service.js';
import { logger } from '../../logger.js';
import { resolveFile } from '../languages/typescript/file-candidates.js';

// `js-yaml` is CJS; the rest of this repository reaches it the same way
// (`core/group/config-parser.ts`, `cli/group.ts`).
const _require = createRequire(import.meta.url);
const yaml = _require('js-yaml') as typeof import('js-yaml');

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

/**
 * Look a specifier up in a subpath map — `exports` or `imports`, which share
 * Node's matching rule exactly: an exact key wins, otherwise the pattern with
 * the longest literal prefix does, and its `*` takes whatever the specifier put
 * there.
 *
 * Shared because they diverged once: the `imports` side did an exact lookup
 * only, so a declared `"#internal/*"` could never match `#internal/foo`.
 */
export function matchSubpathMap(
  map: ReadonlyMap<string, readonly string[]>,
  specifier: string,
): readonly string[] | null {
  const exact = map.get(specifier);
  if (exact !== undefined) return exact;

  const patterns = [...map.entries()]
    .filter(([key]) => key.includes('*'))
    .map(([key, stems]) => {
      const star = key.indexOf('*');
      return { prefix: key.slice(0, star), suffix: key.slice(star + 1), stems };
    })
    .filter(
      ({ prefix, suffix }) =>
        specifier.startsWith(prefix) &&
        specifier.endsWith(suffix) &&
        specifier.length >= prefix.length + suffix.length,
    )
    .sort((a, b) => b.prefix.length - a.prefix.length);

  for (const { prefix, suffix, stems } of patterns) {
    const stem = specifier.slice(prefix.length, specifier.length - suffix.length);
    return stems.map((target) => substituteStar(target, stem));
  }
  return null;
}

/**
 * Substitute a subpath pattern's single `*`.
 *
 * Node's subpath patterns and TypeScript's `paths` both allow AT MOST one `*`,
 * so replacing the first occurrence is the specified behaviour rather than a
 * partial one — but `String.replace` with a string needle says that only by
 * accident, and reads as a bug to anyone (CodeQL included) who has met the
 * replace-all footgun. Slicing at the known index states the rule instead.
 */
export function substituteStar(target: string, stem: string): string {
  const star = target.indexOf('*');
  return star === -1 ? target : target.slice(0, star) + stem + target.slice(star + 1);
}

/** Candidate stems for one specifier into `pkg`, best first. */
function entryStemsFor(pkg: NodeWorkspacePackage, subpath: string): readonly string[] {
  if (subpath === '') return pkg.entries;

  const declared = matchSubpathMap(pkg.subpathExports, subpath);
  if (declared !== null) return declared;

  // A package with NO `exports` map is not restricted: Node resolves any
  // subpath against the package DIRECTORY, and only against it. A package WITH
  // one exposes only what it lists, so an unlisted subpath resolves to nothing.
  //
  // Both restrictions are real, and neither is softened here. An earlier draft
  // also tried `<dir>/src/<subpath>`, on the theory that a workspace package is
  // consumed from source — but nothing declares that mapping, so it is the same
  // kind of guess this module exists to remove: it would resolve
  // `@repo/utils/deep/thing` to `packages/utils/src/deep/thing.ts` for a
  // package whose manifest never said `deep/thing` lives under `src/`, and the
  // import would be broken in the real project too.
  if (pkg.subpathExports.size > 0) return [];
  return [joinRepoPath(pkg.dir, subpath)];
}

/**
 * The directories the workspace ADMITS as packages.
 *
 * `null` means the repository declares no workspace at all, in which case the
 * only package is the one at the root — a nested `package.json` somewhere in
 * `examples/` or `test/fixtures/` is not a member of anything and its name is
 * not addressable by an import.
 *
 * This gate is the difference between reading manifests and trusting them.
 * Without it, finding a `package.json` anywhere in the tree was enough to
 * register its name, which recreates the false-positive half of #2953 from a
 * different source: an app importing registry package `foo` would bind to an
 * excluded fixture that happens to declare `name: "foo"`. THIS repository is
 * the example — `test/fixtures/**` alone declares `@repo/utils` (added by this
 * very change) among others.
 */
interface WorkspaceScope {
  /** Positive patterns, repo-relative, as declared. */
  readonly include: readonly string[];
  /** `!`-prefixed patterns, with the `!` stripped. */
  readonly exclude: readonly string[];
}

/** Whether `dir` (repo-relative, `''` for the root) is an admitted package. */
function admits(scope: WorkspaceScope | null, dir: string): boolean {
  // The root package is always itself, workspace or not.
  if (dir === '') return true;
  if (scope === null) return false;
  if (scope.exclude.some((pattern) => globToRegExp(pattern).test(dir))) return false;
  return scope.include.some((pattern) => globToRegExp(pattern).test(dir));
}

/**
 * Match one workspace glob.
 *
 * The subset npm, pnpm, yarn and lerna actually use in `workspaces` /
 * `packages`: `*` within a segment, `**` across segments, `?`, and a leading
 * `!` for exclusion (handled by the caller). Deliberately not a general glob
 * engine — the patterns are a documented, narrow dialect, and `minimatch` is
 * only present here transitively through `glob`.
 */
function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.replace(/^\.\//, '').replace(/\/$/, '');
  let out = '';
  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized[i];
    if (ch === '*') {
      if (normalized[i + 1] === '*') {
        // `**/` may match nothing at all, so `packages/**/x` also matches
        // `packages/x`; a trailing `**` matches any depth below.
        if (normalized[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
      continue;
    }
    if (ch === '?') {
      out += '[^/]';
      continue;
    }
    out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

/**
 * Read the repository's workspace declaration.
 *
 * All three spellings are read and merged, because a repo may carry more than
 * one (a pnpm workspace whose root `package.json` also lists `workspaces` for
 * tooling that does not read pnpm's file).
 */
async function loadWorkspaceScope(repoRoot: string): Promise<WorkspaceScope | null> {
  const patterns: string[] = [];

  const rootManifest = await readJsonFile(path.join(repoRoot, 'package.json'));
  const workspaces = rootManifest?.workspaces;
  if (Array.isArray(workspaces)) {
    patterns.push(...workspaces.filter((w): w is string => typeof w === 'string'));
  } else if (workspaces !== null && typeof workspaces === 'object') {
    // Yarn's object form: `{ "packages": [...], "nohoist": [...] }`.
    const nested = (workspaces as { packages?: unknown }).packages;
    if (Array.isArray(nested)) {
      patterns.push(...nested.filter((w): w is string => typeof w === 'string'));
    }
  }

  patterns.push(...(await readYamlPackages(path.join(repoRoot, 'pnpm-workspace.yaml'))));
  patterns.push(...(await readYamlPackages(path.join(repoRoot, 'pnpm-workspace.yml'))));

  const lerna = await readJsonFile(path.join(repoRoot, 'lerna.json'));
  if (Array.isArray(lerna?.packages)) {
    patterns.push(...lerna.packages.filter((w): w is string => typeof w === 'string'));
  }

  if (patterns.length === 0) return null;
  return {
    include: patterns.filter((p) => !p.startsWith('!')),
    exclude: patterns.filter((p) => p.startsWith('!')).map((p) => p.slice(1)),
  };
}

async function readJsonFile(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf-8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function readYamlPackages(filePath: string): Promise<string[]> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf-8');
  } catch {
    return [];
  }
  try {
    const parsed = yaml.load(raw) as { packages?: unknown } | null;
    const packages = parsed?.packages;
    return Array.isArray(packages)
      ? packages.filter((p): p is string => typeof p === 'string')
      : [];
  } catch {
    return [];
  }
}

/**
 * Collect the `package.json` of every ADMITTED workspace package.
 *
 * Directory-only BFS: the sole files opened are manifests and the workspace
 * declaration, so this is far cheaper than the C# namespace scan next door,
 * which reads every `.cs` file.
 */
export async function loadNodeWorkspacePackages(
  repoRoot: string,
): Promise<NodeWorkspacePackages | null> {
  const scope = await loadWorkspaceScope(repoRoot);
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
        const childDir = path.join(dir, entry.name);
        if (isHardcodedIgnoredDirectoryAtPath(repoRoot, childDir)) continue;
        if (depth < SCAN_MAX_DEPTH) {
          queue.push({ dir: childDir, depth: depth + 1 });
        }
        continue;
      }
      if (!entry.isFile() || entry.name !== 'package.json') continue;

      const relDir = repoRelativeDir(repoRoot, dir);
      // Found is not the same as admitted. A manifest outside the declared
      // workspace belongs to something this repository does not build — a
      // fixture, an example, a vendored copy — and its name is not addressable.
      if (!admits(scope, relDir)) continue;

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

  const packageDir = repoRelativeDir(repoRoot, dir);
  const rebase = (raw: string): string => joinRepoPath(packageDir, stripEntryPrefixes(raw));

  const subpathExports = new Map<string, readonly string[]>();
  const rootExports: string[] = [];
  collectExports(parsed.exports, subpathExports, rootExports, rebase);

  // `exports`, when present, is the package's ENTIRE public interface: Node
  // ignores `main` outright and refuses any subpath the map does not list. This
  // resolver already honoured that restriction for subpaths (`entryStemsFor`)
  // and not for the ROOT, which is the same rule — so a manifest exporting only
  // `"./feature"` still answered a bare `@repo/pkg` with `src/index`, an edge
  // for an import that does not resolve in the real project.
  const declaresExports = parsed.exports !== undefined && parsed.exports !== null;
  const entries: string[] = [...rootExports];
  if (!declaresExports) {
    for (const field of ['module', 'main', 'types', 'typings']) {
      const value = parsed[field];
      if (typeof value === 'string') push(entries, rebase(value));
    }
    for (const conventional of ['src/index', 'index', 'lib/index']) {
      push(entries, joinRepoPath(packageDir, conventional));
    }
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
  // An array is an ordered FALLBACK LIST, not an opaque value: Node tries each
  // entry in turn. `{"./feature": ["./dist/feature.js", "./src/feature.ts"]}` is
  // the shape a workspace package publishes to say "built output, or source" —
  // and the source arm is the one that matters here, because `dist/` is build
  // output and is not indexed. Skipping arrays dropped the declaration entirely
  // and left the package looking as though it declared no subpath exports.
  if (Array.isArray(node)) {
    for (const element of node)
      collectExports(element, subpaths, rootStems, rebase, currentSubpath);
    return;
  }
  if (node === null || typeof node !== 'object') return;

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
  // Same ordered-fallback rule as `exports` — see `collectExports`.
  if (Array.isArray(node)) {
    for (const element of node) collectImports(element, out, rebase, currentKey);
    return;
  }
  if (node === null || typeof node !== 'object') return;
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

/** `/repo/packages/utils` -> `packages/utils`; the root -> `''`. */
function repoRelativeDir(repoRoot: string, dir: string): string {
  const rel = path.relative(repoRoot, dir).split(path.sep).join('/');
  return rel === '.' ? '' : rel;
}

function joinRepoPath(dir: string, rest: string): string {
  return dir === '' ? rest : `${dir}/${rest}`;
}

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
import type Parser from 'tree-sitter';

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
  readonly includeRe: readonly RegExp[];
  readonly excludeRe: readonly RegExp[];
}

/** Whether `dir` (repo-relative, `''` for the root) is an admitted package. */
function admits(scope: WorkspaceScope | null, dir: string): boolean {
  // The root package is always itself, workspace or not.
  if (dir === '') return true;
  if (scope === null) return false;
  // An exclusion covers the directory AND everything under it: `!packages/legacy`
  // must keep `packages/legacy/foo` out even when a nested workspace root inside
  // the excluded subtree re-declares `packages/*`.
  if (scope.excludeRe.some((re) => matchesDirOrAncestor(re, dir))) return false;
  return scope.includeRe.some((re) => re.test(dir));
}

function matchesDirOrAncestor(re: RegExp, dir: string): boolean {
  let current = dir;
  while (current !== '') {
    if (re.test(current)) return true;
    const slash = current.lastIndexOf('/');
    current = slash === -1 ? '' : current.slice(0, slash);
  }
  return false;
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
  // Every workspace ROOT in the repo, not just the top level. keycloak keeps its
  // JavaScript workspace at `js/pnpm-workspace.yaml`; reading only the repo root
  // found no workspace, admitted no package, and `@keycloak/keycloak-ui-shared`
  // (780–845 raw calls per SHA) resolved 7 times. Patterns from a nested root
  // are rebased onto that root so `packages/*` under `js/` admits `js/packages/x`.
  //
  // Gated, though: a nested root counts only when the repo root declares NO
  // workspace (keycloak), or when the nested root's directory is itself admitted
  // by the root's scope. Unioning every nested root unconditionally let an
  // `examples/*/package.json` starter (turborepo/vite/nuxt templates carry
  // `workspaces`) admit its example packages — and, being shallow, outrank the
  // real package of the same name — and let a root inside an excluded subtree
  // re-admit what the outer `!exclusion` had removed.
  const [rootPatterns, workspaceRoots] = await Promise.all([
    readWorkspacePatternsAt(repoRoot),
    findWorkspaceRoots(repoRoot),
  ]);
  const rootScope = rootPatterns.length === 0 ? null : toScope(rootPatterns);
  const patterns: string[] = [...rootPatterns];
  const admitted: { root: string; prefix: string }[] = [];
  for (const root of workspaceRoots) {
    if (root === repoRoot) continue;
    const prefix = repoRelativeDir(repoRoot, root);
    if (rootScope !== null && !admits(rootScope, prefix)) continue;
    admitted.push({ root, prefix });
  }
  const nested = await Promise.all(
    admitted.map(async ({ root, prefix }) => {
      const rebase = (p: string): string => {
        const negated = p.startsWith('!');
        const body = negated ? p.slice(1) : p;
        const joined = prefix === '' ? body : `${prefix}/${body.replace(/^\.\//, '')}`;
        return negated ? `!${joined}` : joined;
      };
      return (await readWorkspacePatternsAt(root)).map(rebase);
    }),
  );
  for (const batch of nested) patterns.push(...batch);

  if (patterns.length === 0) return null;
  return toScope(patterns);
}

function toScope(patterns: readonly string[]): WorkspaceScope {
  const include = patterns.filter((p) => !p.startsWith('!'));
  const exclude = patterns.filter((p) => p.startsWith('!')).map((p) => p.slice(1));
  return {
    include,
    exclude,
    includeRe: include.map(globToRegExp),
    excludeRe: exclude.map(globToRegExp),
  };
}

/** The workspace patterns declared at ONE directory, all three spellings merged. */
async function readWorkspacePatternsAt(root: string): Promise<string[]> {
  const [rootManifest, yamlPkgs, ymlPkgs, lerna] = await Promise.all([
    readJsonFile(path.join(root, 'package.json')),
    readYamlPackages(path.join(root, 'pnpm-workspace.yaml')),
    readYamlPackages(path.join(root, 'pnpm-workspace.yml')),
    readJsonFile(path.join(root, 'lerna.json')),
  ]);
  const patterns: string[] = [];
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
  patterns.push(...yamlPkgs, ...ymlPkgs);
  if (Array.isArray(lerna?.packages)) {
    patterns.push(...lerna.packages.filter((w): w is string => typeof w === 'string'));
  }
  return patterns;
}

/**
 * Directories that declare a workspace: the repo root plus any directory (to a
 * shallow depth — workspace roots sit near the top) holding a
 * `pnpm-workspace.yaml`, a `lerna.json`, or a `package.json` with `workspaces`.
 */
const WORKSPACE_ROOT_MAX_DEPTH = 4;
/**
 * Bound on the depth-≤4 directory walk. Generous on purpose: the previous 2,000
 * cap tripped silently in readdir order, so WHICH packages existed — and which
 * imports resolved — varied between two checkouts of the same commit. Tripping
 * it now warns, so a truncated scan is a logged fact rather than a quiet one.
 */
const WORKSPACE_ROOT_SCAN_MAX_DIRS = 50_000;
/**
 * Directory names whose nested `workspaces` are starters, fixtures, or test
 * trees — never members. A leftover `test/pnpm-workspace.yaml` must not become
 * a workspace root when the repo root declares none (the #2953 first-wins
 * class). A root `workspaces` glob that lists `test/*` still admits those
 * packages through the package.json walk; this set only stops nested-root
 * discovery from descending into those names.
 */
const NON_MEMBER_ROOT_DIRS = new Set([
  'example',
  'examples',
  'fixture',
  'fixtures',
  'template',
  'templates',
  'sample',
  'samples',
  'test',
  'tests',
  'e2e',
  '__tests__',
  'spec',
  'specs',
]);

/**
 * Vite's `DEFAULT_CONFIG_FILES` order. The first filename that exists is the
 * config Vite loads; leftover siblings are not a second live entry.
 */
const VITE_CONFIG_FILES = [
  'vite.config.js',
  'vite.config.mjs',
  'vite.config.ts',
  'vite.config.cjs',
  'vite.config.mts',
  'vite.config.cts',
] as const;

function isMissingPath(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === 'ENOENT';
}

async function readDirSorted(dir: string): Promise<import('fs').Dirent[] | null> {
  try {
    return (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
  } catch {
    return null;
  }
}

async function findWorkspaceRoots(repoRoot: string): Promise<string[]> {
  const roots: string[] = [repoRoot];
  const queue: { dir: string; depth: number }[] = [{ dir: repoRoot, depth: 0 }];
  let scanned = 0;
  while (scanned < queue.length) {
    if (scanned >= WORKSPACE_ROOT_SCAN_MAX_DIRS) {
      logger.warn(
        `[node] workspace-root scan of ${repoRoot} hit the ${WORKSPACE_ROOT_SCAN_MAX_DIRS}-directory cap; nested workspace roots below it were not considered`,
      );
      break;
    }
    const { dir, depth } = queue[scanned++]!;
    const entries = await readDirSorted(dir);
    if (entries === null) continue;
    if (dir !== repoRoot) {
      const names = new Set(entries.filter((e) => e.isFile()).map((e) => e.name));
      let declares =
        names.has('pnpm-workspace.yaml') ||
        names.has('pnpm-workspace.yml') ||
        names.has('lerna.json');
      if (!declares && names.has('package.json')) {
        const manifest = await readJsonFile(path.join(dir, 'package.json'));
        declares = manifest?.workspaces !== undefined && manifest.workspaces !== null;
      }
      if (declares) roots.push(dir);
    }
    if (depth >= WORKSPACE_ROOT_MAX_DEPTH) continue;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (NON_MEMBER_ROOT_DIRS.has(entry.name.toLowerCase())) continue;
      const child = path.join(dir, entry.name);
      if (isHardcodedIgnoredDirectoryAtPath(repoRoot, child)) continue;
      queue.push({ dir: child, depth: depth + 1 });
    }
  }
  return roots;
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
 * Per-repo memo. The TS/JS/Vue scope resolvers and the unresolved-call ledger
 * classifier each ask for the same map during one analyze; without this the
 * 20k-directory walk ran once per asker (four times on a full run, one of them
 * inside the index lock). Invalidated at the start of every `runFullAnalysis`
 * so a long-lived server never serves a stale package map across runs.
 */
const workspacePackagesMemo = new Map<string, Promise<NodeWorkspacePackages | null>>();

export function invalidateNodeWorkspacePackages(repoRoot: string): void {
  workspacePackagesMemo.delete(path.resolve(repoRoot));
}

export async function loadNodeWorkspacePackages(
  repoRoot: string,
): Promise<NodeWorkspacePackages | null> {
  const key = path.resolve(repoRoot);
  const cached = workspacePackagesMemo.get(key);
  if (cached !== undefined) return cached;
  const pending: Promise<NodeWorkspacePackages | null> = loadNodeWorkspacePackagesUncached(
    repoRoot,
  ).catch((err: unknown) => {
    // Evict only OUR entry. If this load was invalidated while in flight and a
    // newer load has since been installed under the same key, deleting by key
    // alone would evict that one, and every later caller would start another
    // full scan instead of joining it.
    if (workspacePackagesMemo.get(key) === pending) workspacePackagesMemo.delete(key);
    throw err;
  });
  workspacePackagesMemo.set(key, pending);
  return pending;
}

/**
 * Collect the `package.json` of every ADMITTED workspace package.
 *
 * Directory-only BFS: the sole files opened are manifests and the workspace
 * declaration, so this is far cheaper than the C# namespace scan next door,
 * which reads every `.cs` file.
 */
async function loadNodeWorkspacePackagesUncached(
  repoRoot: string,
): Promise<NodeWorkspacePackages | null> {
  const scope = await loadWorkspaceScope(repoRoot);
  const byName = new Map<string, NodeWorkspacePackage>();
  const queue: { dir: string; depth: number }[] = [{ dir: repoRoot, depth: 0 }];
  let queueHead = 0;
  let dirsScanned = 0;

  while (queueHead < queue.length) {
    if (dirsScanned >= SCAN_MAX_DIRS) {
      logger.warn(
        `[node] package.json scan of ${repoRoot} hit the ${SCAN_MAX_DIRS}-directory cap; workspace packages below it will not resolve`,
      );
      break;
    }
    const { dir, depth } = queue[queueHead++]!;
    dirsScanned++;

    // Sorted: same-depth name collisions resolve first-wins, and readdir order
    // is filesystem-dependent.
    const entries = await readDirSorted(dir);
    if (entries === null) continue;

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
  }
  // Entry points that name BUILD OUTPUT (`main: dist/x.js`, `exports: ./dist/…`)
  // never match an indexed source file — the package's real source entry has to
  // be discovered. keycloak's `@keycloak/keycloak-ui-shared` publishes
  // `dist/keycloak-ui-shared.js` and keeps its entry in `vite.config.ts`
  // (`build.lib.entry: 'src/main.ts'`); with only the declared fields it had 7
  // resolved calls against ~845 raw. Tried in a fixed order, and ONLY appended
  // (declared entries keep precedence): `source` / `publishConfig.source`, the
  // vite `lib.entry`, then `src/main` / `src/index`. More than one candidate
  // that exists on disk is recorded as ambiguous rather than picked — a wrong
  // entry binds every import of the package to the wrong file.
  // A package whose `exports` map has no `"."` (only subpaths) refuses the bare
  // specifier outright; discovery must not manufacture a `src/index` root for it.
  const rootlessExports = declaresExports && rootExports.length === 0;
  const discovered = rootlessExports
    ? { entries: [], ambiguous: [], allowConventional: false }
    : await discoverSourceEntries(parsed, dir, repoRoot);
  for (const entry of discovered.entries) push(entries, entry);
  if (!declaresExports && discovered.allowConventional) {
    for (const conventional of ['src/index', 'index', 'lib/index']) {
      push(entries, joinRepoPath(packageDir, conventional));
    }
  }
  if (discovered.ambiguous.length > 0) {
    logger.warn(
      `[node] package ${name}: ${discovered.ambiguous.length} candidate source entries (${discovered.ambiguous.join(', ')}) — none adopted; declare \`source\` or a single lib entry`,
    );
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

/**
 * Does a declared entry point at build output rather than source? Output
 * directories and minified bundles. A plain `.js` is NOT build output on its
 * own — `main: "src/index.js"` / `index.js` is a JavaScript package's source,
 * and treating every `.js` as output ran discovery for essentially every CJS
 * package and could adopt a `src/main` beside the real entry.
 */
function looksLikeBuildOutput(entry: string): boolean {
  return /(^|\/)(dist|build|lib|out|esm|cjs|umd)\//.test(entry) || /\.min\.[cm]?js$/.test(entry);
}

function declaredRootExportStrings(exportsRoot: unknown): string[] {
  if (typeof exportsRoot === 'string') return [exportsRoot];
  if (exportsRoot === null || typeof exportsRoot !== 'object') return [];
  const dot = (exportsRoot as Record<string, unknown>)['.'];
  if (typeof dot === 'string') return [dot];
  if (dot === null || typeof dot !== 'object') return [];
  return Object.values(dot).filter((v): v is string => typeof v === 'string');
}

async function existingStems(repoRoot: string, stems: readonly string[]): Promise<string[]> {
  const present = await Promise.all(stems.map((stem) => stemExists(repoRoot, stem)));
  const existing: string[] = [];
  for (let i = 0; i < stems.length; i++) {
    if (present[i]) push(existing, stems[i]!);
  }
  return existing;
}

async function discoverSourceEntries(
  parsed: Record<string, unknown>,
  dir: string,
  repoRoot: string,
): Promise<{ entries: string[]; ambiguous: string[]; allowConventional: boolean }> {
  const packageDir = repoRelativeDir(repoRoot, dir);
  const rebase = (raw: string): string => joinRepoPath(packageDir, stripEntryPrefixes(raw));
  const declared: string[] = declaredRootExportStrings(parsed.exports);
  for (const field of ['module', 'main']) {
    const value = parsed[field];
    if (typeof value === 'string') declared.push(value);
  }
  // Only when every declared entry is build output (or nothing is declared and
  // the conventional stems are absent) does discovery run at all.
  if (declared.length > 0 && !declared.every(looksLikeBuildOutput))
    return { entries: [], ambiguous: [], allowConventional: true };

  const candidates: string[] = [];
  const source = parsed.source;
  if (typeof source === 'string') candidates.push(rebase(source));
  const publishConfig = parsed.publishConfig;
  if (publishConfig !== null && typeof publishConfig === 'object') {
    const ps = (publishConfig as Record<string, unknown>).source;
    if (typeof ps === 'string') candidates.push(rebase(ps));
  }
  let hasViteConfig = false;
  for (const cfg of VITE_CONFIG_FILES) {
    let text: string;
    try {
      text = await fs.readFile(path.join(dir, cfg), 'utf-8');
    } catch (err) {
      if (isMissingPath(err)) continue;
      // Present but unreadable: Vite still selected this filename.
      hasViteConfig = true;
      break;
    }
    hasViteConfig = true;
    try {
      const entry = await staticViteEntry(text);
      if (entry !== null) push(candidates, rebase(entry));
    } catch {
      // Parse/load failure is not a missing file — do not fall through to a leftover sibling.
    }
    break;
  }
  let existing = await existingStems(repoRoot, candidates);
  // A config we cannot establish is not evidence for a conventional entry.
  if (existing.length === 0 && !hasViteConfig) {
    existing = await existingStems(
      repoRoot,
      ['src/main', 'src/index'].map((conventional) => joinRepoPath(packageDir, conventional)),
    );
  }
  const allowConventional = !hasViteConfig && candidates.length === 0;
  if (existing.length > 1) return { entries: [], ambiguous: existing, allowConventional };
  return { entries: existing, ambiguous: [], allowConventional };
}

/** Read a literal exported build.lib.entry without evaluating repository code. */
async function staticViteEntry(text: string): Promise<string | null> {
  // Most manifests need no Vite discovery. Keep native grammars off that path.
  const [{ default: TreeSitter }, { default: grammar }, { parseSourceSafe }] = await Promise.all([
    import('tree-sitter'),
    import('tree-sitter-typescript'),
    import('../../tree-sitter/safe-parse.js'),
  ]);
  const parser = new TreeSitter();
  parser.setLanguage(grammar.typescript);
  const tree = parseSourceSafe(parser, text);
  if (tree.rootNode.hasError) return null;
  const exports = tree.rootNode.namedChildren.filter(
    (node) => node.type === 'export_statement' && node.children.some((c) => c.type === 'default'),
  );
  if (exports.length !== 1) return null;
  let config = unwrapViteDefineConfig(tree, exports[0]!.childForFieldName('value'));
  if (config === null) return null;
  for (const key of ['build', 'lib', 'entry']) config = staticObjectProperty(config, key);
  return staticStringValue(config);
}

/** Unwrap `defineConfig({...})` from Vite; refuse local or re-exported helpers. */
function unwrapViteDefineConfig(
  tree: { rootNode: Parser.SyntaxNode },
  config: Parser.SyntaxNode | null,
): Parser.SyntaxNode | null {
  if (config?.type !== 'call_expression') return config;
  if (config.childForFieldName('function')?.text !== 'defineConfig') return null;
  // A locally defined helper need not preserve its argument like Vite does.
  if (
    tree.rootNode
      .descendantsOfType(['function_declaration', 'variable_declarator'])
      .some((node) => node.childForFieldName('name')?.text === 'defineConfig')
  )
    return null;
  for (const statement of tree.rootNode.namedChildren) {
    if (statement.type !== 'import_statement') continue;
    if (!statement.descendantsOfType('identifier').some((n) => n.text === 'defineConfig')) continue;
    if (staticStringValue(statement.childForFieldName('source')) !== 'vite') return null;
    const identityImport = statement.descendantsOfType('import_specifier').some((specifier) => {
      const imported = specifier.childForFieldName('name')?.text;
      const local = specifier.childForFieldName('alias')?.text ?? imported;
      return imported === 'defineConfig' && local === 'defineConfig';
    });
    if (!identityImport) return null;
  }
  const args = config
    .childForFieldName('arguments')
    ?.namedChildren.filter((n) => n.type !== 'comment');
  if (args?.length !== 1) return null;
  return args[0]!;
}

function staticStringValue(node: Parser.SyntaxNode | null): string | null {
  if (node?.type !== 'string' || node.namedChildren.some((n) => n.type === 'escape_sequence'))
    return null;
  return node.text.slice(1, -1);
}

/** Reject computed keys, spreads and duplicate properties that could override a value. */
function staticObjectProperty(
  node: Parser.SyntaxNode | null,
  key: string,
): Parser.SyntaxNode | null {
  if (node?.type !== 'object') return null;
  let value: Parser.SyntaxNode | null = null;
  for (const member of node.namedChildren) {
    if (member.type === 'comment') continue;
    if (member.type !== 'pair') return null;
    const name = member.childForFieldName('key');
    if (name?.type !== 'property_identifier' && name?.type !== 'string') return null;
    if (name.type === 'string') {
      const property = staticStringValue(name);
      if (property === null) return null;
      if (property !== key) continue;
    } else if (name.text !== key) {
      continue;
    }
    if (value !== null) return null;
    value = member.childForFieldName('value');
  }
  return value;
}

/** A repo-relative stem exists as a source file (with any TS/JS extension). */
// The root is threaded explicitly: a module-level "current root" clobbered
// under two concurrent scans and turned an ambiguity refusal into a confident
// wrong entry (the second repo's root made one candidate "not exist").
async function stemExists(repoRoot: string, stem: string): Promise<boolean> {
  const abs = path.join(repoRoot, stem);
  for (const ext of ['', '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']) {
    try {
      const st = await fs.stat(abs + ext);
      if (st.isFile()) return true;
    } catch {
      /* try next */
    }
  }
  return false;
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

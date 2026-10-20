/**
 * Go module discovery: every `go.mod` and `go.work` in the repository.
 *
 * `loadGoModulePath` reads only the ROOT `go.mod`. A monorepo with one module
 * per service (`services/orders/go.mod`), a root module with nested modules
 * (`tools/go.mod`, k8s-style `staging/`), or a repo with no root module at all
 * then answers every import from the wrong place: with no root `go.mod` the
 * GOPATH suffix match runs, so two modules' `internal/repository` both answer
 * `…/internal/repository`; with one, imports of a nested module are "not ours"
 * and drop, while the root module's own imports match any directory ENDING in
 * the package path — the nested modules' included.
 *
 * Go itself resolves an import against modules, not directory names:
 *
 *  - a `go.mod` makes its directory a module root, and removes that subtree
 *    from every enclosing module — with or without a `go.work`;
 *  - the module providing `p` is one whose path is `p` or a prefix of it at a
 *    `/` boundary, and the package is the directory `p` minus that path under
 *    the module root. Nested module paths (`example.com/a`, `example.com/a/b`)
 *    are disjoint providers: `a/b`'s tree is not `a`'s, so the longest prefix
 *    whose directory exists is the one that answers;
 *  - a `go.work` names the workspace's main modules (`use`). It changes no
 *    module boundary; what it decides here is which of several `go.mod` files
 *    declaring the SAME path is meant, which Go otherwise refuses to build.
 *
 * Every in-repo module counts as a provider, not only the importer's own: a
 * cross-module import inside one repo is what `go.work` and `replace => ./dir`
 * exist for, and the local tree is the code it names.
 *
 * Discovery reads the scan's path list (`captureGoWorkspaceConfig`), like
 * Dart's `pubspec.yaml` capture, so the modules are the ones the analyzed file
 * set lives in and no second directory walk runs during analyze.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { walkRepositoryPaths } from '../../filesystem-walker.js';
import { isAbsoluteZigDepPath, normalizeZigDepPath } from '../../language-config.js';

/** One `go.mod`: the module path it declares and its repo-relative directory. */
export interface GoModule {
  readonly modulePath: string;
  /** Forward slashes, no trailing slash; `''` is the repository root. */
  readonly dir: string;
}

/** One `go.work`: its directory and the module directories it `use`s. */
export interface GoWorkFile {
  readonly dir: string;
  /** Repo-relative, normalized like {@link GoModule.dir}. Entries outside the
   *  repository are dropped: no file of theirs is in the analyzed set. */
  readonly use: readonly string[];
}

/** Go's resolution config: plain data, so it clones and compares by value. */
export interface GoWorkspaceConfig {
  /** Sorted by `dir`. */
  readonly modules: readonly GoModule[];
  /** Sorted by `dir`. */
  readonly workFiles: readonly GoWorkFile[];
}

/**
 * Where an import's package lives, as far as the repository's modules say.
 *
 *  - `module`: an in-repo module path owns the import. `dirs` are the package
 *    directories to try, longest module path first; empty when the owning
 *    module is ambiguous or the directory is another module's tree. The suffix
 *    match never runs for an owned path.
 *  - `external`: the importer is inside a module and no in-repo module owns
 *    the path — standard library or a dependency. Module mode never consults
 *    directory names for those.
 *  - `gopath`: the importer is outside every module and nothing owns the path,
 *    so the GOPATH-style suffix match is the only evidence left.
 */
export type GoImportLocation =
  | { readonly kind: 'module'; readonly dirs: readonly string[] }
  | { readonly kind: 'external' }
  | { readonly kind: 'gopath' };

const GO_MOD = 'go.mod';
const GO_WORK = 'go.work';

/** A `//` comment runs to the end of the line in both files. */
function stripLineComment(line: string): string {
  const comment = line.indexOf('//');
  return (comment < 0 ? line : line.slice(0, comment)).trim();
}

/** One directive argument: bare, or `"…"` / `` `…` `` quoted. */
function unquote(token: string): string {
  const quote = token[0];
  if ((quote === '"' || quote === '`') && token.length >= 2 && token.endsWith(quote)) {
    return token.slice(1, -1);
  }
  return token;
}

const MODULE_DIRECTIVE_RE = /^module\s+("[^"]+"|`[^`]+`|\S+)$/;

/** The path a `go.mod`'s `module` directive declares, or null. */
export function parseGoModulePath(goMod: string): string | null {
  for (const raw of goMod.split('\n')) {
    const match = MODULE_DIRECTIVE_RE.exec(stripLineComment(raw));
    if (match !== null) return unquote(match[1] ?? '') || null;
  }
  return null;
}

const USE_DIRECTIVE_RE = /^use\s+("[^"]+"|`[^`]+`|\S+)$/;
const USE_BLOCK_OPEN_RE = /^use\s*\($/;

/** The directories a `go.work`'s `use` directives name, as written. */
export function parseGoWorkUses(goWork: string): string[] {
  const uses: string[] = [];
  let inBlock = false;
  for (const raw of goWork.split('\n')) {
    const line = stripLineComment(raw);
    if (line === '') continue;
    if (inBlock) {
      if (line === ')') inBlock = false;
      else uses.push(unquote(line));
      continue;
    }
    if (USE_BLOCK_OPEN_RE.test(line)) {
      inBlock = true;
      continue;
    }
    const single = USE_DIRECTIVE_RE.exec(line);
    if (single !== null) uses.push(unquote(single[1] ?? ''));
  }
  return uses;
}

/** `rel` joined onto the repo-relative `base`, or null when it is absolute or
 *  escapes the repository — Swift's rule for package paths, Zig's for deps. */
function rebase(base: string, rel: string): string | null {
  if (isAbsoluteZigDepPath(rel)) return null;
  return normalizeZigDepPath(base === '' ? rel : `${base}/${rel}`);
}

/** Repo-relative parent directory of a repo-relative path; `''` at the root. */
function parentDir(filePath: string): string {
  const slash = filePath.lastIndexOf('/');
  return slash < 0 ? '' : filePath.slice(0, slash);
}

function byDir(a: { readonly dir: string }, b: { readonly dir: string }): number {
  return a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0;
}

/**
 * Capture every `go.mod` / `go.work` among the scan's paths. Null when the
 * repository declares no module: every import then takes the GOPATH match, as
 * it did with no root `go.mod`.
 *
 * A manifest that cannot be read or declares no `module` is treated as absent,
 * the rule `loadGoModulePath` applied to the root one: its files fall to the
 * enclosing module, or to GOPATH matching.
 */
export async function captureGoWorkspaceConfig(
  repoPath: string,
  filePaths: readonly string[],
): Promise<GoWorkspaceConfig | null> {
  const modules: GoModule[] = [];
  const workFiles: GoWorkFile[] = [];
  for (const filePath of filePaths) {
    const name = filePath.slice(filePath.lastIndexOf('/') + 1);
    if (name !== GO_MOD && name !== GO_WORK) continue;
    const dir = parentDir(filePath);
    let content: string;
    try {
      content = await fs.readFile(path.join(repoPath, filePath), 'utf-8');
    } catch {
      continue;
    }
    if (name === GO_MOD) {
      const modulePath = parseGoModulePath(content);
      if (modulePath !== null) modules.push({ modulePath, dir });
      continue;
    }
    const use: string[] = [];
    for (const rel of parseGoWorkUses(content)) {
      const moduleDir = rebase(dir, rel);
      if (moduleDir !== null) use.push(moduleDir);
    }
    workFiles.push({ dir, use: use.sort() });
  }
  if (modules.length === 0) return null;
  // Sorted, so the value is a function of the tree and not of listing order:
  // rename compares a refreshed config against its preview's by value.
  return { modules: modules.sort(byDir), workFiles: workFiles.sort(byDir) };
}

/** Standalone callers (rename refresh) scan with the walker the pipeline uses,
 *  so they see the same manifests analyze captured. */
export async function loadGoWorkspaceConfig(repoPath: string): Promise<GoWorkspaceConfig | null> {
  let captured: GoWorkspaceConfig | null = null;
  try {
    await walkRepositoryPaths(repoPath, undefined, {
      quiet: true,
      onPathsDiscovered: async (paths) => {
        captured = await captureGoWorkspaceConfig(repoPath, paths);
      },
    });
  } catch {
    return null;
  }
  return captured;
}

/** True for a value {@link captureGoWorkspaceConfig} produced. */
export function isGoWorkspaceConfig(value: unknown): value is GoWorkspaceConfig {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<GoWorkspaceConfig>;
  return Array.isArray(candidate.modules) && Array.isArray(candidate.workFiles);
}

/** Lookup tables over one config, built once per config object. */
interface GoWorkspaceIndex {
  readonly moduleByDir: ReadonlyMap<string, GoModule>;
  /** Module path → every module declaring it, in `dir` order. */
  readonly modulesByPath: ReadonlyMap<string, readonly GoModule[]>;
  /** `go.work` directory → the module directories it uses. */
  readonly usesByWorkDir: ReadonlyMap<string, ReadonlySet<string>>;
}

/** Keyed on the config's identity: the orchestrator threads one config object
 *  through every import of a pass, the same contract `perFileSet` relies on. */
const INDEXES = new WeakMap<GoWorkspaceConfig, GoWorkspaceIndex>();

function indexOf(config: GoWorkspaceConfig): GoWorkspaceIndex {
  const cached = INDEXES.get(config);
  if (cached !== undefined) return cached;
  const moduleByDir = new Map<string, GoModule>();
  const modulesByPath = new Map<string, GoModule[]>();
  for (const module of config.modules) {
    moduleByDir.set(module.dir, module);
    const group = modulesByPath.get(module.modulePath);
    if (group === undefined) modulesByPath.set(module.modulePath, [module]);
    else group.push(module);
  }
  const usesByWorkDir = new Map<string, ReadonlySet<string>>();
  for (const work of config.workFiles) usesByWorkDir.set(work.dir, new Set(work.use));
  const index: GoWorkspaceIndex = { moduleByDir, modulesByPath, usesByWorkDir };
  INDEXES.set(config, index);
  return index;
}

/** The entry of `byDir` at `dir` or its nearest ancestor — the `go.mod` (or
 *  `go.work`) Go would find walking up from there. O(depth). */
function nearest<T>(byDir: ReadonlyMap<string, T>, dir: string): T | undefined {
  let current = dir;
  for (;;) {
    const found = byDir.get(current);
    if (found !== undefined) return found;
    if (current === '') return undefined;
    current = parentDir(current);
  }
}

/**
 * Which of the modules declaring one path the importer means: the only one;
 * else the importer's own; else the only one its `go.work` uses. Anything else
 * is ambiguous and answers nothing — Go refuses such a build rather than pick.
 */
function pickModule(
  group: readonly GoModule[],
  own: GoModule | undefined,
  workUses: ReadonlySet<string> | undefined,
): GoModule | undefined {
  if (group.length === 1) return group[0];
  if (own !== undefined && group.includes(own)) return own;
  if (workUses === undefined) return undefined;
  const used = group.filter((module) => workUses.has(module.dir));
  return used.length === 1 ? used[0] : undefined;
}

/** Where `importPath`, imported from `fromFile`, can live. */
export function locateGoImport(
  config: GoWorkspaceConfig,
  importPath: string,
  fromFile: string,
): GoImportLocation {
  const index = indexOf(config);
  const fromDir = parentDir(fromFile.replace(/\\/g, '/'));
  const own = nearest(index.moduleByDir, fromDir);
  const workUses = nearest(index.usesByWorkDir, fromDir);

  const dirs: string[] = [];
  let owned = false;
  // Each `/`-prefix of the import path, longest first, is a candidate module
  // path: O(segments) map probes rather than a scan of every module.
  let prefix = importPath;
  for (;;) {
    const group = index.modulesByPath.get(prefix);
    if (group !== undefined) {
      owned = true;
      const module = pickModule(group, own, workUses);
      if (module !== undefined) {
        const rel = importPath.slice(prefix.length + 1);
        const dir = module.dir === '' ? rel : rel === '' ? module.dir : `${module.dir}/${rel}`;
        // A nested `go.mod` between the module root and the package takes the
        // directory out of this module.
        if (nearest(index.moduleByDir, dir) === module) dirs.push(dir);
      }
    }
    const slash = prefix.lastIndexOf('/');
    if (slash < 0) break;
    prefix = prefix.slice(0, slash);
  }

  if (owned) return { kind: 'module', dirs };
  return own === undefined ? { kind: 'gopath' } : { kind: 'external' };
}

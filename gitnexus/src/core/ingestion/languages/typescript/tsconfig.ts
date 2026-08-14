/**
 * Real `tsconfig.json` loading for module resolution (#2953).
 *
 * The previous loader (`language-config.ts:loadTsconfigPaths`) was built to feed
 * a heuristic, and it shows: it reads three filenames at the repo ROOT only,
 * gives up unless `compilerOptions.paths` exists, keeps only `targets[0]` of
 * each mapping, and treats a pattern as a plain prefix. That is enough to make
 * a guess look plausible and not enough to resolve anything correctly:
 *
 *   - a monorepo has one tsconfig PER PACKAGE, and `apps/web/tsconfig.json` is
 *     what governs `apps/web/src/main.ts` — the root config governs nothing;
 *   - `extends` is how essentially every real config is written, and the
 *     `baseUrl` / `paths` almost always live in the extended base;
 *   - `baseUrl` alone (no `paths`) is a complete resolution rule on its own, and
 *     it is exactly the rule that makes `import 'src/utils/foo'` legal — the
 *     case the old suffix matcher was really standing in for;
 *   - `paths` maps a pattern to an ORDERED LIST of targets, tried in order.
 *
 * So this module answers the question TypeScript actually asks: for THIS file,
 * what are `baseUrl` and `paths`?
 */

import fs from 'fs/promises';
import path from 'path';

import { isHardcodedIgnoredDirectory } from '../../../../config/ignore-service.js';
import { logger } from '../../../logger.js';

/** One `paths` entry, pattern and targets kept in declaration order. */
export interface TsPathMapping {
  /** The pattern as written, e.g. `@/*`, `@app/*`, `exact`. */
  readonly pattern: string;
  /** Targets as written, relative to `baseUrl`. Tried in order. */
  readonly targets: readonly string[];
}

/** The resolution-relevant part of one resolved tsconfig. */
export interface TsconfigScope {
  /** Repo-relative directory the config governs (the tsconfig's own directory). */
  readonly dir: string;
  /**
   * Repo-relative `baseUrl`, or `null` when the config declares none.
   *
   * `null` is not the same as `'.'`: without `baseUrl`, TypeScript does NOT
   * resolve non-relative specifiers against the project at all (they are
   * package lookups), and `paths` targets are resolved against the tsconfig's
   * own directory instead.
   */
  readonly baseUrl: string | null;
  readonly paths: readonly TsPathMapping[];
}

/** Every tsconfig in the repo, indexed so the nearest one to a file wins. */
export interface TsconfigIndex {
  /** Deepest-first, so the first `dir` that prefixes a file path governs it. */
  readonly scopes: readonly TsconfigScope[];
}

const SCAN_MAX_DIRS = 20_000;
const SCAN_MAX_DEPTH = 24;
/** Guard against an `extends` cycle or a pathological chain. */
const MAX_EXTENDS_DEPTH = 16;

/**
 * The config governing `filePath` — the nearest tsconfig at or above it.
 *
 * TypeScript resolves a file against the project that includes it; the nearest
 * enclosing tsconfig is the faithful approximation of that without evaluating
 * `include`/`exclude` globs, and it is what makes a monorepo's per-package
 * `baseUrl` apply to that package's files instead of the root's.
 */
export function tsconfigFor(index: TsconfigIndex | null, filePath: string): TsconfigScope | null {
  if (index === null) return null;
  for (const scope of index.scopes) {
    if (scope.dir === '') return scope;
    if (filePath.startsWith(`${scope.dir}/`)) return scope;
  }
  return null;
}

/** Load every tsconfig in the repo, resolving `extends` chains. */
export async function loadTsconfigIndex(repoRoot: string): Promise<TsconfigIndex | null> {
  const files = await findTsconfigFiles(repoRoot);
  if (files.length === 0) return null;

  const ranked: { scope: TsconfigScope; rank: number }[] = [];
  for (const absPath of files) {
    const options = await readCompilerOptions(absPath, 0);
    if (options === null) continue;
    // `readCompilerOptions` resolves both to ABSOLUTE paths against whichever
    // config in the `extends` chain declared them, which is the only way the
    // chain stays unambiguous. Rebasing to repo-relative happens once, here.
    const baseUrl = options.baseUrl === undefined ? null : repoRelative(repoRoot, options.baseUrl);
    const paths = (options.paths ?? []).map((mapping) => ({
      pattern: mapping.pattern,
      targets: mapping.targets.map((t) => rebaseTarget(repoRoot, t)),
    }));
    if (baseUrl === null && paths.length === 0) continue;
    ranked.push({
      scope: { dir: repoRelative(repoRoot, path.dirname(absPath)), baseUrl, paths },
      rank: configRank(path.basename(absPath)),
    });
  }
  if (ranked.length === 0) return null;

  // Deepest first, because `tsconfigFor` takes the first match and it must be
  // the most specific config rather than whichever the walk reached first.
  //
  // Then by filename rank WITHIN a directory, which is the half that is easy to
  // miss: `tsconfig.json` and `tsconfig.base.json` routinely sit side by side,
  // and the base exists to be extended, not to govern. Reading whichever the
  // directory listing returned first made a config's own `paths` invisible
  // whenever its base happened to be listed earlier.
  ranked.sort((a, b) => b.scope.dir.length - a.scope.dir.length || a.rank - b.rank);
  return { scopes: ranked.map((entry) => entry.scope) };
}

/**
 * Precedence among configs sharing a directory: the project config governs, and
 * everything else is a base or a variant that exists to be extended.
 */
function configRank(fileName: string): number {
  if (fileName === 'tsconfig.json') return 0;
  if (fileName === 'jsconfig.json') return 1;
  return 2;
}

/** Resolved compiler options, rebased to repo-relative paths. */
interface ResolvedOptions {
  baseUrl?: string;
  paths?: TsPathMapping[];
}

/**
 * Read one tsconfig and merge in whatever it `extends`.
 *
 * Rebasing happens per FILE, before merging, because `extends` does not rebase
 * `baseUrl`: a base config at `configs/tsconfig.base.json` declaring
 * `"baseUrl": "."` means `configs/`, even when extended from `apps/web`. Doing
 * the rebase at read time is what keeps that true through the chain.
 */
async function readCompilerOptions(
  absPath: string,
  depth: number,
  repoRootHint?: string,
): Promise<ResolvedOptions | null> {
  if (depth > MAX_EXTENDS_DEPTH) {
    logger.warn(`[typescript] tsconfig extends chain too deep at ${absPath}; ignoring the rest`);
    return null;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = parseJsonc(await fs.readFile(absPath, 'utf-8'));
  } catch {
    return null;
  }

  const dir = path.dirname(absPath);
  // Read what this config extends FIRST: `paths` targets resolve against the
  // EFFECTIVE `baseUrl`, which a config declaring `paths` alone inherits from
  // its base. Resolving them against this config's own directory instead would
  // load the right alias pattern and point every target at the wrong place.
  const inherited = await readExtended(parsed.extends, dir, depth, repoRootHint);

  const own: ResolvedOptions = {};
  const compilerOptions = parsed.compilerOptions;
  if (compilerOptions !== null && typeof compilerOptions === 'object') {
    const opts = compilerOptions as Record<string, unknown>;
    if (typeof opts.baseUrl === 'string') {
      own.baseUrl = path.resolve(dir, opts.baseUrl);
    }
    if (opts.paths !== null && typeof opts.paths === 'object' && !Array.isArray(opts.paths)) {
      // tsc resolves `paths` targets against the effective `baseUrl` — this
      // config's own if it declares one, otherwise the inherited one — and
      // against the config's own directory only when neither exists. Doing it
      // here, per file, is what keeps an `extends` chain unambiguous: by the
      // time these merge, every target is already absolute.
      const pathsBase = own.baseUrl ?? inherited?.baseUrl ?? dir;
      own.paths = [];
      for (const [pattern, targets] of Object.entries(opts.paths as Record<string, unknown>)) {
        if (!Array.isArray(targets)) continue;
        const asStrings = targets
          .filter((t): t is string => typeof t === 'string')
          .map((t) => path.resolve(pathsBase, t));
        if (asStrings.length > 0) own.paths.push({ pattern, targets: asStrings });
      }
    }
  }

  // Own options win over inherited ones — that is what `extends` means. `paths`
  // is replaced wholesale rather than merged, matching tsc.
  return {
    ...(inherited ?? {}),
    ...own,
  };
}

/** Follow `extends`, which may be a string or (TS 5+) an array, base-first. */
async function readExtended(
  value: unknown,
  fromDir: string,
  depth: number,
  repoRootHint?: string,
): Promise<ResolvedOptions | null> {
  const specs = typeof value === 'string' ? [value] : Array.isArray(value) ? value : [];
  let merged: ResolvedOptions | null = null;
  for (const spec of specs) {
    if (typeof spec !== 'string') continue;
    const resolved = await resolveExtendsTarget(spec, fromDir);
    if (resolved === null) continue;
    const options = await readCompilerOptions(resolved, depth + 1, repoRootHint);
    if (options === null) continue;
    // Later entries win over earlier ones, per tsc's array semantics.
    merged = { ...(merged ?? {}), ...options };
  }
  return merged;
}

/**
 * An `extends` value is either a path or a package name.
 *
 * The package form (`"extends": "@tsconfig/node20/tsconfig.json"`,
 * `"@acme/tsconfig"`) lives in `node_modules`, which this tool deliberately
 * does NOT index — it is dependency code, not the repository's own. But not
 * indexing it is different from not READING it, and the distinction matters
 * here: a shared internal base config is exactly where a monorepo puts the
 * `paths` its packages import through, so refusing to open it loses aliases
 * that the repository genuinely declares.
 *
 * So the file is read from disk when it is there, walking `node_modules` up
 * from the extending config the way Node does. When it is absent — an
 * un-installed checkout, which is a shape a static analyser must expect and a
 * compiler may refuse — the answer is `null`, and the caller keeps whatever the
 * extending config declared itself. That degrades to fewer resolutions, never
 * to invented ones.
 */
async function resolveExtendsTarget(spec: string, fromDir: string): Promise<string | null> {
  if (spec.startsWith('.') || path.isAbsolute(spec)) {
    return firstReadableConfig(path.resolve(fromDir, spec));
  }
  for (const modulesDir of nodeModulesChain(fromDir)) {
    const found = await firstReadableConfig(path.join(modulesDir, spec));
    if (found !== null) return found;
  }
  return null;
}

/** `<dir>/node_modules`, then each ancestor's, the way Node resolves. */
function* nodeModulesChain(fromDir: string): Generator<string> {
  let dir = fromDir;
  for (;;) {
    if (path.basename(dir) !== 'node_modules') yield path.join(dir, 'node_modules');
    const parent = path.dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}

/** The first spelling of `base` that is a readable file. */
async function firstReadableConfig(base: string): Promise<string | null> {
  for (const candidate of [base, `${base}.json`, path.join(base, 'tsconfig.json')]) {
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile()) return candidate;
    } catch {
      // try the next spelling
    }
  }
  return null;
}

async function findTsconfigFiles(repoRoot: string): Promise<string[]> {
  const found: string[] = [];
  const queue: { dir: string; depth: number }[] = [{ dir: repoRoot, depth: 0 }];
  let dirsScanned = 0;

  while (queue.length > 0 && dirsScanned < SCAN_MAX_DIRS) {
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
        if (depth < SCAN_MAX_DEPTH)
          queue.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;
      // `tsconfig.json`, `tsconfig.app.json`, `jsconfig.json`, … — any of them
      // can carry the `baseUrl`/`paths` that governs its directory.
      if (/^(ts|js)config(\..+)?\.json$/.test(entry.name)) {
        found.push(path.join(dir, entry.name));
      }
    }
  }
  return found;
}

/** Strip comments and trailing commas — tsconfig is JSONC, not JSON. */
function parseJsonc(raw: string): Record<string, unknown> {
  const withoutComments = raw
    .replace(/\\"|"(?:\\"|[^"])*"|(\/\/.*$)|(\/\*[\s\S]*?\*\/)/gm, (match, line, block) =>
      line !== undefined || block !== undefined ? '' : match,
    )
    .replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(withoutComments) as Record<string, unknown>;
}

function repoRelative(repoRoot: string, absDir: string): string {
  const rel = path.relative(repoRoot, absDir).split(path.sep).join('/');
  return rel === '.' || rel === '' ? '' : rel;
}

/**
 * A `paths` target rebased to repo-relative, keeping any trailing `*`.
 *
 * `path.resolve` swallows the wildcard into a path segment, so it is stripped
 * before resolving and re-appended after — the `*` is a substitution marker,
 * not a directory named `*`.
 */
function rebaseTarget(repoRoot: string, absTarget: string): string {
  // `/repo/src/*` must come back as `src/*`, not `src*`: stripping only the
  // star leaves a trailing slash that `path.relative` then eats.
  const suffix = absTarget.endsWith('/*') ? '/*' : absTarget.endsWith('*') ? '*' : '';
  const base = suffix === '' ? absTarget : absTarget.slice(0, -suffix.length);
  return `${repoRelative(repoRoot, base)}${suffix}`;
}

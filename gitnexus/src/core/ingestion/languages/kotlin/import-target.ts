import type { ParsedImport, WorkspaceIndex } from 'gitnexus-shared';
import { recordKotlinFileIndexBuild } from './index-stats.js';

export interface KotlinResolveContext {
  readonly fromFile: string;
  readonly allFilePaths: ReadonlySet<string>;
}

export function resolveKotlinImportTarget(
  parsedImport: ParsedImport,
  workspaceIndex: WorkspaceIndex,
): string | readonly string[] | null {
  const ctx = workspaceIndex as KotlinResolveContext | undefined;
  if (
    ctx === undefined ||
    typeof (ctx as { fromFile?: unknown }).fromFile !== 'string' ||
    !((ctx as { allFilePaths?: unknown }).allFilePaths instanceof Set)
  ) {
    return null;
  }
  if (parsedImport.kind === 'dynamic-unresolved') return null;
  if (parsedImport.targetRaw === null || parsedImport.targetRaw === '') return null;

  const target = parsedImport.targetRaw.endsWith('.*')
    ? parsedImport.targetRaw.slice(0, -2)
    : parsedImport.targetRaw;
  const pathLike = target.replace(/\./g, '/');

  // Resolution tiers, most-specific first:
  //  1. The full `pathLike` matches a `.kt`/`.kts` file directly
  //     (`import util.User` → `util/User.kt`).
  //  2. Stripped (last-segment removed) `pathLike` matches a file
  //     directly (`import util.OneArg.writeAudit` → `util/OneArg.kt`,
  //     a class-or-object holding `writeAudit`).
  //  3. Stripped `pathLike` matches a *package directory* — fan out to
  //     every `.kt`/`.kts` file inside it (`import models.getRepo` →
  //     `[models/User.kt, models/Repo.kt]`). The finalize pass walks
  //     each candidate and picks the one whose `localDefs` actually
  //     export the imported name (#1759).
  //  4. Progressive prefix strip for deeper namespace aliases that
  //     don't map 1:1 to directories.
  const index = getKotlinFileIndex(ctx.allFilePaths);
  const stripped = pathLike.split('/').slice(0, -1).join('/');
  return (
    findKotlinFile(index, pathLike) ??
    findKotlinExactOrSuffix(index, stripped) ??
    findKotlinPackageFiles(index, stripped) ??
    findByProgressivePrefixStrip(index, pathLike)
  );
}

function findKotlinFile(index: KotlinFileIndex, pathLike: string): string | null {
  return findKotlinExactOrSuffix(index, pathLike) ?? findKotlinDirectoryChild(index, pathLike);
}

/** Exact (`file === pathLike+ext`) or suffix (`file ends with /pathLike+ext`)
 *  match — does NOT fall back to picking an arbitrary file inside a
 *  `pathLike/` directory. Used by the stripped-path tier in
 *  `resolveKotlinImportTarget` so a package import like `models.getRepo`
 *  delegates to `findKotlinPackageFiles` (multi-file fan-out) instead of
 *  silently committing to the first directory child.
 *
 *  An exact match anywhere in the workspace beats a suffix match anywhere,
 *  which is why the two are separate maps rather than one lookup: the old scan
 *  returned on the first exact hit but only remembered the first suffix hit,
 *  so an exact match found late still won. */
function findKotlinExactOrSuffix(index: KotlinFileIndex, pathLike: string): string | null {
  if (pathLike === '') return null;
  return index.exactByStem.get(pathLike) ?? index.suffixByStem.get(pathLike) ?? null;
}

/** First directory child of `pathLike/` — preserves the legacy single-
 *  file fallback for cases where `pathLike` itself is an unqualified
 *  package reference (rare in real Kotlin code; some fixtures rely on
 *  it). Multi-file package fan-out goes through
 *  `findKotlinPackageFiles` instead. */
function findKotlinDirectoryChild(index: KotlinFileIndex, pathLike: string): string | null {
  if (pathLike === '') return null;
  const children = index.dirChildren.get(pathLike);
  // "First" is first in `allFilePaths` iteration order, which the index
  // preserves by appending as it walks the set — the same file the scan
  // used to return.
  return children === undefined ? null : (children[0] ?? null);
}

/**
 * Return every `.kt`/`.kts` file inside the package directory `dirPath`
 * (e.g. `models` → `['models/User.kt', 'models/Repo.kt']`). Used as a
 * fallback when an import like `models.getRepo` does not resolve to a
 * file named after the symbol — in Kotlin the symbol can live in any
 * file inside the package directory. The finalize pass walks each
 * candidate and picks the one whose `localDefs` actually export the
 * imported name (#1759).
 */
function findKotlinPackageFiles(index: KotlinFileIndex, dirPath: string): readonly string[] | null {
  if (dirPath === '') return null;
  return index.dirChildren.get(dirPath) ?? null;
}

function findByProgressivePrefixStrip(index: KotlinFileIndex, pathLike: string): string | null {
  const segments = pathLike.split('/').filter(Boolean);
  for (let skip = 1; skip < segments.length; skip++) {
    const found = findKotlinFile(index, segments.slice(skip).join('/'));
    if (found !== null) return found;
  }
  return null;
}

/**
 * Per-file-set lookup tables for Kotlin import resolution, memoized on the
 * `allFilePaths` Set object (the same Set is passed for every import in a run,
 * so the index is built once and reused).
 *
 * WHY: every tier of `resolveKotlinImportTarget` used to walk the whole
 * workspace — `for (const raw of allFilePaths)` with a `replace(/\\/g, '/')`
 * and several string scans per entry — and the tiers are tried in cascade, so a
 * single unresolved import cost two to four full passes. Across a repository
 * with tens of thousands of Kotlin files that is `O(imports × files)` — on the
 * order of 10^10 string operations on one thread, which presents as `analyze`
 * sitting at exactly 1.00 core with a flat heap and no output for hours (every
 * allocation is a short-lived string, so nothing accumulates to hint at
 * progress). Small repositories hide it completely: at a few hundred files each
 * pass is free.
 *
 * The maps below make each tier O(1), so resolution cost becomes O(files) once
 * plus O(1) per import.
 *
 *  - `exactByStem`: path minus its `.kt`/`.kts` extension -> raw path, for the
 *    `file === pathLike+ext` tier.
 *  - `suffixByStem`: every component-suffix of that stem -> raw path, for the
 *    `file ends with /pathLike+ext` tier. Keyed per suffix rather than per
 *    basename so a multi-segment import (`util/OneArg`) hits one bucket instead
 *    of filtering a basename bucket.
 *  - `dirChildren`: package directory -> its direct `.kt`/`.kts` children, in
 *    set-iteration order, serving both the fan-out tier and the
 *    first-child fallback.
 *
 * Both stem maps keep the FIRST path inserted for a key, because the scans they
 * replace returned the first match in set-iteration order.
 */
interface KotlinFileIndex {
  readonly exactByStem: Map<string, string>;
  readonly suffixByStem: Map<string, string>;
  readonly dirChildren: Map<string, string[]>;
}

const KOTLIN_FILE_INDEX_CACHE = new WeakMap<ReadonlySet<string>, KotlinFileIndex>();

const KOTLIN_EXTENSIONS = ['.kt', '.kts'] as const;

function getKotlinFileIndex(allFilePaths: ReadonlySet<string>): KotlinFileIndex {
  const cached = KOTLIN_FILE_INDEX_CACHE.get(allFilePaths);
  if (cached !== undefined) return cached;
  // Cache miss: materialize a fresh index. Counted so a test can assert this
  // happens once per run, not once per import.
  recordKotlinFileIndexBuild();

  const exactByStem = new Map<string, string>();
  const suffixByStem = new Map<string, string>();
  const dirChildren = new Map<string, string[]>();

  for (const raw of allFilePaths) {
    const norm = raw.replace(/\\/g, '/');
    const ext = KOTLIN_EXTENSIONS.find((e) => norm.endsWith(e));
    // Kotlin resolution only ever queries `.kt`/`.kts` paths, exactly as the
    // scans did before skipping everything else first.
    if (ext === undefined) continue;

    const stem = norm.slice(0, norm.length - ext.length);
    if (!exactByStem.has(stem)) exactByStem.set(stem, raw);
    // Component-suffixes of the stem: one per '/' in it. `a/b/User` yields
    // `b/User` and `User`, matching `norm.endsWith('/' + key + ext)`.
    for (let i = 0; i < stem.length; i++) {
      if (stem[i] !== '/') continue;
      const suffix = stem.slice(i + 1);
      if (!suffixByStem.has(suffix)) suffixByStem.set(suffix, raw);
    }

    const lastSlash = norm.lastIndexOf('/');
    if (lastSlash < 0) continue; // repo-root file has no package directory
    const dir = norm.slice(0, lastSlash);

    // The file's own directory always qualifies: the old scan's `atRoot` branch
    // matched `norm.startsWith(dir + '/')` and found no '/' after it.
    addChild(dirChildren, dir, raw);

    // A component-suffix of the directory also qualifies — but only under the
    // rule the scan actually implemented, which is narrower than "the parent
    // directory is named `s`":
    //
    //  - `atRoot` was tested FIRST, so if the path *starts* with `s + '/'` the
    //    scan used index 0 and the remainder still contained '/', i.e. no
    //    match — even when a later directory is also named `s`.
    //  - otherwise it used `indexOf`, the FIRST occurrence of `/s/`. A path
    //    like `data/src/main/kotlin/com/example/data/Repo.kt` therefore does
    //    NOT count as a child of `data`: the first `/data/` is not the parent,
    //    and the scan never looked for a second one.
    //
    // Preserving that exactly keeps this a pure performance change. It is
    // arguably a bug — the file IS a direct child of a `data` directory — but
    // fixing it here would silently move edges in every Kotlin repository,
    // which belongs in its own change with its own fixtures.
    for (let i = 0; i < dir.length; i++) {
      if (dir[i] !== '/') continue;
      const suffix = dir.slice(i + 1);
      if (norm.startsWith(`${suffix}/`)) continue;
      if (norm.indexOf(`/${suffix}/`) === dir.length - suffix.length - 1) {
        addChild(dirChildren, suffix, raw);
      }
    }
  }

  const index: KotlinFileIndex = { exactByStem, suffixByStem, dirChildren };
  KOTLIN_FILE_INDEX_CACHE.set(allFilePaths, index);
  return index;
}

function addChild(dirChildren: Map<string, string[]>, dir: string, raw: string): void {
  const bucket = dirChildren.get(dir);
  if (bucket === undefined) dirChildren.set(dir, [raw]);
  else bucket.push(raw);
}

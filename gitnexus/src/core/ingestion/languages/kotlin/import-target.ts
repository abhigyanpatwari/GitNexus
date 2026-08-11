import type { ParsedImport, WorkspaceIndex } from 'gitnexus-shared';
import { KOTLIN_EXTENSIONS } from '../../import-resolvers/jvm.js';
import { perFileSet } from '../../import-resolvers/per-file-set.js';

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
  const direct = findKotlinFile(index, pathLike);
  if (direct !== null) return direct;

  // Only tiers 2 and 3 need the stripped path, and tier 1 answers most
  // imports, so it is computed here rather than above. `lastIndexOf`/`slice`
  // rather than `split`/`slice`/`join`: same result for every input, two
  // allocations fewer per import. The `li < 0` guard is load-bearing —
  // `'a'.slice(0, -1)` is `''`, which is what the split form yields for a
  // single-segment path, but only by accident of `[].join('/')`.
  const li = pathLike.lastIndexOf('/');
  const stripped = li < 0 ? '' : pathLike.slice(0, li);
  return (
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
 *    of filtering a basename bucket. The basename-bucket form Python uses was
 *    built and measured against this one during review: byte-identical output,
 *    ~66% less memory, and 7.3x slower per query on a repeated-basename corpus
 *    — enough to fail this resolver's own scaling budget at ~2.0. The memory
 *    the per-suffix keying costs is small in absolute terms (~60 MiB at 100k
 *    Kotlin files at depth 8), so it is not a trade worth revisiting.
 *  - `dirChildren`: package directory -> its direct `.kt`/`.kts` children, in
 *    set-iteration order, serving both the fan-out tier and the
 *    first-child fallback.
 *
 * Both stem maps keep the FIRST path inserted for a key, because the scans they
 * replace returned the first match in set-iteration order.
 *
 * The shared `buildSuffixIndex` (`import-resolvers/utils.ts`, used by C#, Ruby,
 * Vue and TypeScript) is deliberately NOT reused — the same call Python
 * documents at `python/import-target.ts`. Run side by side against this
 * resolver, three probes out of five diverge:
 *
 *  - `['deep/util/User.kt', 'util/User.kt']` for `util.User` — it conflates
 *    exact and proper-suffix matches in one map, so the deep path wins where
 *    the scan returned the exact one;
 *  - `['deep/util/User.kt', 'util/User.kts']` for `util.User` — its keys carry
 *    the extension, so a `.kt` SUFFIX beats a `.kts` EXACT;
 *  - `['models/A.kts', 'models/B.kt']` for `models.getThing` — it splits the
 *    package into `:kt` and `:kts` buckets instead of returning both in set
 *    order.
 *
 * A fourth probe — `['data/src/…/data/Repo.kt']` for `data.getRepo`, where the
 * shared index fanned out and this one returned null — stopped diverging in
 * #2881, which removed the first-occurrence rule that caused it. The remaining
 * three are still edges that would move in every Kotlin repository, so
 * consolidating the two is a behaviour change, not a cleanup.
 */
interface KotlinFileIndex {
  readonly exactByStem: Map<string, string>;
  readonly suffixByStem: Map<string, string>;
  /** Buckets are frozen once the build loop finishes — see `getKotlinFileIndex`. */
  readonly dirChildren: Map<string, readonly string[]>;
}

const getKotlinFileIndex = perFileSet((allFilePaths: ReadonlySet<string>): KotlinFileIndex => {
  // Runs on a cache miss only. That it happens once per run and not once per
  // import is asserted by counting traversals of the Set itself, in
  // `test/integration/kotlin-import-index-reuse.test.ts` (#2909).

  const exactByStem = new Map<string, string>();
  const suffixByStem = new Map<string, string>();
  const dirChildren: MutableDirChildren = new Map();

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

    // Every component-suffix of the directory also qualifies: `s` is a suffix
    // of `dir` starting after a '/', so `dir` ends with `/s` by construction
    // and the file IS a direct child of a directory named `s`.
    //
    // #2881: this loop used to carry two guards, both inherited from the
    // pre-index per-import scan rather than from anything Kotlin requires —
    // `startsWith(s + '/')` skipped the bucket outright, and an `indexOf`
    // equality demanded that the parent be the FIRST `/s/` in the path. Between
    // them they dropped the bucket whenever the package name repeated higher up
    // the tree, so `data/src/main/kotlin/com/example/data/Repo.kt` was not a
    // child of `data` (leading segment, `startsWith`) and neither was
    // `top/data/mid/data/Repo.kt` (mid-path, `indexOf`). `import data.helper`
    // resolved to null in both. Only the fan-out tier was affected —
    // `data.Repo` answered from `suffixByStem`, which never had such a guard,
    // which is why the shape looked narrow enough to preserve.
    //
    // Widening is filtered downstream for tier 3, which hands the finalize pass
    // a candidate list (`findKotlinPackageFiles`), but NOT for the tier-1
    // fallback, which commits to `children[0]` unfiltered
    // (`findKotlinDirectoryChild`) — and that unfiltered tier is where most of
    // the change lands: of the 235 corpus records that moved, 149 are a
    // different first child and only 32 are a wider fan-out array. Both are
    // deliberate. A narrower bucket for the first-child tier alone would keep
    // its answers byte-identical, but it would also leave `import data.*` — a
    // wildcard, which strips to `data` and lands on exactly that tier —
    // resolving to null on the very shape this fixes. The bucket is either
    // right or it is not; there is no version of it that is right for one
    // consumer and wrong for the other.
    for (let i = 0; i < dir.length; i++) {
      if (dir[i] !== '/') continue;
      addChild(dirChildren, dir.slice(i + 1), raw);
    }
  }

  // `findKotlinPackageFiles` hands a bucket straight out of the index — the
  // same array `findKotlinDirectoryChild` reads `children[0]` from. The
  // `readonly string[]` return type does not survive the caller: the finalize
  // pass normalizes with `Array.isArray(t) ? t : [t]`, and `isArray`'s
  // `arg is any[]` predicate widens the true branch, so `tsc --strict` accepts
  // a `.sort()` or `.push()` there. A downstream sort would permanently
  // reorder the cached bucket and flip the FIRST-child tier's answer for every
  // later import in the run. Freezing makes the contract true at runtime, so a
  // future mutation is a loud TypeError instead of a silent edge move.
  for (const bucket of dirChildren.values()) Object.freeze(bucket);

  return { exactByStem, suffixByStem, dirChildren };
});

function addChild(dirChildren: Map<string, string[]>, dir: string, raw: string): void {
  const bucket = dirChildren.get(dir);
  if (bucket === undefined) dirChildren.set(dir, [raw]);
  else bucket.push(raw);
}

/** Mutable view of the buckets, used only while building — the index exposes
 *  them as `readonly` and freezes them before it is cached. */
type MutableDirChildren = Map<string, string[]>;

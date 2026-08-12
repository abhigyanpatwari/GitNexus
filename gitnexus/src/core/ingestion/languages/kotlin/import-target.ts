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
  // preserves by appending as it walks the set. Since #2881 that can be an
  // EARLIER file than the pre-index scan returned, never a later one: the
  // guards that fell take members away from no bucket, so a bucket only ever
  // gains, and a gained member lands wherever set iteration puts it.
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
 *
 * `dirChildren` is likewise NOT the shared `import-resolvers/package-dir-index.ts`
 * — the consolidation a maintainer will actually propose, since Java routes
 * through exactly it (`languages/java/import-target.ts`). Measured, that swap is
 * output-identical for 26.2% less retained memory, and costs 8114x on
 * `import data.*` at 200 matching directories. `bench/kotlin-import-target`
 * CANNOT see that regression — its corpus gives every module a unique package
 * leaf — and the arm that can is `bench/import-target`'s kotlin `collide`. See
 * `_blind_spot` in `bench/kotlin-import-target/baselines.json`.
 *
 * `dirChildren`'s bucket rule, and what #2881 removed
 * ---------------------------------------------------
 * A file is a child of its own directory and of every component-suffix of that
 * directory, unguarded. The suffix half used to carry two guards inherited from
 * the pre-index per-import scan rather than from anything Kotlin requires (the
 * same generation of code put the `indexOf` half into
 * `import-resolvers/package-dir-index.ts` and `import-resolvers/csharp.ts`,
 * where it was removed under the same issue): `startsWith(s + '/')` skipped the
 * bucket outright, and an `indexOf` equality demanded that the parent be the
 * FIRST `/s/` in the path. Between them they dropped the bucket whenever the
 * package name repeated higher up the tree, so
 * `data/src/main/kotlin/com/example/data/Repo.kt` was not a child of `data`
 * (leading segment, `startsWith`) and neither was `top/data/mid/data/Repo.kt`
 * (mid-path, `indexOf`). `import data.helper` resolved to null in both. Only
 * the fan-out tier looked affected — `data.Repo` answers from `suffixByStem`,
 * which never had such a guard — which is why the shape looked narrow enough to
 * preserve.
 *
 * Nothing downstream narrows a widened bucket back at the FILE level. The
 * `localDefs` filter of #1759 constrains `targetDefId`/`BindingRef` ONLY: the
 * finalize pass mints one draft PER CANDIDATE, each keeping its own
 * `targetFile` (`gitnexus-shared/src/scope-resolution/finalize-algorithm.ts`),
 * and the one File→File filter downstream
 * (`scope-resolution/graph-bridge/imports-to-edges.ts`) tests `targetFile`
 * against `null` and against the source file, never reads `linkStatus`, and
 * emits `IMPORTS` at confidence 1.0. So every extra bucket member becomes an
 * unconditional File→File `IMPORTS` edge: one `import data.load` on an
 * Android-style layout measured 5 → 6 edges, the added one `unresolved`. That
 * is a real cost, paid deliberately — a MISSING bucket is unrecoverable, and
 * there is no version of the bucket that is right for one consumer and wrong
 * for the other. Narrowing the File→File side, if it is ever wanted, is a
 * downstream filter and a separate change.
 *
 * What moved, over the corpus: of the 235 records the published census counted,
 * 149 are a different first child, 32 are a wider fan-out array, and 54 are
 * null → resolved — none of which turns a bound answer into an unbound one.
 * That taxonomy has no bucket for a fourth outcome class this change
 * introduces, and did not count it. Tier 3
 * (`findKotlinPackageFiles`) precedes tier 4 (`findByProgressivePrefixStrip`),
 * so a bucket the guards used to leave empty returned null and let tier 4 run;
 * a now-populated bucket stops tier 4 from running at all, which turns a
 * resolved answer into an unresolved one and a `string` into an array:
 *
 *   ['data/src/main/kotlin/com/example/data/Repo.kt', 'common/helper.kt']
 *   with `import data.helper`
 *     before → 'common/helper.kt'                                  (bound)
 *     after  → ['data/src/main/kotlin/com/example/data/Repo.kt']   (no `helper`)
 *
 * Over the census corpus that class is ZERO records — and the zero is the
 * point, not a reprieve. The shape above is real and reproduces by hand in
 * both iteration orders; running `bench/kotlin-import-target`'s own generator
 * at 10x (4000 repositories, ~198 600 distinct records) hits it 4-12 times per
 * seed, i.e. an expectation of about ONE over this corpus's 19 968. So the
 * fingerprint does not gate this class: it is the same blindness the go arm had
 * before #2881 widened its corpus — a gate cannot catch a shape its corpus
 * cannot express. Adding a case is a deliberate fingerprint move and belongs in
 * its own change, with the re-baseline that implies.
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
  const dirChildren = new Map<string, string[]>();
  /**
   * BUILD-LOCAL: `dir` -> every `dirChildren` key a file in that directory
   * contributes to. That list is a pure function of `dir`, and a package
   * directory holds many files, so without this the walk below cuts one `slice`
   * per component of the SAME directory once per FILE — and every slice after
   * the first file's is a freshly allocated string that hashes to a key the map
   * already holds and is then dropped. Interning them once per DIRECTORY
   * instead of once per FILE is ~21% of the build at 32 000 files.
   *
   * It cannot move an answer. The array is filled on the first file of a
   * directory, in the order the per-file walk produced, and every later file in
   * that directory finds those keys already present — so the key set, the Map's
   * key insertion order and every bucket's order are what the per-file form
   * produced. `kotlin-index-internals.test.ts` pins the part of that a consumer
   * can observe, and does it through the resolver's own surface rather than over
   * the built maps: bucket CONTENTS and ORDER (from the fan-out tier, which
   * hands out the bucket array itself), bucket IDENTITY across calls, and that
   * the array handed out is FROZEN. Be precise about the limits, because the
   * mutation matrix in that file's header measured them: a MIS-KEYED memo is
   * caught, a DELETED one is not — the memo is output-identical by construction,
   * so nothing observable can prove it ran. Likewise `Object.isFrozen` catches a
   * missing freeze and a compacted-but-never-stored copy, but NOT a deleted
   * `slice()`: a JS array's backing-store capacity has no reflective surface, so
   * the compaction's only instrument is `heap_ceiling_bytes.kotlin` in
   * `bench/import-target/baselines.json` — a CEILING, because compaction
   * reclaims, so losing it makes the retained reading grow (+12.57% measured).
   * Map key insertion ORDER is
   * unasserted BY DESIGN:
   * `dirChildren` is only ever read by `.get(key)`, so key order has no
   * consumer and pinning it would assert an implementation detail nothing
   * depends on. Nothing else watches it either — the correctness fingerprint
   * sees this index only through the four tiers, so no fingerprint could catch
   * a key-order move.
   *
   * Dropped with this frame, so it costs nothing retained.
   */
  const dirKeys = new Map<string, string[]>();

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

    // From `stem`, not `norm`: an extension carries no '/', so the last '/' of
    // the two is the same character at the same index, and `stem.slice(0,
    // lastSlash)` IS the string `norm.slice(0, norm.lastIndexOf('/'))` was. One
    // backwards scan instead of two, over the string this loop already walked.
    const lastSlash = stem.lastIndexOf('/');
    if (lastSlash < 0) continue; // repo-root file has no package directory
    const dir = stem.slice(0, lastSlash);

    // The keys this file's directory contributes to, unguarded: `dir` itself,
    // plus every component-suffix of it. A suffix `s` starts just after a '/',
    // so `dir` ends with `/s` by construction and the file IS a direct child of
    // a directory named `s`. The absence of a narrowing guard is deliberate —
    // see the `dirChildren` section on `KotlinFileIndex` for the two guards
    // #2881 dropped and for what the resulting width costs downstream.
    let keys = dirKeys.get(dir);
    if (keys === undefined) {
      keys = [dir];
      for (let i = 0; i < lastSlash; i++) {
        if (dir[i] === '/') keys.push(dir.slice(i + 1));
      }
      dirKeys.set(dir, keys);
    }
    for (const key of keys) {
      const bucket = dirChildren.get(key);
      if (bucket === undefined) dirChildren.set(key, [raw]);
      else bucket.push(raw);
    }
  }

  // Buckets are mutable only while this function runs; the index type hands
  // them out `readonly` and they are frozen here, before it is cached.
  // `findKotlinPackageFiles` hands a bucket straight out of the index — the
  // same array `findKotlinDirectoryChild` reads `children[0]` from — so a
  // downstream sort would permanently reorder the cached bucket and flip the
  // FIRST-child tier's answer for every later import in the run. The finalize
  // pass normalizes with `Array.isArray(t) ? t : [t]` and `isArray`'s
  // `arg is any[]` predicate widens the true branch; that one call site now
  // carries an explicit `readonly string[]` annotation, but the annotation is
  // one deletion away and covers only that site. Freezing makes the contract
  // true at runtime, so a future mutation is a loud TypeError, not a silent
  // edge move.
  //
  // COMPACTED as they are frozen: buckets grow by `push`, so V8's growth
  // overshoot stays retained for the life of the index. `length === 1` never
  // grew and is skipped — slicing it saves zero bytes and costs 31% of the
  // build on a corpus of single-file packages. The byte accounting lives once,
  // in `bench/import-target/baselines.json`.
  for (const [key, bucket] of dirChildren) {
    if (bucket.length === 1) {
      Object.freeze(bucket);
      continue;
    }
    const compacted = bucket.slice();
    Object.freeze(compacted);
    dirChildren.set(key, compacted);
  }

  return { exactByStem, suffixByStem, dirChildren };
});

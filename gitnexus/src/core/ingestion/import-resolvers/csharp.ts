/**
 * C# namespace import resolution — internal helpers.
 *
 * Strategy lives in configs/csharp.ts.
 * This file contains shared helpers for namespace-based resolution.
 */

import { perFileSet } from './per-file-set.js';
import { getWorkspaceFileIndex } from './workspace-file-index.js';
import type { SuffixIndex } from './utils.js';
import { suffixResolve } from './utils.js';
import type { CSharpProjectConfig, CSharpNamespaceEvidence } from '../language-config.js';
import { csharpSuffixFallbackAllowed } from '../csharp-namespace-gate.js';

/**
 * Directory index backing the namespace-directory fallback below (step 3).
 *
 * That fallback used to be a full `normalizedFileList` pass per import, per
 * matching csproj config — Θ(files), measured at ~1.08 ms per import over
 * 50 000 `.cs` files (#2902). #2878 removed the per-import array REBUILD but
 * not the scan itself.
 *
 * The scan's predicate depends only on the file's DIRECTORY, so it can be
 * answered from an index built once per file list. Writing `D` for the
 * normalized directory of a `.cs` file and `dirPrefix` for the query:
 *
 *   let H = D + '/', P = dirPrefix + '/'
 *   match ⟺ H.endsWith(P)
 *
 * Derivation:
 *  - the scan keeps a file only when nothing after the matched occurrence holds
 *    a slash, so the occurrence's trailing '/' must be the file's LAST slash —
 *    i.e. `H` ends with `P`;
 *  - it used `indexOf`, the FIRST occurrence, so `a/Models/b/Models/x.cs` did
 *    NOT answer `Models`. That half was removed in #2881: it was an artifact of
 *    how the pre-index scan was written, not a rule about C# namespaces, and it
 *    dropped every repository that nests a directory name inside itself. The
 *    same removal landed in `package-dir-index.ts` and in step 2 below, which
 *    have to move together — see the note at step 3.
 *  - the needle ends with '/', so every occurrence of it lies wholly inside
 *    `D + '/'` and never reaches into the file name — which is what lets the
 *    whole test be evaluated on `D` alone;
 *  - and then the '/' cancels. `(D + '/').endsWith(P + '/')` IS `D.endsWith(P)`:
 *    the appended character only ever matches itself, so it decides nothing and
 *    the comparison of everything before it is unchanged. The predicate the code
 *    actually runs is therefore
 *
 *      match ⟺ D.endsWith(dirPrefix)
 *
 *    with no concatenation on either side. Verified rather than argued: over
 *    every ordered pair of strings up to length 5 over `{a, b, '/'}` including
 *    the empty string — 132 496 pairs — the two forms disagreed 0 times.
 *
 * NOT the same query as `package-dir-index.ts`, and the difference is exactly
 * one character on each side: that module tests `'/'+D+'/'` against
 * `'/'+pkgPath+'/'`, whose leading slash anchors the match to a segment
 * boundary. This scan has no leading slash, so `dirPrefix = 'Models'` also
 * matches `src/SubModels/` and `dirPrefix = 'src/Models'` also matches
 * `vendor/mysrc/Models/`. Those hits are reachable (step 2 below answers only
 * the segment-aligned ones, and step 3 runs precisely when step 2 found
 * nothing), so the looser predicate is preserved verbatim rather than
 * "cleaned up" into a reuse of `filesDirectlyInPkgDir` — see
 * `test/unit/import-resolvers/csharp-csproj-parity.test.ts`.
 *
 * That one character is also why the cancellation above empties this predicate
 * out but not that one: the decoration is one term per side here (`D + '/'`) and
 * two there (`'/' + D + '/'`), and only the TRAILING '/' cancels. Here nothing
 * is left to concatenate; there the leading segment anchor has to stay.
 *
 * Candidates are narrowed by the directory's LAST segment, the same
 * O(directories) bucket `package-dir-index.ts` uses instead of an
 * O(files × depth) suffix map (#2649).
 */
interface CsharpNamespaceDirIndex {
  /** Last path segment of a directory → every `.cs` directory ending in it. */
  readonly dirsByLastSegment: ReadonlyMap<string, readonly string[]>;
  /**
   * Directory → positions in `WorkspaceFileIndex.normalized` of the `.cs` files
   * directly inside it, ascending.
   *
   * Positions rather than paths: the emitted value is the RAW path, and the two
   * arrays are parallel by construction — `normalized` is `all.map(slash)` — so
   * a position is the one key that reads correctly in either. Both arrays come
   * from the same `getWorkspaceFileIndex(allFilePaths)` object as this index
   * itself, so the pairing cannot drift; it used to be a precondition on the
   * caller, who passed the two arrays independently.
   */
  readonly positionsByDir: ReadonlyMap<string, readonly number[]>;
  /**
   * Directories with no slash of their own — the entire answer to an empty
   * `dirPrefix`, which is the one query no last-segment bucket expresses.
   */
  readonly singleSegmentDirs: readonly string[];
}

/**
 * Memoized on the file SET's identity, the same key every other per-file-set
 * index in this pipeline uses: the orchestrator builds one Set per pass and
 * threads it through every import, so this build runs once.
 *
 * It used to key on the `normalizedFileList` ARRAY, which was a second key
 * shape and — more to the point — one no guard could instrument. Copying an
 * array mints a fresh `WeakMap` key while traversing the SET zero extra times,
 * so a `[...normalized]` copy at the adapter boundary rebuilt this index once
 * per `using` while every scan-counting guard stayed green and only the timing
 * bench noticed (#2911 review). Taking the array from
 * `getWorkspaceFileIndex(allFilePaths)` inside the builder retires that shape:
 * the only way to defeat the memo now is to copy the Set, which is exactly what
 * `CountingSet` counts.
 *
 * It also retires a precondition. The cached positions index `normalized` while
 * the emitted value is read from `all`; both now come from the same
 * `getWorkspaceFileIndex` object, so the caller can no longer pair a position
 * list against a differently-ordered array.
 */
const getCsharpNamespaceDirIndex = perFileSet(
  (allFilePaths: ReadonlySet<string>): CsharpNamespaceDirIndex => {
    const { normalized: normalizedFileList } = getWorkspaceFileIndex(allFilePaths);
    const dirsByLastSegment = new Map<string, string[]>();
    const positionsByDir = new Map<string, number[]>();
    const singleSegmentDirs: string[] = [];

    for (let i = 0; i < normalizedFileList.length; i++) {
      const normalized = normalizedFileList[i];
      if (!normalized.endsWith('.cs')) continue;
      const lastSlash = normalized.lastIndexOf('/');
      // A file with no directory can never match: the needle always ends with
      // '/', so `indexOf` on a slash-free path is always -1.
      if (lastSlash < 0) continue;

      const dir = normalized.slice(0, lastSlash);
      let positions = positionsByDir.get(dir);
      if (positions === undefined) {
        positions = [];
        positionsByDir.set(dir, positions);
        const lastSegment = dir.slice(dir.lastIndexOf('/') + 1);
        if (lastSegment === dir) singleSegmentDirs.push(dir);
        let dirs = dirsByLastSegment.get(lastSegment);
        if (dirs === undefined) {
          dirs = [];
          dirsByLastSegment.set(lastSegment, dirs);
        }
        dirs.push(dir);
      }
      positions.push(i);
    }

    return { dirsByLastSegment, positionsByDir, singleSegmentDirs };
  },
);

/**
 * Every directory that could satisfy `dirPrefix`, as a superset — the exact
 * test runs in `matchingDirPositions`.
 *
 * When `dirPrefix` contains a '/', its own slash forces a segment boundary in
 * any matching directory: `H` ending with `…/<lastSeg>/` means `D` ends with
 * `/<lastSeg>`, so `D`'s last segment IS `lastSeg` and the exact bucket is
 * complete. Without a '/', `D`'s last segment only has to END with `dirPrefix`
 * (`SubModels` for `Models`), which no single bucket holds, so the last-segment
 * KEYS are swept. That is the one term here that is not O(matches), and it is
 * O(distinct last segments), not O(directories): C# repos reuse `Models`,
 * `Services`, `Controllers` under every project, so the sweep collapses on the
 * layouts that actually occur. Measured at 200 000 `.cs` files, 25 000
 * directories: 456 µs per import when every directory name is unique, 7.9 µs
 * on a `SrcN/Models` layout. Closing the unique-name case needs a character-
 * suffix map over the segments, which is the O(files × depth) memory shape
 * `package-dir-index.ts` cites #2649 to avoid — a design change, not a tune.
 *
 * An empty `dirPrefix` would sweep every key and keep every directory, so it is
 * answered from `singleSegmentDirs` instead: its needle is a bare '/', which
 * only a slash-free directory can carry as its LAST slash.
 */
function* candidateDirs(index: CsharpNamespaceDirIndex, dirPrefix: string): Generator<string> {
  if (dirPrefix === '') {
    yield* index.singleSegmentDirs;
    return;
  }
  const lastSlash = dirPrefix.lastIndexOf('/');
  if (lastSlash >= 0) {
    const bucket = index.dirsByLastSegment.get(dirPrefix.slice(lastSlash + 1));
    if (bucket !== undefined) yield* bucket;
    return;
  }
  for (const [lastSegment, dirs] of index.dirsByLastSegment) {
    if (!lastSegment.endsWith(dirPrefix)) continue;
    yield* dirs;
  }
}

/** Positions of the `.cs` files in each directory matching `dirPrefix`. */
function* matchingDirPositions(
  index: CsharpNamespaceDirIndex,
  dirPrefix: string,
): Generator<readonly number[]> {
  for (const dir of candidateDirs(index, dirPrefix)) {
    // `(dir + '/').endsWith(dirPrefix + '/')` IS `dir.endsWith(dirPrefix)` — the
    // appended '/' only ever matches itself, so it decides nothing and BOTH
    // concatenations go. Exhaustively verified, not assumed: 0 disagreements
    // over every ordered pair of strings up to length 5 over `{a, b, '/'}`
    // including '' (132 496 pairs). Measured 64.9 ns -> 18.4 ns per candidate
    // (Node 22.18); the `dir + '/'` was paid once per candidate, on every sweep
    // of the last-segment keys.
    //
    // Still deliberately UNANCHORED (no leading '/'), so `src/SubModels` keeps
    // answering `Models` — see the derivation above. That is also exactly why
    // the reduction empties this predicate out while `package-dir-index.ts`
    // keeps its concatenations: one decorating term per side here, two there,
    // and only the trailing one cancels.
    //
    // `endsWith` subsumes the length guard the `indexOf` form needed: a shorter
    // `dir` is simply false, where `indexOf` returned -1 and
    // `haystack.length - needle.length` could also be -1 and report a bogus
    // match.
    //
    // Do NOT "finish the job" with the two-argument overload. `endsWith(search,
    // endPosition)` measured 8.8-11.8 ns against 9.5-14.9 ns for the
    // one-argument form across seven call-site shapes (Node 22.18) — a wash —
    // and `dir.endsWith(dirPrefix, dir.length)` is character-for-character this
    // same test anyway. There is nothing left here to win.
    if (!dir.endsWith(dirPrefix)) continue;
    const positions = index.positionsByDir.get(dir);
    if (positions !== undefined) yield positions;
  }
}

/**
 * Append every `.cs` file directly inside a directory matching `dirPrefix`, in
 * `normalizedFileList` order — the order the single-pass scan emitted, which
 * this function's callers return as the whole edge target list.
 */
function pushFilesDirectlyInNamespaceDir(
  index: CsharpNamespaceDirIndex,
  dirPrefix: string,
  allFileList: readonly string[],
  results: string[],
): void {
  // One matching directory is the overwhelmingly common case, and its positions
  // are already ascending, so the first bucket is held by reference. A second
  // one promotes it to a real accumulator that is appended to from then on —
  // never re-spread per directory, which would cost O(files × dirs²) copies in
  // a monorepo carrying the same namespace directory under many projects.
  let first: readonly number[] | null = null;
  let merged: number[] | null = null;
  for (const positions of matchingDirPositions(index, dirPrefix)) {
    if (first === null) {
      first = positions;
      continue;
    }
    if (merged === null) merged = [...first];
    for (const position of positions) merged.push(position);
  }
  if (first === null) return;
  if (merged === null) {
    for (const position of first) results.push(allFileList[position]);
    return;
  }
  merged.sort((a, b) => a - b);
  for (const position of merged) results.push(allFileList[position]);
}

/**
 * Resolve a C# using-directive import path to matching .cs files (low-level helper).
 * Tries single-file match first, then directory match for namespace imports.
 *
 * The final unanchored suffix fallback is gated on `evidence` so BCL usings
 * (e.g. `System.Threading.Tasks`) can't match a coincidentally-named local
 * file (#1881). When `evidence` is omitted the fallback stays permissive.
 *
 * Takes the file SET, not the two materialized lists it used to take: both are
 * derived here from the per-pass `getWorkspaceFileIndex` memo, which is where
 * every caller already got them. That leaves one key shape for the indexes
 * below and makes the `normalized`/`all` pairing structural rather than a
 * contract the caller has to honour. `index` stays a parameter — the parity
 * harness drives this resolver with and without one, and the no-index legs are
 * a tested dimension, not a degenerate case.
 */
export function resolveCSharpImportInternal(
  importPath: string,
  csharpConfigs: CSharpProjectConfig[],
  allFilePaths: ReadonlySet<string>,
  index?: SuffixIndex,
  evidence?: CSharpNamespaceEvidence,
): string[] {
  const { normalized: normalizedFileList, all: allFileList } = getWorkspaceFileIndex(allFilePaths);
  const namespacePath = importPath.replace(/\./g, '/');
  const results: string[] = [];

  for (const config of csharpConfigs) {
    const nsPath = config.rootNamespace.replace(/\./g, '/');
    let relative: string;
    if (namespacePath.startsWith(nsPath + '/')) {
      relative = namespacePath.slice(nsPath.length + 1);
    } else if (namespacePath === nsPath) {
      // The import IS the root namespace — resolve to all .cs files in project root
      relative = '';
    } else {
      continue;
    }

    const dirPrefix = config.projectDir
      ? relative
        ? config.projectDir + '/' + relative
        : config.projectDir
      : relative;

    // 1. Try as single file: relative.cs (e.g., "Models/DlqMessage.cs")
    if (relative) {
      const candidate = dirPrefix + '.cs';
      if (index) {
        const result = index.get(candidate) || index.getInsensitive(candidate);
        if (result) return [result];
      }
      // Also try suffix match
      const suffixResult = index?.get(relative + '.cs') || index?.getInsensitive(relative + '.cs');
      if (suffixResult) return [suffixResult];
    }

    // 2. Try as directory: all .cs files directly inside (namespace import)
    if (index) {
      const dirFiles = index.getFilesInDir(dirPrefix, '.cs');
      // `getFilesInDir` already answers "directly inside a directory `D` where
      // `D === dirPrefix || D.endsWith('/' + dirPrefix)`" — its keys ARE
      // segment-aligned directory suffixes. So for a non-empty `dirPrefix` the
      // direct-child re-check this loop used to run cannot reject anything, and
      // measurement agrees: zero rejections over 12 008 (prefix, candidate)
      // pairs. It rejected before #2881 only because it asked `indexOf` for the
      // FIRST `/<dirPrefix>/`, which is the rule that issue removed.
      //
      // That widening does not stay inside step 2's own bucket. This step
      // returns as soon as it pushes anything, so a query it used to answer with
      // nothing now also SUPPRESSES step 3, whose unanchored match set is a
      // strict superset: over `SubModels/Models/F1.cs` + `SubModels/F3.cs`,
      // `using App.Models` answered both through step 3 and now answers only the
      // first through step 2. The new answer is the more precise one — a
      // directory literally named `Models` beating a character-suffix hit on
      // `SubModels` — and it is what this module's step-2-before-step-3 layering
      // asks for, so it is kept rather than worked around. Pinned absolutely by
      // the parity test, which is differentially blind to it (its frozen legacy
      // copy moved in lockstep with this line).
      //
      // The empty prefix is the exception and keeps a real filter. `getDirMap`
      // keys a file under every suffix of its DIRECTORY, so it emits the EMPTY
      // one exactly when that directory's last component is empty: a leading '/'
      // on a root-level file, or a doubled slash immediately before the file
      // name. Probed against `getDirMap`'s own key emission:
      //
      //   src/X.cs   -> ['src:.cs']                        no empty key
      //   /X.cs      -> [':.cs']                           empty key
      //   a//X.cs    -> [':.cs', 'a/:.cs']                 empty key
      //   /a/b/X.cs  -> ['b:.cs', 'a/b:.cs', '/a/b:.cs']   no empty key
      //
      // So the `''` bucket is not "one directory deep" on its own — `a//X.cs`
      // sits in it two components down — while step 3 answers that same query
      // from `singleSegmentDirs`, which is. Filtering on `D` holding no slash is
      // what rejects `a//X.cs` and keeps steps 2 and 3 in agreement.
      for (const f of dirFiles) {
        if (dirPrefix === '') {
          const normalized = f.replace(/\\/g, '/');
          const lastSlash = normalized.lastIndexOf('/');
          if (lastSlash < 0 || normalized.slice(0, lastSlash).includes('/')) continue;
        }
        results.push(f);
      }
      if (results.length > 0) return results;
    }

    // 3. Directory matching, UNANCHORED.
    //
    // Not redundant with step 2, and not skippable when `index` is present:
    // `getFilesInDir` is keyed on SEGMENT suffixes of a directory, while this
    // leg's predicate is an unanchored ends-with one, so it additionally
    // answers `Models` with `src/SubModels/` and `src/Models` with
    // `vendor/mysrc/Models/`. It is also the only leg that answers an empty
    // `dirPrefix` — the `relative = ''` branch above (the import IS the root
    // namespace) with no `projectDir` to stand in for it — because
    // `buildSuffixIndex` emits an empty directory suffix only for a path that
    // BEGINS with '/', so over repo-relative paths `getFilesInDir('', '.cs')`
    // is always empty. See `CsharpNamespaceDirIndex` above for the index that
    // replaced the per-import Θ(files) scan this used to be (#2902).
    //
    // `results` is provably empty here: step 2 returns as soon as it pushes
    // anything, and so does this leg, so every iteration of the config loop
    // starts empty.
    pushFilesDirectlyInNamespaceDir(
      getCsharpNamespaceDirIndex(allFilePaths),
      dirPrefix,
      allFileList,
      results,
    );
    if (results.length > 0) return results;
  }

  // Fallback: suffix matching without namespace stripping (single file).
  // Gated on in-repo declared-namespace evidence (#1881).
  if (!csharpSuffixFallbackAllowed(importPath, evidence)) {
    return [];
  }
  const pathParts = namespacePath.split('/').filter(Boolean);
  const fallback = suffixResolve(pathParts, normalizedFileList, allFileList, index);
  return fallback ? [fallback] : [];
}

/**
 * Compute the directory suffix for a C# namespace import (for PackageMap).
 * Returns a suffix like "/ProjectDir/Models/" or null if no config matches.
 */
export function resolveCSharpNamespaceDir(
  importPath: string,
  csharpConfigs: CSharpProjectConfig[],
): string | null {
  const namespacePath = importPath.replace(/\./g, '/');

  for (const config of csharpConfigs) {
    const nsPath = config.rootNamespace.replace(/\./g, '/');
    let relative: string;
    if (namespacePath.startsWith(nsPath + '/')) {
      relative = namespacePath.slice(nsPath.length + 1);
    } else if (namespacePath === nsPath) {
      relative = '';
    } else {
      continue;
    }

    const dirPrefix = config.projectDir
      ? relative
        ? config.projectDir + '/' + relative
        : config.projectDir
      : relative;

    if (!dirPrefix) continue;
    return '/' + dirPrefix + '/';
  }

  return null;
}

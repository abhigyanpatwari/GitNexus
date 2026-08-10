/**
 * The one per-file-set index behind Python import resolution, plus the two
 * importer-chain memos that ride inside it.
 *
 * ## Why this is its own module
 *
 * Everything here is derived from `allFilePaths` and nothing here is specific
 * to either CALLER, and there are two of them on opposite sides of a layer
 * boundary: `import-resolvers/python.ts` resolves the single-segment bare tier
 * and `languages/python/import-target.ts` resolves the dotted tiers. The second
 * imports the first, so the index could not live in either without the other
 * reaching back through a cycle — it used to live in `import-target.ts`, which
 * is why the bare tier had no O(1) proof of absence and probed the whole
 * ancestor chain for every `import os`.
 *
 * The shape is the one `workspace-file-index.ts` and `package-dir-index.ts`
 * already use in this directory: an interface, one `perFileSet` builder, and
 * query functions taking the index.
 */

import { perFileSet } from './per-file-set.js';

/**
 * The importer's ancestor directories, CLOSEST FIRST and excluding the
 * workspace root — `["backend/routers", "backend"]` for `backend/routers/x.py`
 * — memoized per importer DIRECTORY for the lifetime of the pass.
 *
 * This is the #2913 fix. Both consumers used to rebuild the chain inline, one
 * `dirParts.slice(0, i).join('/')` per component, on EVERY import: a per-import
 * cost proportional to the importer's path depth, and quadratic in characters,
 * on a file index that is itself depth-free. Real Python layouts are deep
 * (`src/pkg/sub/feature/impl/mod.py` is ordinary), so the resolver was 6.8x
 * slower on a deep corpus than on a shallow one holding the file count fixed,
 * where every other language sat between 1.0x and 3.4x.
 *
 * A directory's ancestors are a pure function of the directory, and a pass
 * resolves many imports per file, so one entry serves every import issued from
 * anywhere in that directory.
 *
 * ## Lifetime and memory
 *
 * The Map lives INSIDE the per-file-set index, so it is reclaimed with the file
 * set it was reached through (`perFileSet` is a `WeakMap`): it cannot leak
 * across passes or repos, and there is no invalidation rule to get wrong. It is
 * filled lazily, so it holds one entry per directory that actually ISSUES a
 * Python import, never one per file and never one per directory in the repo —
 * the bound #2649 (kernel-scale OOM) asks for. Each entry's strings are
 * `slice`s of the longest one, so a chain costs pointers rather than a copy of
 * the path per component.
 *
 * The derived key is the importer's directory exactly as the old inline code
 * computed it — `norm.split('/').slice(0, -1).join('/')`, which for a path
 * without a separator is `''` (a root-level importer, whose chain is empty).
 */
export function importerAncestors(index: PythonFileIndex, fromFile: string): readonly string[] {
  const norm = fromFile.replace(/\\/g, '/');
  const lastSlash = norm.lastIndexOf('/');
  const importerDir = lastSlash === -1 ? '' : norm.slice(0, lastSlash);
  const memoized = index.ancestorsByDir.get(importerDir);
  if (memoized !== undefined) return memoized;
  const built = buildImporterAncestors(importerDir);
  index.ancestorsByDir.set(importerDir, built);
  return built;
}

/**
 * `["a/b/c", "a/b", "a"]` for `a/b/c`. Empty components are dropped first, so
 * an absolute `/a/b` yields `["a/b", "a"]` — matching the `filter(Boolean)` the
 * two inline walks did, and with it the absolute-path gating pinned by
 * `python-import-target-parity.test.ts` (PR #1918 review P3a).
 */
function buildImporterAncestors(importerDir: string): readonly string[] {
  const chain: string[] = [];
  const parts = importerDir.split('/').filter(Boolean);
  if (parts.length === 0) return chain;
  chain.push(parts.join('/'));
  for (let i = 1; i < parts.length; i++) {
    const child = chain[i - 1];
    chain.push(child.slice(0, child.lastIndexOf('/')));
  }
  return chain;
}

/**
 * Per-file-set index for Python import resolution, memoized on the
 * `allFilePaths` Set object (the same Set is passed for every import in a run,
 * so the index is built once and reused). Replaces the per-import O(files)
 * scans in `resolveAbsoluteFromFiles` (suffix match) and `hasRepoCandidate`
 * (package-existence gate) with O(1)/O(bucket) lookups.
 *
 *  - `normSet`: every file path, normalized to forward slashes (for the exact
 *    `f === rootFile|initFile` membership checks).
 *  - `byBasename`: last path component (e.g. `models.py`, `__init__.py`) ->
 *    all `{ raw, norm }` candidates, so suffix matches can be gathered from the
 *    relevant bucket and the exact tie-break applied across ALL of them.
 *  - `byInitParent`: `__init__.py` files keyed by their last TWO components
 *    (`<parentDir>/__init__.py`). The package suffix lookup (`pkg.sub` ->
 *    `…/sub/__init__.py`) targets only same-named package dirs via this map
 *    instead of scanning every `__init__.py` in the repo — the common
 *    multi-segment import path no longer scales with package count
 *    (PR #1918 review P2b). `__init__.py` files stay in `byBasename` too, for
 *    the rarer explicit `pkg.__init__` import that resolves via the module
 *    (`…<lastSeg>.py`) lookup.
 *  - `dirPrefixes`: every directory prefix of a `.py` file, trailing-slashed
 *    (`a/b/c.py` -> `a/`, `a/b/`), for "is there a .py file under `<dir>/`".
 *  - `nestedDirNames`: the NAME of every such directory that has a non-empty
 *    parent (`a/b/c.py` -> `b`, not `a`), which is exactly the set of segments
 *    `hasRepoCandidate`'s ancestor walk can ever match — so a segment absent
 *    from it settles the walk in one lookup (#2913).
 *  - `ancestorsByDir`: the per-importer-directory ancestor-chain memo behind
 *    `importerAncestors`. The one structure here that is NOT derived from the
 *    file set: it is filled lazily, from the importer paths the pass actually
 *    resolves against, and lives here so it dies with the pass.
 *  - `bareImportPrefixesByDir`: the same idea for the OTHER chain — the
 *    sys.path-style prefixes `resolvePythonImportInternal`'s single-segment
 *    walk probes. A different sequence, not a different spelling: see
 *    `importerBarePrefixes`. Two memos in one index rather than two indexes,
 *    because they are keyed on the same thing and must die together.
 *
 * Exported for `test/unit/scope-resolution/python/python-importer-ancestors.test.ts`
 * and `test/unit/import-resolvers/python-importer-prefixes.test.ts`, which read
 * the two memos after driving the production adapters. No counter ships for
 * either — the Map IS the memo, and its SIZE is the assertion: one entry per
 * importer directory, however many imports were resolved. Everything else about
 * the index stays internal.
 */
export interface PythonFileIndex {
  readonly normSet: Set<string>;
  readonly byBasename: Map<string, { raw: string; norm: string }[]>;
  readonly byInitParent: Map<string, { raw: string; norm: string }[]>;
  readonly dirPrefixes: Set<string>;
  readonly nestedDirNames: Set<string>;
  readonly ancestorsByDir: Map<string, readonly string[]>;
  readonly bareImportPrefixesByDir: Map<string, readonly string[]>;
}

export const getPythonFileIndex = perFileSet(
  (allFilePaths: ReadonlySet<string>): PythonFileIndex => {
    // Runs on a cache miss only. That it happens once per run and not once per
    // import is asserted by counting traversals of the Set itself, in
    // `test/integration/python-import-index-reuse.test.ts` — the PR #1918 review
    // P1 guard (#2909).

    const normSet = new Set<string>();
    const byBasename = new Map<string, { raw: string; norm: string }[]>();
    const byInitParent = new Map<string, { raw: string; norm: string }[]>();
    const dirPrefixes = new Set<string>();
    const nestedDirNames = new Set<string>();

    for (const raw of allFilePaths) {
      const norm = raw.replace(/\\/g, '/');
      // Python import resolution only ever queries `.py` paths: module `<seg>.py`
      // and package `<seg>/__init__.py` membership (normSet), `<lastSeg>.py` /
      // `__init__.py` basename buckets (byBasename), and `.py` directory prefixes
      // (dirPrefixes). Non-`.py` files can never match any of those, so skip them
      // — they were dead weight in every structure on polyglot monorepos
      // (PR #1918 review P3b; dirPrefixes was already `.py`-gated).
      if (!norm.endsWith('.py')) continue;
      normSet.add(norm);

      const lastSlash = norm.lastIndexOf('/');
      const base = lastSlash >= 0 ? norm.slice(lastSlash + 1) : norm;
      let bucket = byBasename.get(base);
      if (bucket === undefined) {
        bucket = [];
        byBasename.set(base, bucket);
      }
      bucket.push({ raw, norm });

      // Package files also get a parent-keyed bucket so a `pkg.sub` lookup hits
      // only `…/sub/__init__.py` candidates, not every `__init__.py` (P2b).
      if (base === '__init__.py' && lastSlash >= 0) {
        const dir = norm.slice(0, lastSlash);
        const parentSlash = dir.lastIndexOf('/');
        const parentName = parentSlash >= 0 ? dir.slice(parentSlash + 1) : dir;
        if (parentName) {
          const initKey = `${parentName}/__init__.py`;
          let ib = byInitParent.get(initKey);
          if (ib === undefined) {
            ib = [];
            byInitParent.set(initKey, ib);
          }
          ib.push({ raw, norm });
        }
      }

      // Directory prefixes: every slash-terminated prefix of the path (every
      // index just past a '/', up to and including the file's own directory).
      // Scanning the FULL normalized path — including any leading '/' for
      // absolute paths — makes `dirPrefixes.has(X)` match exactly when the old
      // gate's `f.startsWith(X)` (X always ends in '/') matched. The previous
      // split+`filter(Boolean)` dropped the leading empty component, so an
      // absolute file `/repo/svc/x.py` yielded `repo/svc/` (no leading slash) and
      // gate-passed where `"/repo/svc/x.py".startsWith("repo/svc/")` is false
      // (PR #1918 review P3a). For relative paths the set is identical.
      //
      // The walk runs from the DEEPEST prefix outward and stops at the first
      // one already recorded. Every prefix is added together with all of its
      // own ancestors, so a hit proves the rest of the chain is already there —
      // which makes the second and later files of a directory cost ONE lookup
      // instead of one insert per path component. This build was the last part
      // of Python's resolution that still scaled with path depth (#2913): the
      // same 400-file corpus moved sixteen directories down went from 800
      // inserts to 7200, for the same ~120 distinct prefixes.
      //
      // `nestedDirNames` rides the same walk. A directory prefix has the shape
      // `<parent>/<name>/` — the only shape `hasRepoCandidate`'s check (3)
      // probes — exactly when another slash precedes it at index > 0. Index 0
      // is excluded on purpose: `a/` and `/` name a directory whose parent is
      // empty, which check (2) already answers and which the ancestor walk
      // (non-empty ancestors only) never probes.
      for (let i = lastSlash; i >= 0; i--) {
        if (norm[i] !== '/') continue;
        const dirPrefix = norm.slice(0, i + 1);
        if (dirPrefixes.has(dirPrefix)) break;
        dirPrefixes.add(dirPrefix);
        const parentSlash = i > 0 ? norm.lastIndexOf('/', i - 1) : -1;
        if (parentSlash > 0) nestedDirNames.add(norm.slice(parentSlash + 1, i));
      }
    }

    return {
      normSet,
      byBasename,
      byInitParent,
      dirPrefixes,
      nestedDirNames,
      ancestorsByDir: new Map<string, readonly string[]>(),
      bareImportPrefixesByDir: new Map<string, readonly string[]>(),
    };
  },
);

/**
 * The sys.path-style prefixes `resolvePythonImportInternal`'s single-segment
 * bare-import walk probes, in order, for an importer sitting in `importerDir` —
 * memoized per DIRECTORY for the lifetime of the pass, in the same index and
 * for the same reasons as `importerAncestors`.
 *
 * ## Why this is not `ancestorsByDir`
 *
 * A DIFFERENT SEQUENCE, not a different spelling. For `backend/routers/cron.py`:
 *
 *   importerAncestors      ["backend/routers", "backend"]
 *   importerBarePrefixes   ["backend/", ""]
 *
 * Three differences, each load-bearing:
 *
 *  1. `importerAncestors` opens with the importer's OWN directory; this walk
 *     does not, because its proximity check has already probed that directory.
 *  2. This walk ENDS at the workspace root (`""`, which probes `<module>.py`
 *     unprefixed); `importerAncestors` stops short of it, because
 *     `resolveAbsoluteFromFiles` probes the root before its walk instead.
 *  3. `importerAncestors` drops empty components (`filter(Boolean)`); this walk
 *     keeps them, and the difference decides real resolutions — for
 *     `/abs/a/b/mod.py` this walk probes `/abs/a/`, `/abs/`, `""`, `""` where a
 *     filtered chain would probe `abs/a/b/`, `abs/a/`, `abs/`, none of which is
 *     a prefix of any file in an absolute-path workspace.
 *
 * So the two cannot share one chain without changing which files resolve. They
 * do share the index, the key and the lifetime, which is what actually matters
 * for #2649: both are filled lazily, hold one entry per directory that ISSUES
 * an import, and die with the pass because the index does.
 */
export function importerBarePrefixes(
  index: PythonFileIndex,
  importerDir: string,
): readonly string[] {
  const memoized = index.bareImportPrefixesByDir.get(importerDir);
  if (memoized !== undefined) return memoized;
  const built = buildImporterBarePrefixes(importerDir);
  index.bareImportPrefixesByDir.set(importerDir, built);
  return built;
}

/**
 * `["a/b/", "a/", ""]` for `a/b/c` — every proper ancestor of `importerDir`,
 * closest first, slash-terminated, ending at the workspace root.
 *
 * Cutting the string at each `lastIndexOf('/')` walks the same ancestors the
 * pre-#2913-followup `dirParts.slice(0, i).join('/')` produced, INCLUDING the
 * empty components a `filter(Boolean)` would have dropped: `/abs/a/b` yields
 * `["/abs/a/", "/abs/", "", ""]`, the second `""` being the `i === 0` step that
 * followed the leading empty component. Byte-identical sequences, duplicates
 * kept, so the probes this feeds are unchanged in content, order and count.
 */
function buildImporterBarePrefixes(importerDir: string): readonly string[] {
  const prefixes: string[] = [];
  let dir = importerDir;
  let slash = dir.lastIndexOf('/');
  while (slash !== -1) {
    dir = dir.slice(0, slash);
    prefixes.push(dir === '' ? '' : `${dir}/`);
    slash = dir.lastIndexOf('/');
  }
  prefixes.push('');
  return prefixes;
}

/**
 * "No file anywhere in the workspace can be `<X>/<segment>.py` or
 * `<X>/<segment>/__init__.py`, for ANY prefix `<X>`" — in two Map lookups.
 *
 * This is a PROOF OF ABSENCE, not a heuristic filter, and it is what lets the
 * single-segment bare walk skip itself entirely. Both shapes it rules out are
 * the only two shapes that walk probes: a probe `${prefix}${segment}.py` that
 * is a member of the file set is a path with no backslash (the prefix comes
 * from a normalized importer and the guard below rejects a segment carrying
 * one), so it equals its own normalized form and its basename is exactly
 * `${segment}.py` — which puts it in `byBasename`. A probe
 * `${prefix}${segment}/__init__.py` that is a member likewise has parent
 * directory name exactly `segment`, non-empty, which puts it in `byInitParent`
 * whether or not `prefix` is empty. So a miss in both buckets means every probe
 * the walk would issue is guaranteed to miss.
 *
 * Two inputs cannot be proven absent and get `false` — walk as before:
 *
 *  - the EMPTY segment (a target spelled with a trailing dot).
 *    `byInitParent` skips `__init__.py` files whose parent directory name is
 *    empty, so its absence proves nothing. Same carve-out
 *    `resolveAbsoluteFromFiles` makes for `lastSeg === ''`.
 *  - a segment containing a BACKSLASH. The buckets are keyed on normalized
 *    paths, so a raw `a\b.py` is filed under basename `b.py`; a probe for the
 *    segment `a\b` would look up `a\b.py`, miss, and wrongly conclude absence
 *    while `allFilePaths.has('a\\b.py')` is true. Not reachable from a Python
 *    import statement, but this function is a proof and a proof has no
 *    unstated preconditions.
 *
 * The dotted tier in `languages/python/import-target.ts` asks the same question
 * of the same two buckets and is deliberately NOT routed through here: it needs
 * the candidate ARRAYS for its suffix fallback, so it does the two `get`s it
 * already needs and derives the answer, rather than paying two extra `has`
 * lookups per import to share four lines.
 */
export function pythonSegmentAbsent(index: PythonFileIndex, segment: string): boolean {
  if (segment === '' || segment.includes('\\')) return false;
  if (index.byBasename.has(`${segment}.py`)) return false;
  if (index.byInitParent.has(`${segment}/__init__.py`)) return false;
  return true;
}

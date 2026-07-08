/**
 * Adapter from `(ParsedImport, WorkspaceIndex)` → concrete file path.
 *
 * Delegates to the existing `resolvePythonImportInternal` (PEP-328
 * relative resolution + standard suffix matching). The `WorkspaceIndex`
 * is opaque at this layer; consumers wire a `PythonResolveContext`
 * shape carrying `fromFile` + `allFilePaths`.
 *
 * Returning `null` lets the finalize algorithm mark the edge as
 * `linkStatus: 'unresolved'`.
 */

import type { ParsedImport, WorkspaceIndex } from 'gitnexus-shared';
import { resolvePythonImportInternal } from '../../import-resolvers/python.js';
import { recordPythonFileIndexBuild } from './index-stats.js';

export interface PythonResolveContext {
  readonly fromFile: string;
  /** `ReadonlySet` so the orchestrator's stable run-level set flows straight
   *  through to `getPythonFileIndex`'s `WeakMap` key (built once per run, not
   *  copied per import). The whole resolver chain only reads the set. */
  readonly allFilePaths: ReadonlySet<string>;
}

export function resolvePythonImportTarget(
  parsedImport: ParsedImport,
  workspaceIndex: WorkspaceIndex,
): string | null {
  // WorkspaceIndex is `unknown` in the shared contract (Ring 1
  // placeholder). The scope-resolution orchestrator hands us a
  // PythonResolveContext-shaped object; narrow structurally rather
  // than via a cast chain so unexpected shapes return null cleanly.
  const ctx = workspaceIndex as PythonResolveContext | undefined;
  // Duck-type the set rather than `instanceof Set`: `allFilePaths` is typed
  // `ReadonlySet<string>` and the chain only ever calls `.has()` + iterates, so
  // any set-like is valid. An `instanceof Set` check would reject a legitimate
  // non-`Set` `ReadonlySet` implementation and silently return null for every
  // import (PR #1918 tri-review P2).
  const allFilePaths = (ctx as { allFilePaths?: unknown } | undefined)?.allFilePaths;
  if (
    ctx === undefined ||
    typeof (ctx as { fromFile?: unknown }).fromFile !== 'string' ||
    typeof (allFilePaths as { has?: unknown } | undefined)?.has !== 'function' ||
    typeof (allFilePaths as Iterable<string> | undefined)?.[Symbol.iterator] !== 'function'
  ) {
    return null;
  }
  if (parsedImport.kind === 'dynamic-unresolved') return null;
  if (parsedImport.targetRaw === null || parsedImport.targetRaw === '') return null;

  // PEP-328 relative + single-segment proximity bare imports.
  const internal = resolvePythonImportInternal(
    ctx.fromFile,
    parsedImport.targetRaw,
    ctx.allFilePaths,
  );
  if (internal !== null) return internal;

  // PEP-328: unresolved relative imports must NOT fall through to suffix
  // matching. Mirrors `pythonImportStrategy` in `configs/python.ts`.
  if (parsedImport.targetRaw.startsWith('.')) return null;

  // External dotted imports like `django.apps` must not fall through to
  // generic suffix matching when the repo has unrelated local files such
  // as `accounts/apps.py`. Mirrors `pythonImportStrategy`'s
  // `hasRepoCandidate` check: only suffix-match if the leading segment
  // looks like a local package/module somewhere in-repo.
  const pathLike = parsedImport.targetRaw.replace(/\./g, '/');
  if (pathLike.includes('/')) {
    const [leadingSegment] = pathLike.split('/').filter(Boolean);
    if (!leadingSegment || !hasRepoCandidate(leadingSegment, ctx.allFilePaths, ctx.fromFile)) {
      return null;
    }
  }

  // Multi-segment absolute resolve: try exact paths first, then ancestor
  // walk (mirrors the single-segment ancestor walk in
  // `resolvePythonImportInternal`), then a suffix match in nested repos.
  // Using direct `Set.has` + `endsWith` instead of `suffixResolve`'s shared
  // helper because that helper requires a pre-built `SuffixIndex` to
  // disambiguate ties — without one it falls back to an O(files) scan that
  // silently picks the wrong file when the last segment collides across
  // directories (e.g. `accounts.models` matching `billing/models.py` when
  // both files exist).
  return resolveAbsoluteFromFiles(pathLike, ctx.allFilePaths, ctx.fromFile);
}

/**
 * Resolve `package/sub/module` style paths (already dot-flattened) to a
 * concrete file in `allFilePaths`. Tries the exact path first, then walks
 * ancestors of `fromFile` looking for `<ancestor>/<pathLike>.py` (or
 * `__init__.py`), then falls back to a suffix match for nested layouts.
 * Returns the original (un-normalized) path from the set.
 *
 * Precedence order:
 *  1. Workspace-root direct hit (`<pathLike>.py`, `<pathLike>/__init__.py`).
 *  2. Closest-ancestor match walking up from the importer's directory.
 *  3. Suffix fallback (deterministic: fewest path segments, then
 *     lexicographic on the normalized path).
 *
 * Root wins over ancestor by construction — if both `services/sync.py` and
 * `backend/services/sync.py` exist, `backend/routers/cron.py`'s
 * `from services.sync import X` resolves to the root file. This mirrors
 * Python's `sys.path` semantics where the project root is searched first.
 *
 * The ancestor walk mirrors the single-segment behavior in
 * `resolvePythonImportInternal`. For `from services.sync import X` in
 * `backend/routers/cron.py`, walk up: `backend/routers/services/sync.py` →
 * `backend/services/sync.py` ✓.
 */
function resolveAbsoluteFromFiles(
  pathLike: string,
  allFilePaths: ReadonlySet<string>,
  fromFile: string,
): string | null {
  const directFile = `${pathLike}.py`;
  const directPkg = `${pathLike}/__init__.py`;

  // Direct hit at workspace root.
  if (allFilePaths.has(directFile)) return directFile;
  if (allFilePaths.has(directPkg)) return directPkg;

  // Ancestor walk — match the single-segment resolver's behavior at
  // multi-segment granularity. Closest match wins. Stop at `i > 0` because
  // `i === 0` would re-check the workspace-root candidates already covered
  // by the direct check above.
  const importerDir = fromFile.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
  if (importerDir) {
    const dirParts = importerDir.split('/').filter(Boolean);
    for (let i = dirParts.length; i > 0; i--) {
      const ancestor = dirParts.slice(0, i).join('/');
      const prefix = `${ancestor}/`;
      const candidateFile = `${prefix}${directFile}`;
      const candidatePkg = `${prefix}${directPkg}`;
      if (allFilePaths.has(candidateFile)) return candidateFile;
      if (allFilePaths.has(candidatePkg)) return candidatePkg;
    }
  }

  // Suffix-match fallback (preserved for monorepo/nested-repo layouts
  // that don't share a directory ancestor with the importer).
  //
  // Tie-break order when multiple files match the same suffix:
  //  1. Fewest path segments (shorter, more canonical paths win — `lib/x.py`
  //     beats `tooling/extras/x.py`).
  //  2. Lexicographic order over the normalized path (final stable
  //     tiebreak independent of file-set insertion order).
  //
  // Without an explicit tie-break the previous implementation returned
  // the first match in `Set` iteration order, which depended on file
  // ingestion order and produced non-deterministic edges across runs in
  // multi-directory collision repos.
  const suffixFile = `/${directFile}`;
  const suffixPkg = `/${directPkg}`;
  // Indexed suffix gather. A file matching `…/<pathLike>.py` has basename
  // `<lastSeg>.py`; one matching `…/<pathLike>/__init__.py` has basename
  // `__init__.py`. Look up only those basename buckets and confirm the full
  // suffix, instead of scanning every file (the O(imports x files) hotpath).
  // The candidate SET is identical to the old full scan, and the tie-break
  // sort below fully determines the result, so output is unchanged. The
  // shared buildSuffixIndex is deliberately NOT used: it keeps only one
  // path per suffix (longest wins) and so cannot reproduce this exact
  // fewest-segments-then-lexicographic tie-break across all candidates.
  const index = getPythonFileIndex(allFilePaths);
  const lastSeg = pathLike.slice(pathLike.lastIndexOf('/') + 1);
  const matches: { raw: string; norm: string }[] = [];
  for (const cand of index.byBasename.get(`${lastSeg}.py`) ?? []) {
    if (cand.norm.endsWith(suffixFile)) matches.push(cand);
  }
  // Package form: only `__init__.py` files whose parent dir is named `<lastSeg>`
  // can match `…/<lastSeg>/__init__.py` — look them up by parent key (P2b) and
  // confirm the full suffix. Same final candidate set as the old `__init__.py`
  // scan, just without iterating unrelated packages.
  for (const cand of index.byInitParent.get(`${lastSeg}/__init__.py`) ?? []) {
    if (cand.norm.endsWith(suffixPkg)) matches.push(cand);
  }
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0].raw;
  matches.sort((a, b) => {
    const aDepth = a.norm.split('/').length;
    const bDepth = b.norm.split('/').length;
    if (aDepth !== bDepth) return aDepth - bDepth;
    if (a.norm < b.norm) return -1;
    if (a.norm > b.norm) return 1;
    return 0;
  });
  return matches[0].raw;
}

/**
 * Does the repo contain a module/package named `leadingSegment` somewhere
 * the importer can plausibly reach?
 *
 * Used to guard against false-positive suffix matches on external dotted
 * imports (e.g. `django.apps` matching a local `accounts/apps.py`).
 *
 * Checks, in order:
 *  1. `SEGMENT.py` root file or `SEGMENT/__init__.py` regular package.
 *  2. Any `SEGMENT/...py` file at the workspace root (namespace package).
 *  3. Any `<importer-ancestor>/SEGMENT/...py` file (nested namespace
 *     package the importer could reach via an ancestor walk, e.g.
 *     `backend/services/sync.py` from `backend/routers/cron.py`).
 *
 * The nested case is bounded to the importer's own ancestors so a
 * vendored copy of an external package (e.g. `vendor/django/urls.py`)
 * does not gate-pass external imports like `from django.urls import path`
 * issued from `app/main.py`. Files inside the vendored tree itself
 * (importer under `vendor/django/...`) still resolve correctly because
 * the ancestor walk includes their own parents.
 */
function hasRepoCandidate(
  leadingSegment: string,
  allFilePaths: ReadonlySet<string>,
  fromFile: string,
): boolean {
  const prefix = `${leadingSegment}/`;
  const rootFile = `${leadingSegment}.py`;
  const initFile = `${leadingSegment}/__init__.py`;

  // Build importer-ancestor prefixes: for `backend/routers/cron.py`,
  // produces `["backend/routers/services/", "backend/services/"]` for
  // segment `services` (closest first, root excluded — covered above).
  const importerDir = fromFile.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
  const dirParts = importerDir ? importerDir.split('/').filter(Boolean) : [];
  const ancestorPrefixes: string[] = [];
  for (let i = dirParts.length; i > 0; i--) {
    ancestorPrefixes.push(`${dirParts.slice(0, i).join('/')}/${leadingSegment}/`);
  }

  // Indexed equivalents of the old O(files) scan:
  //  (1) `f === rootFile || f === initFile`  -> normalized-path membership.
  //  (2) `f.startsWith(`${seg}/`) && f.endsWith('.py')` -> some .py file lives
  //      under directory `${seg}/`, i.e. `${seg}/` is a known .py dir prefix.
  //  (3) ancestor namespace case -> `${ancestor}/${seg}/` is a known .py dir
  //      prefix.
  const index = getPythonFileIndex(allFilePaths);
  if (index.normSet.has(rootFile) || index.normSet.has(initFile)) return true;
  if (index.dirPrefixes.has(prefix)) return true;
  for (const ap of ancestorPrefixes) {
    if (index.dirPrefixes.has(ap)) return true;
  }
  return false;
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
 */
interface PythonFileIndex {
  readonly normSet: Set<string>;
  readonly byBasename: Map<string, { raw: string; norm: string }[]>;
  readonly byInitParent: Map<string, { raw: string; norm: string }[]>;
  readonly dirPrefixes: Set<string>;
}

const PYTHON_FILE_INDEX_CACHE = new WeakMap<ReadonlySet<string>, PythonFileIndex>();

function getPythonFileIndex(allFilePaths: ReadonlySet<string>): PythonFileIndex {
  const cached = PYTHON_FILE_INDEX_CACHE.get(allFilePaths);
  if (cached !== undefined) return cached;
  // Cache miss: materialize a fresh index. Counted so a test can assert this
  // happens once per run, not once per import (PR #1918 review P1 guard).
  recordPythonFileIndexBuild();

  const normSet = new Set<string>();
  const byBasename = new Map<string, { raw: string; norm: string }[]>();
  const byInitParent = new Map<string, { raw: string; norm: string }[]>();
  const dirPrefixes = new Set<string>();

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
    for (let i = 0; i <= lastSlash; i++) {
      if (norm[i] === '/') dirPrefixes.add(norm.slice(0, i + 1));
    }
  }

  const index: PythonFileIndex = { normSet, byBasename, byInitParent, dirPrefixes };
  PYTHON_FILE_INDEX_CACHE.set(allFilePaths, index);
  return index;
}

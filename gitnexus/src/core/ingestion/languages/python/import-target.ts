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

import type { ParsedFile, ParsedImport, WorkspaceIndex } from 'gitnexus-shared';
import { perFileSet } from '../../import-resolvers/per-file-set.js';
import { resolvePythonImportInternal } from '../../import-resolvers/python.js';

export interface PythonResolveContext {
  readonly fromFile: string;
  /** `ReadonlySet` so the orchestrator's stable run-level set flows straight
   *  through to `getPythonFileIndex`'s `WeakMap` key (built once per run, not
   *  copied per import). The whole resolver chain only reads the set. */
  readonly allFilePaths: ReadonlySet<string>;
  /** Optional parsed workspace used to preserve a package's explicit export
   * when it collides with a same-named concrete submodule. */
  readonly parsedFiles?: readonly ParsedFile[];
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

  const submoduleTarget = pythonImportedSubmoduleTarget(parsedImport);
  if (
    submoduleTarget !== null &&
    (parsedImport.kind === 'named' || parsedImport.kind === 'alias')
  ) {
    // Python's IMPORT_FROM first reads an attribute already exported by the
    // package and only loads a same-named submodule when that attribute is
    // absent. Preserve that precedence when parsed workspace facts are
    // available; the flag suppresses this submodule probe in the recursive
    // base-package lookup.
    const packageTarget = resolvePythonImportTarget(
      { ...parsedImport, targetIncludesImportedName: true },
      workspaceIndex,
    );
    if (
      packageTarget !== null &&
      pythonFileExportsName(packageTarget, parsedImport.importedName, ctx.parsedFiles)
    ) {
      return packageTarget;
    }

    const submodule = resolvePythonImportTarget(
      {
        kind: 'namespace',
        localName: parsedImport.localName,
        importedName: parsedImport.importedName,
        targetRaw: submoduleTarget,
      },
      workspaceIndex,
    );
    if (submodule !== null) return submodule;
    if (packageTarget !== null) return packageTarget;
  }

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
 * Answers "does this package expose `importedName` as an attribute?" from
 * `localDefs` alone — so it says no for a name the package only re-exports.
 *
 * KNOWN DIVERGENCE from `buildReexportClosures`, which since #2864 does carry
 * re-exported names (`ParsedImport.reexportsName`). With
 * `pkg/__init__.py: from .impl import log`, `pkg/impl.py: def log`, and a
 * same-named `pkg/log.py`, this returns false, the caller falls through to the
 * submodule probe, and `from pkg import log` targets `pkg/log.py` — where
 * `log` is not a local def either, so the edge ends unresolved and the closure
 * is never consulted, for exactly the case it was built for. CPython binds
 * `pkg.log` to the function.
 *
 * NOT fixed by reusing the flag here, which is the obvious three-line change
 * and is wrong: `reexportsName` is also set for `pkg/__init__.py: from .
 * import log`, where CPython binds `pkg.log` to the **module** `pkg/log.py`
 * (verified on 3.11) and returning true here would kill the correct namespace
 * edge. Separating the two needs the re-export's own resolved target, i.e.
 * re-entering `resolvePythonImportTarget` from a different `fromFile` — and
 * that classification is what open issue #2882 is about, so it belongs with
 * that fix rather than bolted on here. Not a regression: both halves behave
 * exactly as they did before #2864.
 */
function pythonFileExportsName(
  targetFile: string,
  importedName: string,
  parsedFiles: readonly ParsedFile[] | undefined,
): boolean {
  if (parsedFiles === undefined) return false;
  const parsed = parsedFiles.find((file) => file.filePath === targetFile);
  if (parsed === undefined) return false;
  return parsed.localDefs.some((def) => {
    const qualifiedName = def.qualifiedName;
    if (qualifiedName === undefined || qualifiedName.length === 0) return false;
    const dot = qualifiedName.lastIndexOf('.');
    return (dot === -1 ? qualifiedName : qualifiedName.slice(dot + 1)) === importedName;
  });
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

const getPythonFileIndex = perFileSet((allFilePaths: ReadonlySet<string>): PythonFileIndex => {
  // Runs on a cache miss only. That it happens once per run and not once per
  // import is asserted by counting traversals of the Set itself, in
  // `test/integration/python-import-index-reuse.test.ts` — the PR #1918 review
  // P1 guard (#2909).

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

  return { normSet, byBasename, byInitParent, dirPrefixes };
});

function pythonImportedSubmoduleTarget(parsedImport: ParsedImport): string | null {
  if (parsedImport.kind !== 'named' && parsedImport.kind !== 'alias') return null;
  if (parsedImport.targetIncludesImportedName === true) return null;
  const separator = parsedImport.targetRaw.endsWith('.') ? '' : '.';
  return parsedImport.targetRaw + separator + parsedImport.importedName;
}

/**
 * A named Python import is a namespace handle only when its resolved file is
 * the concrete submodule formed by appending the imported name. This keeps
 * ordinary symbol imports on the named-binding path.
 */
export function isPythonImportedModule(
  parsedImport: ParsedImport,
  targetFile: string,
  fromFile: string,
): boolean {
  const submoduleTarget = pythonImportedSubmoduleTarget(parsedImport);
  if (submoduleTarget === null) return false;

  const normalizedTarget = targetFile.replace(/\\/g, '/');
  let pathLike: string;

  if (submoduleTarget.startsWith('.')) {
    const match = submoduleTarget.match(/^(\.+)(.*)$/);
    if (match === null) return false;
    const ascend = match[1].length - 1;
    const base = fromFile.replace(/\\/g, '/').split('/').slice(0, -1);
    if (ascend > base.length) return false;
    const relativeParts = match[2].split('.').filter(Boolean);
    pathLike = [...base.slice(0, base.length - ascend), ...relativeParts].join('/');
  } else {
    pathLike = submoduleTarget.replace(/\./g, '/');
  }

  const moduleFile = pathLike + '.py';
  const packageFile = pathLike + '/__init__.py';
  return (
    normalizedTarget === moduleFile ||
    normalizedTarget === packageFile ||
    normalizedTarget.endsWith('/' + moduleFile) ||
    normalizedTarget.endsWith('/' + packageFile)
  );
}

/**
 * The receiver spellings `import a.b.c` makes callable, and the file each one
 * names (#2826).
 *
 * `import a.b.c` binds ONE name — `a` — but makes three attribute paths
 * reachable, and they name three different files:
 *
 *   a        → a/__init__.py
 *   a.b      → a/b/__init__.py
 *   a.b.c    → a/b/c.py        (the edge's own target)
 *
 * The shared default keyed `a` to the LEAF, which is wrong in both directions:
 * `a.helper()` resolved into `a/b/c.py` whenever that module happened to export
 * `helper`, and `a.b.mid()` resolved to nothing.
 *
 * Returns `undefined` — meaning "use the shared default" — for every spelling
 * where the bound name is not the path's root:
 *   - `import single`            — no dotted path to expand;
 *   - `import a.b as x`          — binds only `x`; writing `a.b.f()` there is a
 *                                  NameError, so `a.b` must NOT become a key;
 *   - `from pkg import db`       — reclassified to a namespace edge whose
 *                                  importPath is the bare name `db`.
 *
 * Prefix files are proposed, not asserted: `moduleFileExists` drops any that
 * the workspace did not parse, so a PEP-420 namespace package (no
 * `__init__.py`) contributes no key rather than one pointing at a missing file.
 */
export function pythonNamespaceReceiverPaths(
  edge: { readonly localName: string; readonly importPath: string; readonly targetFile: string },
  moduleFileExists: (filePath: string) => boolean,
): readonly (readonly [string, string])[] | undefined {
  const segments = edge.importPath.split('.');
  if (segments.length < 2) return undefined;
  if (segments[0] !== edge.localName) return undefined;

  const out: (readonly [string, string])[] = [[edge.importPath, edge.targetFile]];

  // Anchor the prefix packages on the RESOLVED leaf, never on the import
  // spelling. `resolvePythonImportTarget` resolves off-root in two of its three
  // tiers (suffix match and ancestor-relative), so `import utils.db` can land on
  // `libs/common/utils/db.py`. Building `utils/__init__.py` from the spelling
  // would then name a DIFFERENT package that merely shares the root segment —
  // a wrong edge — and in a `src/` layout it would match nothing at all,
  // silently making prefix keying inert for the most common Python layout.
  //
  // Walking back from the leaf also inherits that path's own separator, so no
  // POSIX-vs-Windows probing is needed: workspace paths are not normalized at
  // ingestion, and `moduleScopeByFile` is keyed by the raw `ParsedFile.filePath`.
  const dirs = edge.targetFile.split('/').slice(0, -1);
  // The import's leading segments name the leaf's innermost directories.
  const offset = dirs.length - (segments.length - 1);
  if (offset < 0) return out;

  for (let i = 1; i < segments.length; i++) {
    const spelling = segments.slice(0, i).join('.');
    const packageFile = dirs.slice(0, offset + i).join('/') + '/__init__.py';
    // Package FIRST, then the leaf as a fallback — order is the whole point.
    //
    // `findExportedDef` only accepts a binding whose `origin === 'local'`, and
    // the canonical package re-exports (`from .b.c import helper` in
    // `__init__.py`) produce an IMPORT binding. Keying the prefix at the
    // package alone therefore loses `a.helper()` entirely for the most common
    // package shape — the fixtures here all define members locally in
    // `__init__.py`, which is precisely the one layout where that mistake is
    // invisible. Keeping the leaf behind the package restores that resolution
    // while still letting a real definition in `__init__.py` win over a
    // same-named decoy deeper in the package.
    if (moduleFileExists(packageFile)) out.push([spelling, packageFile]);
    out.push([spelling, edge.targetFile]);
  }
  return out;
}

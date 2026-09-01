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
import {
  getPythonFileIndex,
  importerAncestors,
  importerDirOf,
} from '../../import-resolvers/python-file-index.js';
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

    // `return packageTarget`, not `if (packageTarget !== null) return …` —
    // falling through when it is null RE-RAN THE ENTIRE TAIL BELOW, a second
    // time, with byte-identical arguments.
    //
    // `packageTarget` IS this function's tail for this import. The recursion
    // above differs from the outer frame in exactly one field,
    // `targetIncludesImportedName`, whose only effect is to make
    // `pythonImportedSubmoduleTarget` return null and so skip this branch: the
    // spread preserves `kind` (still `named`/`alias`, so the
    // `dynamic-unresolved` guard cannot fire) and `targetRaw` (which already
    // passed the null/empty guard), and `workspaceIndex` is the same object, so
    // `ctx.fromFile`, `ctx.allFilePaths` and `ctx.parsedFiles` are the same
    // references. The recursion therefore ran `resolvePythonImportInternal` →
    // relative gate → `hasRepoCandidate` → `resolveAbsoluteFromFiles` on
    // exactly the inputs the fallthrough would use.
    //
    // That tail is a pure function of (`fromFile`, `targetRaw`,
    // `allFilePaths`): it only reads the Set and indexes memoized on the Set,
    // and the `submodule` probe in between is equally read-only, so nothing can
    // have changed the answer. Reaching this line means the tail already
    // returned null; running it again returns null again, after another
    // proximity probe and another full ancestor walk to the workspace root.
    //
    // Measured before this change, `from x import y` at four directory
    // components: 24 `allFilePaths.has` probes per import, of which probes
    // 12-23 were byte-identical repeats of 0-11. `python-import-probe-count
    // .test.ts` is the gate.
    return packageTarget;
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
 *
 * The `parsedFiles.find` this used to open with was the same O(imports x files)
 * shape #2913 removes on the path Set, keyed on the other collection the
 * orchestrator threads: every import whose package probe resolves scanned the
 * whole parsed workspace, and on a repo where `from pkg import X` usually
 * resolves that is most imports. `parsedFileByPath` replaces it with one pass
 * per pass.
 */
function pythonFileExportsName(
  targetFile: string,
  importedName: string,
  parsedFiles: readonly ParsedFile[] | undefined,
): boolean {
  if (parsedFiles === undefined) return false;
  const parsed = parsedFileByPath(parsedFiles).get(targetFile);
  if (parsed === undefined) return false;
  return parsed.localDefs.some((def) => {
    const qualifiedName = def.qualifiedName;
    if (qualifiedName === undefined || qualifiedName.length === 0) return false;
    const dot = qualifiedName.lastIndexOf('.');
    return (dot === -1 ? qualifiedName : qualifiedName.slice(dot + 1)) === importedName;
  });
}

/**
 * `filePath -> ParsedFile`, memoized on the identity of the pass's
 * `parsedFiles` array — the second stable object the orchestrator threads
 * through `resolveImportTarget`, beside the path Set.
 *
 * FIRST WINS on a duplicated path, which is what `Array.prototype.find`
 * returned, so the answer is unchanged for a workspace that somehow parsed one
 * path twice. Values are references to the array's own elements: the Map costs
 * one pointer per parsed file and, living in a `WeakMap` keyed on the array,
 * is reclaimed with the pass rather than accumulating across runs (#2649).
 */
const parsedFileByPath = perFileSet(
  (parsedFiles: readonly ParsedFile[]): Map<string, ParsedFile> => {
    const byPath = new Map<string, ParsedFile>();
    for (const file of parsedFiles) {
      if (!byPath.has(file.filePath)) byPath.set(file.filePath, file);
    }
    return byPath;
  },
);

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

  // Both remaining tiers — the ancestor walk and the suffix fallback — can only
  // ever land on a file whose basename is `<lastSeg>.py`, or on an `__init__.py`
  // whose parent directory is named `<lastSeg>`. The two buckets the suffix
  // fallback already needs therefore also decide, in O(1) and before the walk,
  // whether the walk can hit at all: neither bucket present means no tier below
  // can match, and one bucket absent removes that tier's probe from EVERY step
  // of the walk. On the deep corpus that is half the walk's probes (#2913).
  //
  // `pythonSegmentAbsent` states this same rule for the single-segment bare
  // tier. It is deliberately not called here: that tier needs only the answer,
  // this one needs the candidate ARRAYS for the suffix fallback below, so
  // sharing would mean two extra `has` lookups per import to save four lines.
  const index = getPythonFileIndex(allFilePaths);
  const lastSeg = pathLike.slice(pathLike.lastIndexOf('/') + 1);
  const moduleCandidates = index.byBasename.get(`${lastSeg}.py`);
  const packageCandidates = index.byInitParent.get(`${lastSeg}/__init__.py`);
  const mayBeModule = moduleCandidates !== undefined;
  // `byInitParent` skips `__init__.py` files whose parent directory name is
  // empty (a doubled separator), so an empty `<lastSeg>` — a target spelled
  // with a trailing dot — cannot use the bucket as proof of absence and keeps
  // probing exactly as before.
  const mayBePackage = packageCandidates !== undefined || lastSeg === '';
  if (!mayBeModule && !mayBePackage) return null;

  // Ancestor walk — match the single-segment resolver's behavior at
  // multi-segment granularity. Closest match wins. The chain stops short of the
  // workspace root because the root candidates are the direct check above.
  //
  // The chain comes from `importerAncestors`, which builds it ONCE per importer
  // directory per pass. Rebuilding it here — one `slice(0, i).join('/')` per
  // path component, on every import — was half of the depth quadratic in #2913.
  for (const ancestor of importerAncestors(index, importerDirOf(fromFile))) {
    if (mayBeModule) {
      const candidateFile = `${ancestor}/${directFile}`;
      if (allFilePaths.has(candidateFile)) return candidateFile;
    }
    if (mayBePackage) {
      const candidatePkg = `${ancestor}/${directPkg}`;
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
  const matches: { raw: string; norm: string }[] = [];
  for (const cand of moduleCandidates ?? []) {
    if (cand.norm.endsWith(suffixFile)) matches.push(cand);
  }
  // Package form: only `__init__.py` files whose parent dir is named `<lastSeg>`
  // can match `…/<lastSeg>/__init__.py` — look them up by parent key (P2b) and
  // confirm the full suffix. Same final candidate set as the old `__init__.py`
  // scan, just without iterating unrelated packages.
  for (const cand of packageCandidates ?? []) {
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

  // Indexed equivalents of the old O(files) scan:
  //  (1) `f === rootFile || f === initFile`  -> normalized-path membership.
  //  (2) `f.startsWith(`${seg}/`) && f.endsWith('.py')` -> some .py file lives
  //      under directory `${seg}/`, i.e. `${seg}/` is a known .py dir prefix.
  //  (3) ancestor namespace case -> `${ancestor}/${seg}/` is a known .py dir
  //      prefix, for some ancestor of the importer's directory.
  const index = getPythonFileIndex(allFilePaths);
  if (index.normSet.has(rootFile) || index.normSet.has(initFile)) return true;
  if (index.dirPrefixes.has(prefix)) return true;
  // (3) used to MATERIALIZE one `${ancestor}/${seg}/` string per component of
  // the importer's directory, eagerly, before checks (1) and (2) had even run —
  // O(depth^2) characters on every import, and the other half of #2913. Two
  // things replace that: `nestedDirNames` answers "is `seg` the name of any
  // directory sitting under a non-empty parent?" in O(1), which is `false` for
  // every external import (`os`, `django`, an unknown distribution) and skips
  // the walk outright; and what remains walks the per-directory ancestor chain,
  // built once per pass, closest first, so the common in-repo hit exits after a
  // step or two. `nestedDirNames` is exact, not a filter: `${A}/${seg}/` can
  // only be a directory prefix if `seg` names a directory under the non-empty
  // parent `A`, so a miss here means the old loop would have missed too.
  if (!index.nestedDirNames.has(leadingSegment)) return false;
  for (const ancestor of importerAncestors(index, importerDirOf(fromFile))) {
    if (index.dirPrefixes.has(`${ancestor}/${prefix}`)) return true;
  }
  return false;
}

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

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

export interface PythonResolveContext {
  readonly fromFile: string;
  /** Mutable `Set` because the legacy `resolvePythonImportInternal`
   *  chain downstream is typed to accept `Set<string>`. Callers that
   *  only hold a `ReadonlySet` should copy via `new Set(...)` at the
   *  adapter boundary. */
  readonly allFilePaths: Set<string>;
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
  if (
    ctx === undefined ||
    typeof (ctx as { fromFile?: unknown }).fromFile !== 'string' ||
    !((ctx as { allFilePaths?: unknown }).allFilePaths instanceof Set)
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
    if (!leadingSegment || !hasRepoCandidate(leadingSegment, ctx.allFilePaths)) {
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
 * The ancestor walk mirrors the single-segment behavior in
 * `resolvePythonImportInternal`: Python's import system resolves bare
 * imports against `sys.path` entries, which typically include the project
 * root and package directories. For `from services.sync import X` in
 * `backend/routers/cron.py`, walk up: `backend/routers/services/sync.py` →
 * `backend/services/sync.py` ✓.
 */
function resolveAbsoluteFromFiles(
  pathLike: string,
  allFilePaths: Set<string>,
  fromFile: string,
): string | null {
  const directFile = `${pathLike}.py`;
  const directPkg = `${pathLike}/__init__.py`;

  // Direct hit at workspace root.
  if (allFilePaths.has(directFile)) return directFile;
  if (allFilePaths.has(directPkg)) return directPkg;

  // Ancestor walk — match the single-segment resolver's behavior at
  // multi-segment granularity. Closest match wins.
  const importerDir = fromFile.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
  if (importerDir) {
    const dirParts = importerDir.split('/').filter(Boolean);
    for (let i = dirParts.length; i >= 0; i--) {
      const ancestor = dirParts.slice(0, i).join('/');
      const prefix = ancestor ? `${ancestor}/` : '';
      const candidateFile = `${prefix}${directFile}`;
      const candidatePkg = `${prefix}${directPkg}`;
      if (allFilePaths.has(candidateFile)) return candidateFile;
      if (allFilePaths.has(candidatePkg)) return candidatePkg;
    }
  }

  // Existing suffix-match fallback (preserved for monorepo/nested-repo
  // layouts that don't share a directory ancestor with the importer).
  const suffixFile = `/${directFile}`;
  const suffixPkg = `/${directPkg}`;
  let suffixMatch: string | null = null;
  for (const raw of allFilePaths) {
    const f = raw.replace(/\\/g, '/');
    if (suffixMatch === null && (f.endsWith(suffixFile) || f.endsWith(suffixPkg))) {
      suffixMatch = raw;
    }
  }
  return suffixMatch;
}

/**
 * Does the repo contain a module/package named `leadingSegment` somewhere?
 * Used to guard against false-positive suffix matches on external dotted
 * imports (e.g. `django.apps` matching a local `accounts/apps.py`).
 *
 * Checks, in order: `SEGMENT.py` root file, `SEGMENT/__init__.py`
 * regular package, any `SEGMENT/...py` file at the workspace root
 * (namespace package), or any nested `.../SEGMENT/...py` file (nested
 * namespace package, e.g. `backend/services/sync.py` for the leading
 * segment `services`). The nested case is bounded by the explicit
 * `/SEGMENT/` substring check so it does not match arbitrary file
 * basenames.
 */
function hasRepoCandidate(leadingSegment: string, allFilePaths: Set<string>): boolean {
  const prefix = `${leadingSegment}/`;
  const innerSegment = `/${leadingSegment}/`;
  const rootFile = `${leadingSegment}.py`;
  const initFile = `${leadingSegment}/__init__.py`;
  for (const raw of allFilePaths) {
    const f = raw.replace(/\\/g, '/');
    if (f === rootFile || f === initFile) return true;
    if (f.startsWith(prefix) && f.endsWith('.py')) return true;
    if (f.includes(innerSegment) && f.endsWith('.py')) return true;
  }
  return false;
}

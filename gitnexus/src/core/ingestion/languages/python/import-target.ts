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
 *  3. Suffix fallback (first match).
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
  allFilePaths: Set<string>,
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
  allFilePaths: Set<string>,
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

  for (const raw of allFilePaths) {
    const f = raw.replace(/\\/g, '/');
    if (f === rootFile || f === initFile) return true;
    if (f.startsWith(prefix) && f.endsWith('.py')) return true;
    if (f.endsWith('.py')) {
      for (const ap of ancestorPrefixes) {
        if (f.startsWith(ap)) return true;
      }
    }
  }
  return false;
}

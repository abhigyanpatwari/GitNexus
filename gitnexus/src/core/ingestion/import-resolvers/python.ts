/**
 * Python import resolution — PEP 328 relative imports and proximity-based bare imports.
 * Import system spec: PEP 302 (original), PEP 451 (current).
 *
 * Strategy lives in configs/python.ts.
 * This file contains the shared internal helper used by the strategy and tests.
 */

import {
  getPythonFileIndex,
  importerBarePrefixes,
  importerDirOf,
  pythonSegmentAbsent,
} from './python-file-index.js';
import { tryResolveWithExtensions } from './utils.js';

/**
 * Resolve a Python import to a file path (low-level helper).
 *
 * 1. Relative (PEP 328): `.module`, `..module` — 1 dot = current package, each extra dot goes up one level.
 * 2. Proximity bare import: static heuristic — checks the importer's own directory first.
 *    Approximates the common case where co-located files find each other without an installed package.
 *    Single-segment only — multi-segment (e.g. `os.path`) falls through to suffixResolve.
 *    Checks package (__init__.py) before module (.py), matching CPython's finder order (PEP 451 §4).
 *    Coexistence of both is physically impossible (same name = file vs directory), so the order
 *    only matters for spec compliance.
 *    Note: implicit namespace packages (Python 3.3+, directory without __init__.py) are not handled.
 *
 * Returns null to let the caller fall through to suffixResolve.
 */
export function resolvePythonImportInternal(
  currentFile: string,
  importPath: string,
  allFiles: ReadonlySet<string>,
): string | null {
  // Relative import — PEP 328 (https://peps.python.org/pep-0328/)
  if (importPath.startsWith('.')) {
    const dotMatch = importPath.match(/^(\.+)(.*)/);
    if (!dotMatch) return null;

    const dotCount = dotMatch[1].length;
    const modulePart = dotMatch[2];
    const dirParts = currentFile.split('/').slice(0, -1);

    // PEP 328: more dots than directory levels → beyond top-level package → invalid
    if (dotCount - 1 > dirParts.length) return null;
    for (let i = 1; i < dotCount; i++) dirParts.pop();

    if (modulePart) {
      dirParts.push(...modulePart.replace(/\./g, '/').split('/'));
    }

    return tryResolveWithExtensions(dirParts.join('/'), allFiles);
  }

  // Proximity bare import — single-segment only; package before module (PEP 451 §4)
  const pathLike = importPath.replace(/\./g, '/');
  if (pathLike.includes('/')) return null;

  // O(1) proof of absence, before any probing. Every probe below — the two
  // proximity probes and the two per ancestor step — has the shape
  // `<X>/<pathLike>.py` or `<X>/<pathLike>/__init__.py`, and
  // `pythonSegmentAbsent` answers "no file in the workspace has EITHER shape,
  // for any prefix" in two Map lookups on the index the dotted tiers already
  // build. That is `true` for `os`, `sys`, `django` and every other
  // distribution the repo does not vendor — i.e. for most imports in most
  // Python repos — and it retires the whole walk for them instead of running
  // it to the workspace root. It is exact, not a filter: a miss here means
  // every probe the walk would have issued was guaranteed to miss.
  const index = getPythonFileIndex(allFiles);
  if (pythonSegmentAbsent(index, pathLike)) return null;

  // One derivation, shared with the index's other per-directory memo — see
  // `importerDirOf`. It replaced `split('/').slice(0, -1).join('/')`: identical
  // for every input (a path with no separator has no directory, which is `''`
  // both ways) without the per-import array of one element per path component.
  const importerDir = importerDirOf(currentFile);

  // Proximity check — only applies when the importer lives in a subdirectory.
  // Root-level importers (importerDir === '') skip straight to the ancestor
  // walk below, which handles the root case correctly (prefix becomes '').
  if (importerDir) {
    if (allFiles.has(`${importerDir}/${pathLike}/__init__.py`))
      return `${importerDir}/${pathLike}/__init__.py`;
    if (allFiles.has(`${importerDir}/${pathLike}.py`)) return `${importerDir}/${pathLike}.py`;
  }

  // Ancestor directory walk — Python resolves bare imports against sys.path entries,
  // which typically includes the project root and package directories. Walk up from the
  // importer's directory to find the module in an ancestor, preferring the closest match.
  // This prevents cross-language misresolution (e.g., Python `from middleware import X`
  // resolving to a TypeScript middleware.ts via suffix matching). Issue #417.
  //
  // The prefixes come from `importerBarePrefixes`, built ONCE per importer
  // directory per pass and stored in the same index consulted above. Rebuilding
  // them here — `dirParts.slice(0, i).join('/')`, one array and one string per
  // path component — was the last per-import ancestor walk left after #2913.
  for (const prefix of importerBarePrefixes(index, importerDir)) {
    if (allFiles.has(`${prefix}${pathLike}/__init__.py`)) return `${prefix}${pathLike}/__init__.py`;
    if (allFiles.has(`${prefix}${pathLike}.py`)) return `${prefix}${pathLike}.py`;
  }

  return null;
}

/**
 * `resolveImportTarget` adapter for the Dart `ScopeResolver`. Ports the
 * legacy-DAG Dart import logic (`import-resolvers/configs/dart.ts`):
 *
 *   - `dart:` SDK imports          → `null` (external, no edge)
 *   - `package:pkg/path`           → `lib/path` (or bare `path`) matched
 *                                     against the workspace file set
 *   - relative `'foo/bar.dart'`    → resolved against the importer's dir
 *   - `__heritage__:` markers      → `null` (synthetic heritage carrier,
 *                                     consumed by `emitDartHeritageEdges`)
 *
 * The `ScopeResolver` hook signature is `(targetRaw, fromFile, allFilePaths)`;
 * `targetRaw` arrives already quote-stripped from `interpretDartImport`.
 */

import { DART_HERITAGE_PREFIX } from './interpret.js';

function stripQuotes(s: string): string {
  return s.replace(/^['"]|['"]$/g, '');
}

/** Resolve a relative path against the importer's directory, normalizing
 *  `.`/`..` segments, then confirm it exists in the workspace file set. */
function resolveRelative(
  rel: string,
  fromFile: string,
  allFilePaths: ReadonlySet<string>,
): string | null {
  const normFrom = fromFile.replace(/\\/g, '/');
  const fromDir = normFrom.includes('/') ? normFrom.slice(0, normFrom.lastIndexOf('/')) : '';
  const parts = fromDir.length > 0 ? fromDir.split('/') : [];
  for (const seg of rel.replace(/\\/g, '/').split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  const target = parts.join('/');
  if (allFilePaths.has(target)) return target;
  // Suffix fallback for absolute/rooted workspace paths.
  for (const fp of allFilePaths) {
    if (fp === target || fp.endsWith('/' + target)) return fp;
  }
  return null;
}

export function resolveDartImportTarget(
  targetRaw: string,
  fromFile: string,
  allFilePaths: ReadonlySet<string>,
): string | readonly string[] | null {
  if (targetRaw.startsWith(DART_HERITAGE_PREFIX)) return null;

  const stripped = stripQuotes(targetRaw);
  if (stripped === '') return null;

  // Dart SDK imports never resolve to a repo file.
  if (stripped.startsWith('dart:')) return null;

  // `package:pkg/path.dart` → `lib/path.dart` (or bare `path.dart`).
  if (stripped.startsWith('package:')) {
    const slash = stripped.indexOf('/');
    if (slash === -1) return null;
    const relPath = stripped.slice(slash + 1);
    for (const candidate of [`lib/${relPath}`, relPath]) {
      for (const fp of allFilePaths) {
        if (fp === candidate || fp.endsWith('/' + candidate)) return fp;
      }
    }
    return null; // external package
  }

  // Relative import.
  return resolveRelative(stripped, fromFile, allFilePaths);
}

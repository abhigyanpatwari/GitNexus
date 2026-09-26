/**
 * `resolveImportTarget` adapter for the Dart `ScopeResolver`. Ports the
 * Dart import logic:
 *
 *   - `dart:` SDK imports          → `null` (external, no edge)
 *   - `package:pkg/path`           → declared package's exact `lib/path`
 *   - relative `'foo/bar.dart'`    → resolved against the importer's dir
 *   - `__heritage__:` markers      → `null` (synthetic heritage carrier,
 *                                     consumed by `emitDartHeritageEdges`)
 *
 * Package identity comes from the workspace's pubspec resolution config;
 * `targetRaw` arrives already quote-stripped from `interpretDartImport`.
 */

import { perFileSet } from '../../import-resolvers/per-file-set.js';
import { DART_HERITAGE_PREFIX } from './interpret.js';
import type { DartPackageConfig } from './package-config.js';
import { DART_PACKAGE_SCHEME, dartPackageImportName } from './package-uri.js';

/**
 * Basename → files carrying it, in `allFilePaths` iteration order, memoized on
 * the Set's identity (#2879).
 *
 * Relative-path suffix fallback uses this index instead of scanning the
 * workspace for each import. Package imports use exact Set membership only.
 *
 * Bucketing by basename is exact rather than a heuristic: a path satisfying
 * either arm of the match ends with `candidate`, so its last `/`-delimited
 * segment is `candidate`'s. Paths are indexed RAW, without slash normalization,
 * because the scans this replaces compared raw paths too — normalizing here
 * would start resolving backslash paths that previously returned null.
 */
interface DartFileIndex {
  readonly byBasename: Map<string, string[]>;
}

const getDartFileIndex = perFileSet((allFilePaths: ReadonlySet<string>): DartFileIndex => {
  const byBasename = new Map<string, string[]>();
  for (const fp of allFilePaths) {
    const base = fp.slice(fp.lastIndexOf('/') + 1);
    let bucket = byBasename.get(base);
    if (bucket === undefined) {
      bucket = [];
      byBasename.set(base, bucket);
    }
    bucket.push(fp);
  }
  return { byBasename };
});

/** First file (in Set-iteration order) that IS `candidate` or ends with
 *  `/<candidate>` — the exact predicate of the scans this replaces. */
function findByPathSuffix(allFilePaths: ReadonlySet<string>, candidate: string): string | null {
  const bucket = getDartFileIndex(allFilePaths).byBasename.get(
    candidate.slice(candidate.lastIndexOf('/') + 1),
  );
  if (bucket === undefined) return null;
  const suffix = '/' + candidate;
  for (const fp of bucket) {
    if (fp === candidate || fp.endsWith(suffix)) return fp;
  }
  return null;
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
  return findByPathSuffix(allFilePaths, target);
}

export function resolveDartImportTarget(
  targetRaw: string,
  fromFile: string,
  allFilePaths: ReadonlySet<string>,
  resolutionConfig?: unknown,
): string | readonly string[] | null {
  if (targetRaw.startsWith(DART_HERITAGE_PREFIX)) return null;
  // `targetRaw` already arrives quote-stripped from `interpretDartImport`.
  if (targetRaw === '') return null;

  // Dart SDK imports never resolve to a repo file.
  if (targetRaw.startsWith('dart:')) return null;

  // A package URI never falls back to another package's same-named file.
  if (targetRaw.startsWith(DART_PACKAGE_SCHEME)) {
    const packageName = dartPackageImportName(targetRaw);
    if (packageName === null) return null;
    const config = resolutionConfig as DartPackageConfig | undefined;
    const lib = config?.packages?.get(packageName);
    if (lib === undefined) return null;
    const relPath = targetRaw.slice(DART_PACKAGE_SCHEME.length + packageName.length + 1);
    if (
      /[\\%?#:]/.test(relPath) ||
      relPath.split('/').some((part) => part === '' || part === '.' || part === '..')
    )
      return null;
    const candidate = `${lib}/${relPath}`;
    return allFilePaths.has(candidate) ? candidate : null;
  }

  // Relative import.
  return resolveRelative(targetRaw, fromFile, allFilePaths);
}

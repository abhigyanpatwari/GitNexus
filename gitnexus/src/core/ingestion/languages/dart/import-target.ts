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

/**
 * Basename → files carrying it, in `allFilePaths` iteration order, memoized on
 * the Set's identity (#2879).
 *
 * Both resolution legs answered `fp === candidate || fp.endsWith('/' + candidate)`
 * with a full workspace scan, and the `package:` leg ran one scan PER candidate
 * — for an external package both candidates miss, so both scans always ran to
 * completion. The orchestrator passes the same Set to every import in a pass,
 * so the index is built once per run.
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

const DART_FILE_INDEX_CACHE = new WeakMap<ReadonlySet<string>, DartFileIndex>();

function getDartFileIndex(allFilePaths: ReadonlySet<string>): DartFileIndex {
  const cached = DART_FILE_INDEX_CACHE.get(allFilePaths);
  if (cached !== undefined) return cached;
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
  const built: DartFileIndex = { byBasename };
  DART_FILE_INDEX_CACHE.set(allFilePaths, built);
  return built;
}

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
): string | readonly string[] | null {
  if (targetRaw.startsWith(DART_HERITAGE_PREFIX)) return null;
  // `targetRaw` already arrives quote-stripped from `interpretDartImport`.
  if (targetRaw === '') return null;

  // Dart SDK imports never resolve to a repo file.
  if (targetRaw.startsWith('dart:')) return null;

  // `package:pkg/path.dart` → `lib/path.dart` (or bare `path.dart`).
  if (targetRaw.startsWith('package:')) {
    const slash = targetRaw.indexOf('/');
    if (slash === -1) return null;
    const relPath = targetRaw.slice(slash + 1);
    // Candidate priority is load-bearing: `lib/<rel>` before bare `<rel>`.
    for (const candidate of [`lib/${relPath}`, relPath]) {
      const hit = findByPathSuffix(allFilePaths, candidate);
      if (hit !== null) return hit;
    }
    return null; // external package
  }

  // Relative import.
  return resolveRelative(targetRaw, fromFile, allFilePaths);
}

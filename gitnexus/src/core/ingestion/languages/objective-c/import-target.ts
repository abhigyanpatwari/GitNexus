/**
 * Resolve an Objective-C `#import` / `#include` / `@import` to a workspace file.
 *
 * Quoted imports keep the suffix-index first-path tie-break used before the
 * workspace config existed. Angle-bracket imports never suffix-match the
 * source tree — they only hit in-repo frameworks and HEADER_SEARCH_PATHS —
 * so `<Foundation/Foundation.h>` stays unresolved even when a decoy
 * `Foundation.h` exists. `@import` names resolve only through a scanned
 * module map.
 */

import path from 'path';
import { perFileSet } from '../../import-resolvers/per-file-set.js';
import {
  coerceObjectiveCResolutionConfig,
  normalizeRepoPath,
  type ObjectiveCResolutionConfig,
} from './resolution-config.js';

interface ObjectiveCImportIndex {
  readonly filePathSet: ReadonlySet<string>;
  readonly suffixMatches: ReadonlyMap<
    string,
    { readonly filePath: string; readonly order: number }
  >;
}

/**
 * Per-pass memo of `allFilePaths ∪ scanned headers`. Identity is load-bearing
 * for `getObjectiveCImportIndex` (same rule as C/C++ `augmentedFilePathsFor`).
 * This memo stays private to Objective-C — sharing it with C would hand each
 * language the other's suffix index.
 */
const augmentedFilePathsFor = perFileSet((allFilePaths: ReadonlySet<string>) =>
  perFileSet((headerPaths: ReadonlySet<string>): ReadonlySet<string> => {
    const set = new Set(allFilePaths);
    for (const header of headerPaths) set.add(header);
    return set;
  }),
);

const getObjectiveCImportIndex = perFileSet(
  (allFilePaths: ReadonlySet<string>): ObjectiveCImportIndex => {
    const filePaths = [...allFilePaths];
    const suffixMatches = new Map<string, { readonly filePath: string; readonly order: number }>();
    for (const [order, filePath] of filePaths.entries()) {
      const segments = normalizeRepoPath(filePath).split('/');
      for (let start = 1; start < segments.length; start++) {
        const suffix = segments.slice(start).join('/');
        if (!suffixMatches.has(suffix)) suffixMatches.set(suffix, { filePath, order });
      }
    }
    return { filePathSet: new Set(filePaths), suffixMatches };
  },
);

export function resolveObjectiveCImportTarget(
  targetRaw: string,
  fromFile: string,
  allFilePaths: ReadonlySet<string>,
  resolutionConfig?: unknown,
): string | null {
  const target = targetRaw.trim();
  if (target.length === 0) return null;

  const config = coerceObjectiveCResolutionConfig(resolutionConfig);
  const searchPaths =
    config !== undefined && config.headers.size > 0
      ? augmentedFilePathsFor(allFilePaths)(config.headers)
      : allFilePaths;

  if (target.startsWith('<') && target.endsWith('>')) {
    return resolveAngleImport(target.slice(1, -1), searchPaths, config);
  }

  const looksLikeFileImport =
    target.startsWith('.') || target.includes('/') || path.posix.extname(target).length > 0;
  if (!looksLikeFileImport) {
    return resolveModuleImport(target, searchPaths, config);
  }

  return findImportCandidate(target, fromFile, getObjectiveCImportIndex(searchPaths), config);
}

function resolveAngleImport(
  inner: string,
  searchPaths: ReadonlySet<string>,
  config: ObjectiveCResolutionConfig | undefined,
): string | null {
  const normalized = normalizeRepoPath(inner);
  if (normalized.length === 0 || config === undefined) return null;

  const slash = normalized.indexOf('/');
  if (slash > 0) {
    const framework = normalized.slice(0, slash);
    const rest = normalized.slice(slash + 1);
    const headersDir = config.frameworks.get(framework);
    if (headersDir !== undefined) {
      const framed = normalizeRepoPath(`${headersDir}/${rest}`);
      if (searchPaths.has(framed)) return framed;
    }
  }

  for (const searchPath of config.headerSearchPaths) {
    const candidate = normalizeRepoPath(`${searchPath}/${normalized}`);
    if (searchPaths.has(candidate)) return candidate;
  }
  return null;
}

function resolveModuleImport(
  moduleName: string,
  searchPaths: ReadonlySet<string>,
  config: ObjectiveCResolutionConfig | undefined,
): string | null {
  if (config === undefined) return null;
  const exact = config.modules.get(moduleName);
  if (exact !== undefined && searchPaths.has(exact)) return exact;
  const root = moduleName.split('.')[0];
  if (root === undefined || root === moduleName) return null;
  const fallback = config.modules.get(root);
  return fallback !== undefined && searchPaths.has(fallback) ? fallback : null;
}

function findImportCandidate(
  targetRaw: string,
  fromFile: string,
  importIndex: ObjectiveCImportIndex,
  config: ObjectiveCResolutionConfig | undefined,
): string | null {
  const normalizedTarget = normalizeRepoPath(targetRaw);
  const fromDir = normalizeRepoPath(path.posix.dirname(normalizeRepoPath(fromFile)));
  const spelledCandidates = new Set<string>([
    normalizeRepoPath(path.posix.join(fromDir, normalizedTarget)),
    normalizedTarget,
  ]);
  if (config !== undefined) {
    for (const searchPath of [...config.userHeaderSearchPaths, ...config.headerSearchPaths]) {
      spelledCandidates.add(normalizeRepoPath(`${searchPath}/${normalizedTarget}`));
    }
  }
  const ext = path.posix.extname(normalizedTarget);
  if (ext.length === 0) {
    for (const base of [...spelledCandidates]) {
      spelledCandidates.add(`${base}.h`);
      spelledCandidates.add(`${base}.m`);
      spelledCandidates.add(`${base}.mm`);
    }
  }
  for (const candidate of spelledCandidates) {
    if (importIndex.filePathSet.has(candidate)) return candidate;
  }
  let suffixMatch: { readonly filePath: string; readonly order: number } | undefined;
  for (const candidate of spelledCandidates) {
    const match = importIndex.suffixMatches.get(candidate);
    if (match !== undefined && (suffixMatch === undefined || match.order < suffixMatch.order)) {
      suffixMatch = match;
    }
  }
  return suffixMatch?.filePath ?? null;
}

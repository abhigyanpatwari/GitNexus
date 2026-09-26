import { dirname, join } from 'path';
import { perFileSet } from '../../import-resolvers/per-file-set.js';
import {
  collapseRepoPath,
  normalizeRepoPath,
  type CTranslationUnitPaths,
} from './resolution-config.js';

/**
 * A workspace file path pre-decomposed for the suffix-match fallback:
 * `original` is returned verbatim (preserving the prior `bestMatch = filePath`
 * contract); `normalized` and `depth` are precomputed so the hot path does no
 * per-element regex/`split`.
 */
export interface CSuffixCandidate {
  original: string;
  normalized: string;
  depth: number;
}

export type CIncludeSuffixIndex = (
  allFilePaths: ReadonlySet<string>,
) => Map<string, CSuffixCandidate[]>;

/**
 * Basename buckets for quoted `#include "…"` suffix fallback.
 *
 * The builder is shared. Each language keeps its own memo: C++ calls
 * `resolveCFamilyImport` with the index it created here, so a C pass and a
 * C++ pass never read each other's map even when handed the same set.
 */
export function createCIncludeSuffixIndex(): CIncludeSuffixIndex {
  return perFileSet((allFilePaths: ReadonlySet<string>) => {
    const index = new Map<string, CSuffixCandidate[]>();
    for (const original of allFilePaths) {
      const normalized = original.replace(/\\/g, '/');
      const basename = normalized.slice(normalized.lastIndexOf('/') + 1);
      let bucket = index.get(basename);
      if (bucket === undefined) {
        bucket = [];
        index.set(basename, bucket);
      }
      bucket.push({ original, normalized, depth: normalized.split('/').length });
    }
    return index;
  });
}

const cSuffixIndex = createCIncludeSuffixIndex();

/** Optional search roots. Absent means "quoted include, no declared paths". */
export interface CIncludeLookup {
  /** `#include <…>`. Never suffix-matches the workspace. */
  readonly isSystem?: boolean;
  /** Fallback `-I` / `-isystem` / `/I` and implicit roots. */
  readonly headerSearchPaths?: readonly string[];
  /** Fallback `-iquote`. Quoted includes only. */
  readonly userHeaderSearchPaths?: readonly string[];
  /**
   * Per translation unit. A hit replaces the fallback lists for that file.
   * The map is the one built at config load — lookup does not copy it.
   */
  readonly translationUnits?: ReadonlyMap<string, CTranslationUnitPaths>;
}

/**
 * Resolve a C #include path to a file in the workspace.
 *
 * Quoted `#include "…"` (the default when `lookup` is omitted, which is
 * what the import-target bench and the older unit tests call):
 *   1. Same directory as the including file
 *   2. User search paths, then header search paths
 *   3. Exact path, then the basename bucket
 *
 * Angle `#include <…>` (`lookup.isSystem`): join the target onto each
 * header search path and return that file, or null. A same-named header
 * under `src/` is not a candidate when `src` is not a search path.
 */
export function cIncludeLookupFromConfig(
  config:
    | {
        readonly headerSearchPaths?: readonly string[];
        readonly userHeaderSearchPaths?: readonly string[];
        readonly translationUnits?: ReadonlyMap<string, CTranslationUnitPaths>;
      }
    | undefined,
  isSystem: boolean,
): CIncludeLookup {
  return {
    isSystem,
    headerSearchPaths: config?.headerSearchPaths,
    userHeaderSearchPaths: config?.userHeaderSearchPaths,
    translationUnits: config?.translationUnits,
  };
}

export function resolveCImportTarget(
  targetRaw: string,
  fromFile: string,
  allFilePaths: ReadonlySet<string>,
  lookup?: CIncludeLookup,
): string | null {
  return resolveCFamilyImport(targetRaw, fromFile, allFilePaths, lookup, cSuffixIndex);
}

export function resolveCFamilyImport(
  targetRaw: string,
  fromFile: string,
  allFilePaths: ReadonlySet<string>,
  lookup: CIncludeLookup | undefined,
  suffixIndex: CIncludeSuffixIndex,
): string | null {
  if (!targetRaw) return null;

  const normalizedTarget = targetRaw.replace(/\\/g, '/');
  const lists = listsFor(lookup, fromFile);

  if (lookup?.isSystem === true) {
    return matchSearchPaths(normalizedTarget, lists.header, allFilePaths);
  }

  // Same-directory sibling first: mirrors the C compiler's #include "…"
  // relative-lookup semantics where the directory of the including
  // file is searched before the include-path list.
  if (fromFile) {
    const siblingRaw = join(dirname(fromFile), targetRaw);
    const sibling = siblingRaw.replace(/\\/g, '/');
    if (allFilePaths.has(sibling)) return sibling;
    // When targetRaw contains backslashes, the normalized form may
    // resolve to a different sibling path — try it as well.
    if (targetRaw !== normalizedTarget) {
      const siblingAlt = join(dirname(fromFile), normalizedTarget);
      const siblingAltNorm = siblingAlt.replace(/\\/g, '/');
      if (allFilePaths.has(siblingAltNorm)) return siblingAltNorm;
    }
  }

  const onUserPath =
    lists.user.length === 0 ? null : matchSearchPaths(normalizedTarget, lists.user, allFilePaths);
  if (onUserPath !== null) return onUserPath;
  const onHeaderPath =
    lists.header.length === 0
      ? null
      : matchSearchPaths(normalizedTarget, lists.header, allFilePaths);
  if (onHeaderPath !== null) return onHeaderPath;

  // Exact match (path as-is in the workspace)
  if (allFilePaths.has(normalizedTarget)) return normalizedTarget;

  // Suffix match: find files ending with /targetRaw or equal to targetRaw.
  // A path can only match `=== normalizedTarget` or `endsWith('/'+target)` if
  // its basename equals the target's last segment, so we inspect only that
  // basename bucket (built once per pass) instead of scanning every workspace
  // path. Match condition + tie-break (fewest path components, then
  // lexicographic on the normalized path) are byte-identical to the prior scan.
  const suffix = '/' + normalizedTarget;
  const targetBasename = normalizedTarget.slice(normalizedTarget.lastIndexOf('/') + 1);
  const bucket = suffixIndex(allFilePaths).get(targetBasename);
  if (bucket === undefined) return null;

  let bestMatch: string | null = null;
  let bestDepth = Infinity;
  let bestNormalized = '';

  for (const cand of bucket) {
    if (cand.normalized === normalizedTarget || cand.normalized.endsWith(suffix)) {
      // Prefer shortest path (closest match)
      if (
        cand.depth < bestDepth ||
        (cand.depth === bestDepth && cand.normalized < bestNormalized)
      ) {
        bestDepth = cand.depth;
        bestMatch = cand.original;
        bestNormalized = cand.normalized;
      }
    }
  }

  return bestMatch;
}

function listsFor(
  lookup: CIncludeLookup | undefined,
  fromFile: string,
): { readonly header: readonly string[]; readonly user: readonly string[] } {
  const units = lookup?.translationUnits;
  if (units !== undefined && units.size > 0) {
    const unit = units.get(normalizeRepoPath(fromFile));
    if (unit !== undefined) {
      return { header: unit.headerSearchPaths, user: unit.userHeaderSearchPaths };
    }
  }
  return {
    header: lookup?.headerSearchPaths ?? [],
    user: lookup?.userHeaderSearchPaths ?? [],
  };
}

function matchSearchPaths(
  normalizedTarget: string,
  roots: readonly string[],
  allFilePaths: ReadonlySet<string>,
): string | null {
  if (roots.length === 0 || normalizedTarget.length === 0) return null;
  for (const root of roots) {
    const candidate = joinSearch(root, normalizedTarget);
    if (candidate !== undefined && candidate.length > 0 && allFilePaths.has(candidate)) {
      return candidate;
    }
  }
  return null;
}

function joinSearch(root: string, target: string): string | undefined {
  if (root.length === 0 || root === '.') return collapseRepoPath(target);
  return collapseRepoPath(`${root}/${target}`);
}

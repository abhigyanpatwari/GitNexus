import { dirname, join } from 'path';

/**
 * A workspace file path pre-decomposed for the suffix-match fallback:
 * `original` is returned verbatim (preserving the prior `bestMatch = filePath`
 * contract); `normalized` and `depth` are precomputed so the hot path does no
 * per-element regex/`split`.
 */
interface CSuffixCandidate {
  original: string;
  normalized: string;
  depth: number;
}

/**
 * Per-pass memo: workspace paths bucketed by basename (last path segment),
 * keyed on the `allFilePaths` set identity.
 *
 * `resolveCImportTarget` is called once per (quoted) C/C++ `#include` with the
 * same `allFilePaths` set per pass (the augmented set is itself memoized in
 * the C resolver). The old suffix-match fallback scanned ALL workspace paths
 * per include — with a per-element `.replace`/`.split` and no early exit
 * (the fewest-path-components tie-break forces a full scan) — i.e.
 * O(R_suffix × (F+H)). A path can satisfy `endsWith('/'+target)` (or equal
 * the target) ONLY IF its basename equals the target's last segment, so we
 * pre-bucket by basename once (O(F+H), `normalized`/`depth` precomputed) and
 * the fallback inspects a single small bucket → O(F+H) build + ~O(1)/include.
 * `WeakMap`-keyed so it is reclaimed with the pass (no cross-pass staleness).
 * Shared by C and C++ (`resolveCppImportTarget` delegates here).
 */
const suffixIndexByPaths = new WeakMap<ReadonlySet<string>, Map<string, CSuffixCandidate[]>>();

function suffixIndex(allFilePaths: ReadonlySet<string>): Map<string, CSuffixCandidate[]> {
  let index = suffixIndexByPaths.get(allFilePaths);
  if (index === undefined) {
    index = new Map<string, CSuffixCandidate[]>();
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
    suffixIndexByPaths.set(allFilePaths, index);
  }
  return index;
}

/**
 * Resolve a C #include path to a file in the workspace.
 *
 * Strategy:
 * 1. Check for a same-directory sibling relative to the including file
 *    (matches C compiler `#include "…"` relative-lookup semantics).
 * 2. Check for an exact match (path as-is in the workspace).
 * 3. Fall back to suffix matching against all workspace file paths.
 *    Tie-breaking: prefer the match with the fewest path components
 *    (closest to root). On equal depth, break ties lexicographically
 *    by normalized path to ensure deterministic resolution regardless
 *    of filesystem iteration order.
 */
export function resolveCImportTarget(
  targetRaw: string,
  fromFile: string,
  allFilePaths: ReadonlySet<string>,
): string | null {
  if (!targetRaw) return null;

  const normalizedTarget = targetRaw.replace(/\\/g, '/');

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

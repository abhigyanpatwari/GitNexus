import { dirname, join } from 'path';

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

  // Suffix match: find files ending with /targetRaw or equal to targetRaw
  const suffix = '/' + normalizedTarget;
  let bestMatch: string | null = null;
  let bestDepth = Infinity;
  let bestNormalized = '';

  for (const filePath of allFilePaths) {
    const normalized = filePath.replace(/\\/g, '/');
    if (normalized === normalizedTarget || normalized.endsWith(suffix)) {
      // Prefer shortest path (closest match)
      const depth = normalized.split('/').length;
      if (depth < bestDepth || (depth === bestDepth && normalized < bestNormalized)) {
        bestDepth = depth;
        bestMatch = filePath;
        bestNormalized = normalized;
      }
    }
  }

  return bestMatch;
}

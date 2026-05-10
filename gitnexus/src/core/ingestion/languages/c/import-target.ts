/**
 * Resolve a C #include path to a file in the workspace.
 *
 * Strategy: match the include path suffix against all file paths in
 * the workspace. "foo.h" matches "src/foo.h", "include/foo.h", etc.
 * For paths with directory components ("dir/foo.h"), match the full
 * relative suffix.
 */
export function resolveCImportTarget(
  targetRaw: string,
  _fromFile: string,
  allFilePaths: ReadonlySet<string>,
): string | null {
  if (!targetRaw) return null;

  const normalizedTarget = targetRaw.replace(/\\/g, '/');

  // Exact match first
  if (allFilePaths.has(normalizedTarget)) return normalizedTarget;

  // Suffix match: find files ending with /targetRaw or equal to targetRaw
  const suffix = '/' + normalizedTarget;
  let bestMatch: string | null = null;
  let bestDepth = Infinity;

  for (const filePath of allFilePaths) {
    const normalized = filePath.replace(/\\/g, '/');
    if (normalized === normalizedTarget || normalized.endsWith(suffix)) {
      // Prefer shortest path (closest match)
      const depth = normalized.split('/').length;
      if (depth < bestDepth) {
        bestDepth = depth;
        bestMatch = filePath;
      }
    }
  }

  return bestMatch;
}

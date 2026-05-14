import { resolveCImportTarget } from '../c/import-target.js';

/**
 * Resolve a C++ #include path to a file in the workspace.
 * C++ #include path resolution is identical to C:
 *   1. Same-directory sibling (relative lookup)
 *   2. Exact match
 *   3. Suffix match with depth + lexicographic tiebreak
 *
 * Re-exports the C implementation since the #include semantics are shared.
 */
export function resolveCppImportTarget(
  targetRaw: string,
  fromFile: string,
  allFilePaths: ReadonlySet<string>,
): string | null {
  return resolveCImportTarget(targetRaw, fromFile, allFilePaths);
}

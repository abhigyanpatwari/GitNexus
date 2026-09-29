import {
  createCIncludeSuffixIndex,
  resolveCFamilyImport,
  type CIncludeLookup,
} from '../c/import-target.js';

/**
 * C++ `#include` resolution is the C lookup. This module's own suffix
 * index is the one thing that is not shared: the memo is keyed on the
 * file set, and one map for both languages would hand each the other's
 * index when a test passes the same set to both.
 */
const cppSuffixIndex = createCIncludeSuffixIndex();

export function resolveCppImportTarget(
  targetRaw: string,
  fromFile: string,
  allFilePaths: ReadonlySet<string>,
  lookup?: CIncludeLookup,
): string | null {
  return resolveCFamilyImport(targetRaw, fromFile, allFilePaths, lookup, cppSuffixIndex);
}

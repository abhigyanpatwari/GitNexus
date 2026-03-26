/**
 * Shared utilities for import resolution.
 * Extracted from import-processor.ts to reduce file size.
 */

import type { SyntaxNode } from '../utils/ast-helpers.js';

/** All file extensions to try during resolution */
export const EXTENSIONS = [
  '',
  // TypeScript/JavaScript
  '.tsx', '.ts', '.jsx', '.js', '/index.tsx', '/index.ts', '/index.jsx', '/index.js',
  // Python
  '.py', '/__init__.py',
  // Java
  '.java',
  // Kotlin
  '.kt', '.kts',
  // C/C++
  '.c', '.h', '.cpp', '.hpp', '.cc', '.cxx', '.hxx', '.hh',
  // C#
  '.cs',
  // Go
  '.go',
  // Rust
  '.rs', '/mod.rs',
  // PHP
  '.php', '.phtml',
  // Swift
  '.swift',
  // Ruby
  '.rb',
];

/**
 * Try to match a path (with extensions) against the known file set.
 * Returns the matched file path or null.
 */
export function tryResolveWithExtensions(
  basePath: string,
  allFiles: Set<string>,
): string | null {
  for (const ext of EXTENSIONS) {
    const candidate = basePath + ext;
    if (allFiles.has(candidate)) return candidate;
  }
  return null;
}

/**
 * Build a suffix index for O(1) endsWith lookups.
 * Maps every possible path suffix to its original file path.
 * e.g. for "src/com/example/Foo.java":
 *   "Foo.java" -> "src/com/example/Foo.java"
 *   "example/Foo.java" -> "src/com/example/Foo.java"
 *   "com/example/Foo.java" -> "src/com/example/Foo.java"
 *   etc.
 */
export interface SuffixIndex {
  /** Exact suffix lookup (case-sensitive) */
  get(suffix: string): string | undefined;
  /** Case-insensitive suffix lookup */
  getInsensitive(suffix: string): string | undefined;
  /** Get all files in a directory suffix */
  getFilesInDir(dirSuffix: string, extension: string): string[];
}

const FROZEN_EMPTY_ARRAY: string[] = Object.freeze([]) as string[];

/** Sentinel index that returns no results. Used to release memory after import resolution. */
export const EMPTY_INDEX: SuffixIndex = Object.freeze({
  get: () => undefined,
  getInsensitive: () => undefined,
  getFilesInDir: () => FROZEN_EMPTY_ARRAY,
});

export function buildSuffixIndex(normalizedFileList: string[], allFileList: string[]): SuffixIndex {
  // Map: normalized suffix -> original file path
  const exactMap = new Map<string, string>();
  // Map: lowercase suffix -> original file path
  const lowerMap = new Map<string, string>();
  // Map: directory suffix -> list of file paths in that directory
  const dirMap = new Map<string, string[]>();

  for (let i = 0; i < normalizedFileList.length; i++) {
    const normalized = normalizedFileList[i];
    const original = allFileList[i];
    const parts = normalized.split('/');

    // Index all suffixes: "a/b/c.java" -> ["c.java", "b/c.java", "a/b/c.java"]
    for (let j = parts.length - 1; j >= 0; j--) {
      const suffix = parts.slice(j).join('/');
      // Only store first match (longest path wins for ambiguous suffixes)
      if (!exactMap.has(suffix)) {
        exactMap.set(suffix, original);
      }
      const lower = suffix.toLowerCase();
      if (!lowerMap.has(lower)) {
        lowerMap.set(lower, original);
      }
    }

    // Index directory membership
    const lastSlash = normalized.lastIndexOf('/');
    if (lastSlash >= 0) {
      // Build all directory suffixes
      const dirParts = parts.slice(0, -1);
      const fileName = parts[parts.length - 1];
      const ext = fileName.substring(fileName.lastIndexOf('.'));

      for (let j = dirParts.length - 1; j >= 0; j--) {
        const dirSuffix = dirParts.slice(j).join('/');
        const key = `${dirSuffix}:${ext}`;
        let list = dirMap.get(key);
        if (!list) {
          list = [];
          dirMap.set(key, list);
        }
        list.push(original);
      }
    }
  }

  return {
    get: (suffix: string) => exactMap.get(suffix),
    getInsensitive: (suffix: string) => lowerMap.get(suffix.toLowerCase()),
    getFilesInDir: (dirSuffix: string, extension: string) => {
      return dirMap.get(`${dirSuffix}:${extension}`) || [];
    },
  };
}

/**
 * Suffix-based resolution using index. O(1) per lookup instead of O(files).
 */
export function suffixResolve(
  pathParts: string[],
  normalizedFileList: string[],
  allFileList: string[],
  index?: SuffixIndex,
): string | null {
  if (index) {
    for (let i = 0; i < pathParts.length; i++) {
      const suffix = pathParts.slice(i).join('/');
      for (const ext of EXTENSIONS) {
        const suffixWithExt = suffix + ext;
        const result = index.get(suffixWithExt) || index.getInsensitive(suffixWithExt);
        if (result) return result;
      }
    }
    return null;
  }

  // Fallback: linear scan (for backward compatibility)
  for (let i = 0; i < pathParts.length; i++) {
    const suffix = pathParts.slice(i).join('/');
    for (const ext of EXTENSIONS) {
      const suffixWithExt = suffix + ext;
      const suffixPattern = '/' + suffixWithExt;
      const matchIdx = normalizedFileList.findIndex(filePath =>
        filePath.endsWith(suffixPattern) || filePath.toLowerCase().endsWith(suffixPattern.toLowerCase())
      );
      if (matchIdx !== -1) {
        return allFileList[matchIdx];
      }
    }
  }
  return null;
}


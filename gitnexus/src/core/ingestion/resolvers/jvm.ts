/**
 * JVM import resolution (Java + Kotlin).
 * Handles wildcard imports, member/static imports, and Kotlin-specific patterns.
 */

import type { SuffixIndex } from './utils.js';

/** Kotlin file extensions for JVM resolver reuse */
export const KOTLIN_EXTENSIONS: readonly string[] = ['.kt', '.kts'];

/**
 * Append .* to a Kotlin import path if the AST has a wildcard_import sibling node.
 * Pure function — returns a new string without mutating the input.
 */
export const appendKotlinWildcard = (importPath: string, importNode: any): string => {
  for (let i = 0; i < importNode.childCount; i++) {
    if (importNode.child(i)?.type === 'wildcard_import') {
      return importPath.endsWith('.*') ? importPath : `${importPath}.*`;
    }
  }
  return importPath;
};

/**
 * Resolve a JVM wildcard import (com.example.*) to all matching files.
 * Works for both Java (.java) and Kotlin (.kt, .kts).
 */
export function resolveJvmWildcard(
  importPath: string,
  normalizedFileList: string[],
  allFileList: string[],
  extensions: readonly string[],
  index?: SuffixIndex,
): string[] {
  // "com.example.util.*" -> "com/example/util"
  const packagePath = importPath.slice(0, -2).replace(/\./g, '/');

  if (index) {
    const candidates = extensions.flatMap(ext => index.getFilesInDir(packagePath, ext));
    // Filter to only direct children (no subdirectories)
    const packageSuffix = '/' + packagePath + '/';
    return candidates.filter(f => {
      const normalized = f.replace(/\\/g, '/');
      const idx = normalized.indexOf(packageSuffix);
      if (idx < 0) return false;
      const afterPkg = normalized.substring(idx + packageSuffix.length);
      return !afterPkg.includes('/');
    });
  }

  // Fallback: linear scan
  const packageSuffix = '/' + packagePath + '/';
  const matches: string[] = [];
  for (let i = 0; i < normalizedFileList.length; i++) {
    const normalized = normalizedFileList[i];
    if (normalized.includes(packageSuffix) &&
        extensions.some(ext => normalized.endsWith(ext))) {
      const afterPackage = normalized.substring(normalized.indexOf(packageSuffix) + packageSuffix.length);
      if (!afterPackage.includes('/')) {
        matches.push(allFileList[i]);
      }
    }
  }
  return matches;
}

/**
 * Try to resolve a JVM member/static import by stripping the member name.
 * Java: "com.example.Constants.VALUE" -> resolve "com.example.Constants"
 * Kotlin: "com.example.Constants.VALUE" -> resolve "com.example.Constants"
 */
export function resolveJvmMemberImport(
  importPath: string,
  normalizedFileList: string[],
  allFileList: string[],
  extensions: readonly string[],
  index?: SuffixIndex,
): string | null {
  // Member imports: com.example.Constants.VALUE or com.example.Constants.*
  // The last segment is a member name if it starts with lowercase, is ALL_CAPS, or is a wildcard
  const segments = importPath.split('.');
  if (segments.length < 3) return null;

  const lastSeg = segments[segments.length - 1];
  if (lastSeg === '*' || /^[a-z]/.test(lastSeg) || /^[A-Z_]+$/.test(lastSeg)) {
    const classPath = segments.slice(0, -1).join('/');

    for (const ext of extensions) {
      const classSuffix = classPath + ext;
      if (index) {
        const result = index.get(classSuffix) || index.getInsensitive(classSuffix);
        if (result) return result;
      } else {
        const fullSuffix = '/' + classSuffix;
        for (let i = 0; i < normalizedFileList.length; i++) {
          if (normalizedFileList[i].endsWith(fullSuffix) ||
              normalizedFileList[i].toLowerCase().endsWith(fullSuffix.toLowerCase())) {
            return allFileList[i];
          }
        }
      }
    }
  }

  return null;
}

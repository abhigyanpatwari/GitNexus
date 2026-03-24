/**
 * JVM import resolution (Java + Kotlin).
 * Handles wildcard imports, member/static imports, and Kotlin-specific patterns.
 */

import type { SuffixIndex } from './utils.js';
import type { SyntaxNode } from '../utils/ast-helpers.js';
import { SupportedLanguages } from '../../../config/supported-languages.js';
import type { ImportResult, ResolveCtx } from './types.js';
import { resolveStandard } from './standard.js';

/** Kotlin file extensions for JVM resolver reuse */
export const KOTLIN_EXTENSIONS: readonly string[] = ['.kt', '.kts'];

/**
 * Append .* to a Kotlin import path if the AST has a wildcard_import sibling node.
 * Pure function — returns a new string without mutating the input.
 */
export const appendKotlinWildcard = (importPath: string, importNode: SyntaxNode): string => {
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
    const packagePrefix = packagePath + '/';
    return candidates.filter(f => {
      const normalized = f.replace(/\\/g, '/');
      // Match both nested (src/models/User.kt) and root-level (models/User.kt) packages
      let afterPkg: string;
      const idx = normalized.lastIndexOf(packageSuffix);
      if (idx >= 0) {
        afterPkg = normalized.substring(idx + packageSuffix.length);
      } else if (normalized.startsWith(packagePrefix)) {
        afterPkg = normalized.substring(packagePrefix.length);
      } else {
        return false;
      }
      return !afterPkg.includes('/');
    });
  }

  // Fallback: linear scan
  const packageSuffix = '/' + packagePath + '/';
  const packagePrefix = packagePath + '/';
  const matches: string[] = [];
  for (let i = 0; i < normalizedFileList.length; i++) {
    const normalized = normalizedFileList[i];
    if (!extensions.some(ext => normalized.endsWith(ext))) continue;
    // Match both nested (src/models/User.kt) and root-level (models/User.kt) packages
    let afterPackage: string | null = null;
    if (normalized.includes(packageSuffix)) {
      afterPackage = normalized.substring(normalized.lastIndexOf(packageSuffix) + packageSuffix.length);
    } else if (normalized.startsWith(packagePrefix)) {
      afterPackage = normalized.substring(packagePrefix.length);
    }
    if (afterPackage !== null && !afterPackage.includes('/')) {
      matches.push(allFileList[i]);
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

/** Java: JVM wildcard -> member import -> standard fallthrough */
export function resolveJavaImport(
  rawImportPath: string,
  filePath: string,
  ctx: ResolveCtx,
): ImportResult {
  if (rawImportPath.endsWith('.*')) {
    const matchedFiles = resolveJvmWildcard(rawImportPath, ctx.normalizedFileList, ctx.allFileList, ['.java'], ctx.index);
    if (matchedFiles.length > 0) return { kind: 'files', files: matchedFiles };
  } else {
    const memberResolved = resolveJvmMemberImport(rawImportPath, ctx.normalizedFileList, ctx.allFileList, ['.java'], ctx.index);
    if (memberResolved) return { kind: 'files', files: [memberResolved] };
  }
  return resolveStandard(rawImportPath, filePath, ctx, SupportedLanguages.Java);
}

/**
 * Kotlin: JVM wildcard/member with Java-interop fallback -> top-level function imports -> standard.
 * Kotlin can import from .kt/.kts files OR from .java files (Java interop).
 */
export function resolveKotlinImport(
  rawImportPath: string,
  filePath: string,
  ctx: ResolveCtx,
): ImportResult {
  if (rawImportPath.endsWith('.*')) {
    const matchedFiles = resolveJvmWildcard(rawImportPath, ctx.normalizedFileList, ctx.allFileList, KOTLIN_EXTENSIONS, ctx.index);
    if (matchedFiles.length === 0) {
      const javaMatches = resolveJvmWildcard(rawImportPath, ctx.normalizedFileList, ctx.allFileList, ['.java'], ctx.index);
      if (javaMatches.length > 0) return { kind: 'files', files: javaMatches };
    }
    if (matchedFiles.length > 0) return { kind: 'files', files: matchedFiles };
  } else {
    let memberResolved = resolveJvmMemberImport(rawImportPath, ctx.normalizedFileList, ctx.allFileList, KOTLIN_EXTENSIONS, ctx.index);
    if (!memberResolved) {
      memberResolved = resolveJvmMemberImport(rawImportPath, ctx.normalizedFileList, ctx.allFileList, ['.java'], ctx.index);
    }
    if (memberResolved) return { kind: 'files', files: [memberResolved] };

    // Kotlin: top-level function imports (e.g. import models.getUser) have only 2 segments,
    // which resolveJvmMemberImport skips (requires >=3). Fall back to package-directory scan
    // for lowercase last segments (function/property imports). Uppercase last segments
    // (class imports like models.User) fall through to standard suffix resolution.
    const segments = rawImportPath.split('.');
    const lastSeg = segments[segments.length - 1];
    if (segments.length >= 2 && lastSeg[0] && lastSeg[0] === lastSeg[0].toLowerCase()) {
      const pkgWildcard = segments.slice(0, -1).join('.') + '.*';
      let dirFiles = resolveJvmWildcard(pkgWildcard, ctx.normalizedFileList, ctx.allFileList, KOTLIN_EXTENSIONS, ctx.index);
      if (dirFiles.length === 0) {
        dirFiles = resolveJvmWildcard(pkgWildcard, ctx.normalizedFileList, ctx.allFileList, ['.java'], ctx.index);
      }
      if (dirFiles.length > 0) return { kind: 'files', files: dirFiles };
    }
  }
  return resolveStandard(rawImportPath, filePath, ctx, SupportedLanguages.Kotlin);
}

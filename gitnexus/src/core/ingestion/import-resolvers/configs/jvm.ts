/**
 * Java / Kotlin import resolution configs.
 * JVM-specific wildcard/member strategy, then standard fallback.
 */

import { SupportedLanguages } from 'gitnexus-shared';
import type { ImportResolutionConfig, ImportResolverStrategy } from '../types.js';
import { createStandardStrategy } from '../standard.js';
import { resolveJvmWildcard, resolveJvmMemberImport, KOTLIN_EXTENSIONS } from '../jvm.js';

/** Java JVM resolution strategy — wildcard and member import resolution. */
export const javaJvmStrategy: ImportResolverStrategy = (rawImportPath, _filePath, ctx) => {
  if (rawImportPath.endsWith('.*')) {
    const matchedFiles = resolveJvmWildcard(
      rawImportPath,
      ctx.normalizedFileList,
      ctx.allFileList,
      ['.java'],
      ctx.index,
    );
    if (matchedFiles.length > 0) return { kind: 'files', files: matchedFiles };
  } else {
    const memberResolved = resolveJvmMemberImport(
      rawImportPath,
      ctx.normalizedFileList,
      ctx.allFileList,
      ['.java'],
      ctx.index,
    );
    if (memberResolved) return { kind: 'files', files: [memberResolved] };
  }
  return null;
};

/**
 * Kotlin JVM resolution strategy — wildcard/member with Java-interop + top-level function imports.
 */
export const kotlinJvmStrategy: ImportResolverStrategy = (rawImportPath, _filePath, ctx) => {
  if (rawImportPath.endsWith('.*')) {
    const matchedFiles = resolveJvmWildcard(
      rawImportPath,
      ctx.normalizedFileList,
      ctx.allFileList,
      KOTLIN_EXTENSIONS,
      ctx.index,
    );
    if (matchedFiles.length === 0) {
      const javaMatches = resolveJvmWildcard(
        rawImportPath,
        ctx.normalizedFileList,
        ctx.allFileList,
        ['.java'],
        ctx.index,
      );
      if (javaMatches.length > 0) return { kind: 'files', files: javaMatches };
    }
    if (matchedFiles.length > 0) return { kind: 'files', files: matchedFiles };
  } else {
    let memberResolved = resolveJvmMemberImport(
      rawImportPath,
      ctx.normalizedFileList,
      ctx.allFileList,
      KOTLIN_EXTENSIONS,
      ctx.index,
    );
    if (!memberResolved) {
      memberResolved = resolveJvmMemberImport(
        rawImportPath,
        ctx.normalizedFileList,
        ctx.allFileList,
        ['.java'],
        ctx.index,
      );
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
      let dirFiles = resolveJvmWildcard(
        pkgWildcard,
        ctx.normalizedFileList,
        ctx.allFileList,
        KOTLIN_EXTENSIONS,
        ctx.index,
      );
      if (dirFiles.length === 0) {
        dirFiles = resolveJvmWildcard(
          pkgWildcard,
          ctx.normalizedFileList,
          ctx.allFileList,
          ['.java'],
          ctx.index,
        );
      }
      if (dirFiles.length > 0) return { kind: 'files', files: dirFiles };
    }
  }
  return null;
};

export const javaImportConfig: ImportResolutionConfig = {
  language: SupportedLanguages.Java,
  strategies: [javaJvmStrategy, createStandardStrategy(SupportedLanguages.Java)],
};

export const kotlinImportConfig: ImportResolutionConfig = {
  language: SupportedLanguages.Kotlin,
  strategies: [kotlinJvmStrategy, createStandardStrategy(SupportedLanguages.Kotlin)],
};

/**
 * Scala import resolution config.
 * Reuses JVM wildcard/member import strategy, then standard fallback.
 */

import { SupportedLanguages } from 'gitnexus-shared';
import type { ImportResolutionConfig, ImportResolverStrategy } from '../types.js';
import { createStandardStrategy } from '../standard.js';
import { resolveJvmWildcard, resolveJvmMemberImport } from '../jvm.js';

export const scalaJvmStrategy: ImportResolverStrategy = (rawImportPath, _filePath, ctx) => {
  const dotPath = rawImportPath
    .replace(/\{[^}]*\}/g, '')
    .trim()
    .replace(/\._$/, '.*');

  const exts = ['.scala', '.java'];

  if (dotPath.endsWith('.*') || dotPath.endsWith('._')) {
    const files = resolveJvmWildcard(
      dotPath,
      ctx.normalizedFileList,
      ctx.allFileList,
      exts,
      ctx.index,
    );
    if (files.length > 0) {
      const pkgPath = dotPath.slice(0, -2).replace(/\./g, '/');
      return { kind: 'package', files, dirSuffix: pkgPath };
    }
    return null;
  }

  const resolved = resolveJvmMemberImport(
    dotPath,
    ctx.normalizedFileList,
    ctx.allFileList,
    exts,
    ctx.index,
  );
  return resolved ? { kind: 'files', files: [resolved] } : null;
};

export const scalaImportConfig: ImportResolutionConfig = {
  language: SupportedLanguages.Scala,
  strategies: [scalaJvmStrategy, createStandardStrategy(SupportedLanguages.Scala)],
};

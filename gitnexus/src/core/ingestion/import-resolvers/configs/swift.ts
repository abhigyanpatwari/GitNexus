/**
 * Swift import resolution config.
 * Package.swift target map strategy — no standard fallback (unresolved = external framework).
 */

import { SupportedLanguages } from 'gitnexus-shared';
import type { ImportResolutionConfig, ImportResolverStrategy } from '../types.js';

/** Swift Package.swift target map resolution strategy. */
export const swiftPackageStrategy: ImportResolverStrategy = (rawImportPath, _filePath, ctx) => {
  const swiftPackageConfig = ctx.configs.swiftPackageConfig;
  if (swiftPackageConfig) {
    const targetDir = swiftPackageConfig.targets.get(rawImportPath);
    if (targetDir) {
      const dirPrefix = targetDir + '/';
      const files: string[] = [];
      for (let i = 0; i < ctx.normalizedFileList.length; i++) {
        if (
          ctx.normalizedFileList[i].startsWith(dirPrefix) &&
          ctx.normalizedFileList[i].endsWith('.swift')
        ) {
          files.push(ctx.allFileList[i]);
        }
      }
      if (files.length > 0) return { kind: 'files', files };
    }
  }
  return null; // External framework (Foundation, UIKit, etc.)
};

export const swiftImportConfig: ImportResolutionConfig = {
  language: SupportedLanguages.Swift,
  strategies: [swiftPackageStrategy],
};

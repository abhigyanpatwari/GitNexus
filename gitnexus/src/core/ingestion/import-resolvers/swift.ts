/**
 * Swift module import resolution.
 * Handles module imports via Package.swift target map.
 */

import type { ImportResult, ResolveCtx } from './types.js';

/** Swift: module imports via Package.swift target map. */
export function resolveSwiftImport(
  rawImportPath: string,
  _filePath: string,
  ctx: ResolveCtx,
): ImportResult {
  const swiftPackageConfig = ctx.configs.swiftPackageConfig;
  if (swiftPackageConfig) {
    const targetDir = swiftPackageConfig.targets.get(rawImportPath);
    if (targetDir) {
      const dirPrefix = targetDir + '/';
      const files: string[] = [];
      for (let i = 0; i < ctx.normalizedFileList.length; i++) {
        if (ctx.normalizedFileList[i].startsWith(dirPrefix) && ctx.normalizedFileList[i].endsWith('.swift')) {
          files.push(ctx.allFileList[i]);
        }
      }
      if (files.length > 0) return { kind: 'files', files };
    }
  }
  return null; // External framework (Foundation, UIKit, etc.)
}

/**
 * PHP import resolution config.
 * PSR-4 strategy via composer.json — no standard fallback (PSR-4 includes its own suffix matching).
 */

import { SupportedLanguages } from 'gitnexus-shared';
import type { ImportResolutionConfig, ImportResolverStrategy } from '../types.js';
import { resolvePhpImportInternal } from '../php.js';

/** PHP PSR-4 resolution strategy via composer.json autoload mappings. */
export const phpPsr4Strategy: ImportResolverStrategy = (rawImportPath, _filePath, ctx) => {
  const resolved = resolvePhpImportInternal(
    rawImportPath,
    ctx.configs.composerConfig,
    ctx.allFilePaths,
    ctx.normalizedFileList,
    ctx.allFileList,
    ctx.index,
  );
  return resolved ? { kind: 'files', files: [resolved] } : null;
};

export const phpImportConfig: ImportResolutionConfig = {
  language: SupportedLanguages.PHP,
  strategies: [phpPsr4Strategy],
};

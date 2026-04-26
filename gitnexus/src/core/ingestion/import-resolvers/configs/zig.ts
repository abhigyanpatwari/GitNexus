/**
 * Zig import resolution config.
 * Per-file @import("...") strings, then standard fallback.
 */

import { SupportedLanguages } from 'gitnexus-shared';
import type { ImportResolutionConfig, ImportResolverStrategy } from '../types.js';
import { createStandardStrategy } from '../standard.js';
import { resolveZigImportInternal } from '../zig.js';

export const zigModuleStrategy: ImportResolverStrategy = (rawImportPath, filePath, ctx) => {
  const resolved = resolveZigImportInternal(filePath, rawImportPath, ctx.allFilePaths);
  return resolved ? { kind: 'files', files: [resolved] } : null;
};

export const zigImportConfig: ImportResolutionConfig = {
  language: SupportedLanguages.Zig,
  strategies: [zigModuleStrategy, createStandardStrategy(SupportedLanguages.Zig)],
};

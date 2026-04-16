/**
 * Python import resolution config.
 * PEP 328 relative + proximity-based strategy, then standard fallback.
 */

import { SupportedLanguages } from 'gitnexus-shared';
import type { ImportResolutionConfig, ImportResolverStrategy } from '../types.js';
import { createStandardStrategy } from '../standard.js';
import { resolvePythonImportInternal } from '../python.js';

/**
 * Python import resolution strategy — PEP 328 relative + proximity-based bare imports.
 * Returns null to continue chain for non-relative imports.
 * Absorbs unresolved relative imports (returns empty result to stop the chain).
 */
export const pythonImportStrategy: ImportResolverStrategy = (rawImportPath, filePath, ctx) => {
  const resolved = resolvePythonImportInternal(filePath, rawImportPath, ctx.allFilePaths);
  if (resolved) {
    ctx.resolveCache.set(`${filePath}::${rawImportPath}`, resolved);
    return { kind: 'files', files: [resolved] };
  }
  // PEP 328: unresolved relative imports should not fall through to suffix matching
  if (rawImportPath.startsWith('.')) return { kind: 'files', files: [] };
  return null;
};

export const pythonImportConfig: ImportResolutionConfig = {
  language: SupportedLanguages.Python,
  strategies: [pythonImportStrategy, createStandardStrategy(SupportedLanguages.Python)],
};

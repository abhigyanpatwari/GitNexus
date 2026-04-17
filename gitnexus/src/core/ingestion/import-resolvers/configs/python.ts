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

  // External dotted imports like `django.apps` should not fall through to generic
  // suffix matching when the repo has unrelated local files such as `accounts/apps.py`.
  // Keep suffix fallback only when the leading segment appears somewhere in-repo,
  // which preserves existing internal absolute-import behavior like `accounts.models`.
  const pathLike = rawImportPath.replace(/\./g, '/');
  if (pathLike.includes('/')) {
    const [leadingSegment] = pathLike.split('/').filter(Boolean);
    const hasRepoCandidate =
      !!leadingSegment &&
      (ctx.index.get(`${leadingSegment}.py`) !== undefined ||
        ctx.index.get(`${leadingSegment}/__init__.py`) !== undefined ||
        ctx.index.getFilesInDir(leadingSegment, '.py').length > 0);

    if (!hasRepoCandidate) return { kind: 'files', files: [] };
  }

  return null;
};

export const pythonImportConfig: ImportResolutionConfig = {
  language: SupportedLanguages.Python,
  strategies: [pythonImportStrategy, createStandardStrategy(SupportedLanguages.Python)],
};

/**
 * Dart import resolution config.
 * SDK/package strategy first, then relative import strategy (with ./ prepending).
 */

import { SupportedLanguages } from 'gitnexus-shared';
import type { ImportResolutionConfig, ImportResolverStrategy } from '../types.js';
import { resolveStandard } from '../standard.js';

/**
 * Dart SDK and package: import strategy.
 * Absorbs dart: SDK imports and external packages (returns empty result to stop chain).
 * Returns null for relative imports to let the next strategy handle them.
 */
export const dartPackageStrategy: ImportResolverStrategy = (rawImportPath, _filePath, ctx) => {
  // Strip surrounding quotes from configurable_uri capture
  const stripped = rawImportPath.replace(/^['"]|['"]$/g, '');

  // Skip dart: SDK imports (dart:async, dart:io, etc.)
  if (stripped.startsWith('dart:')) return { kind: 'files', files: [] };

  // Local package: imports → resolve to lib/<path>
  if (stripped.startsWith('package:')) {
    const slashIdx = stripped.indexOf('/');
    if (slashIdx === -1) return { kind: 'files', files: [] };
    const relPath = stripped.slice(slashIdx + 1);
    const candidates = [`lib/${relPath}`, relPath];
    const files: string[] = [];
    for (const candidate of candidates) {
      for (const fp of ctx.allFileList) {
        if (fp.endsWith('/' + candidate) || fp === candidate) {
          files.push(fp);
          break;
        }
      }
      if (files.length > 0) break;
    }
    if (files.length > 0) return { kind: 'files', files };
    return { kind: 'files', files: [] }; // external package
  }

  return null;
};

/**
 * Dart relative import strategy — prepends "./" for bare relative paths,
 * then delegates to standard resolution.
 */
export const dartRelativeStrategy: ImportResolverStrategy = (rawImportPath, filePath, ctx) => {
  const stripped = rawImportPath.replace(/^['"]|['"]$/g, '');
  const relPath = stripped.startsWith('.') ? stripped : './' + stripped;
  return resolveStandard(relPath, filePath, ctx, SupportedLanguages.Dart);
};

export const dartImportConfig: ImportResolutionConfig = {
  language: SupportedLanguages.Dart,
  strategies: [dartPackageStrategy, dartRelativeStrategy],
};

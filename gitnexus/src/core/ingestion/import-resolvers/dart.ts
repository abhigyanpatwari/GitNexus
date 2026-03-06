/**
 * Dart import resolution.
 * Handles package: imports (local packages) and relative imports.
 * SDK imports (dart:*) and external packages are skipped.
 */

import type { ImportResult, ResolveCtx } from './types.js';
import { resolveStandard } from './standard.js';
import { SupportedLanguages } from '../../../config/supported-languages.js';

export function resolveDartImport(
  rawImportPath: string,
  filePath: string,
  ctx: ResolveCtx,
): ImportResult {
  // Strip surrounding quotes from configurable_uri capture
  const stripped = rawImportPath.replace(/^['"]|['"]$/g, '');

  // Skip dart: SDK imports (dart:async, dart:io, etc.)
  if (stripped.startsWith('dart:')) return null;

  // Local package: imports → resolve to lib/<path>
  if (stripped.startsWith('package:')) {
    const slashIdx = stripped.indexOf('/');
    if (slashIdx === -1) return null;
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
    return null;
  }

  // Relative imports — use standard resolution
  return resolveStandard(stripped, filePath, ctx, SupportedLanguages.Dart);
}

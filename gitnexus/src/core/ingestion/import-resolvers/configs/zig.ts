/**
 * Zig import resolution.
 *
 * v1 scope: only `@import("./foo.zig")`-style local-file imports. Standard
 * library and external packages (`@import("std")`, `@import("mod")`) are
 * treated as external — return an empty result so they don't produce ghost
 * import edges.
 */

import { SupportedLanguages } from 'gitnexus-shared';
import type { ImportResolutionConfig, ImportResolverStrategy } from '../types.js';
import { resolveStandard } from '../standard.js';

const stripQuotes = (s: string): string => s.replace(/^['"]|['"]$/g, '');

export const zigImportStrategy: ImportResolverStrategy = (rawImportPath, filePath, ctx) => {
  const stripped = stripQuotes(rawImportPath);

  // Local-file imports always reference a `.zig` path. Anything else
  // (`std`, `builtin`, package names) is external — stop the chain.
  if (!stripped.endsWith('.zig')) {
    return { kind: 'files', files: [] };
  }

  // Treat as relative to the importing file. tree-sitter-zig captures the
  // string with surrounding quotes; resolveStandard handles `./` and `../`.
  const relPath = stripped.startsWith('.') ? stripped : './' + stripped;
  return resolveStandard(relPath, filePath, ctx, SupportedLanguages.Zig);
};

export const zigImportConfig: ImportResolutionConfig = {
  language: SupportedLanguages.Zig,
  strategies: [zigImportStrategy],
};

/**
 * Zig import resolution.
 *
 * Local-file imports (`@import("./foo.zig")`, `@import("foo.zig")`) resolve
 * relative to the importer. Bare names (`@import("bar")`) resolve through
 * build.zig.zon `.path` deps when a parsed ZigBuildZonConfig is available
 * (see language-config.ts `loadZigBuildConfig`). Everything unresolvable —
 * `std`, `builtin`, `root`, `.url`-based deps — returns an empty result so
 * it doesn't produce ghost import edges.
 */

import { SupportedLanguages } from 'gitnexus-shared';
import type { ImportResolutionConfig, ImportResolverStrategy } from '../types.js';
import { resolveZigImportInternal } from '../zig.js';

const stripQuotes = (s: string): string => s.replace(/^['"]|['"]$/g, '');

export const zigImportStrategy: ImportResolverStrategy = (rawImportPath, filePath, ctx) => {
  // tree-sitter-zig captures the string with surrounding quotes.
  const stripped = stripQuotes(rawImportPath);
  const resolved = resolveZigImportInternal(
    filePath,
    stripped,
    ctx.allFilePaths,
    ctx.configs.zigBuildZon ?? null,
  );
  // Unresolvable (stdlib / builtin / .url dep / missing file): stop the
  // chain with an empty result rather than falling through to suffix
  // matching, which could ghost-match an unrelated same-named file.
  return { kind: 'files', files: resolved ? [resolved] : [] };
};

export const zigImportConfig: ImportResolutionConfig = {
  language: SupportedLanguages.Zig,
  strategies: [zigImportStrategy],
};

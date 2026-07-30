/**
 * Lua type extractor — minimal.
 *
 * Lua has no static type annotations, so no (varName → typeName) bindings are
 * extracted: declarationNodeTypes is empty and extractDeclaration/extractParameter
 * are no-ops. Constructor-inference and return-type inference are deferred
 * (would belong in Phase B scope-resolution). Satisfies the LanguageTypeConfig
 * required fields with the least-possible surface.
 */
import type { LanguageTypeConfig } from './types.js';

export const typeConfig: LanguageTypeConfig = {
  declarationNodeTypes: new Set<string>(),
  extractDeclaration: () => {},
  extractParameter: () => {},
};

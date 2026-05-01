import { SupportedLanguages } from 'gitnexus-shared';
import type { HeritageExtractionConfig } from '../../heritage-types.js';

/**
 * Lua heritage extraction config.
 *
 * Lua uses metatables for inheritance (setmetatable + __index). Since this is
 * runtime behavior rather than syntactic inheritance, tree-sitter queries
 * cannot reliably capture it. The heritage extractor is configured but relies
 * on future call-routing hooks to detect setmetatable patterns.
 */
export const luaHeritageConfig: HeritageExtractionConfig = {
  language: SupportedLanguages.Lua,
};

import { SupportedLanguages } from 'gitnexus-shared';
import type { ClassExtractionConfig } from '../../class-types.js';

/**
 * Lua class extraction config.
 *
 * Lua has no native class syntax. Class-like structures are detected via
 * local_variable_declaration with table constructors (local M = {}), which
 * is the standard module/class pattern. Method definitions on the table
 * (function M:method()) are handled by the method extractor, not here.
 */
export const luaClassConfig: ClassExtractionConfig = {
  language: SupportedLanguages.Lua,
  typeDeclarationNodes: [],
  fileScopeNodeTypes: ['chunk'],
};

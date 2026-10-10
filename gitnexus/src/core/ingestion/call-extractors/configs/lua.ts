import { SupportedLanguages } from 'gitnexus-shared';
import type { CallExtractionConfig } from '../../call-types.js';

// Lua call extraction is fully handled by the generic createCallExtractor
// (derive calledName + callForm + receiver from @call/@call.name captures in
// LUA_QUERIES). No language-specific call shapes (no `::` method references),
// so the config carries only the language id.
export const luaCallConfig: CallExtractionConfig = {
  language: SupportedLanguages.Lua,
};

import type { ParsedFile, SymbolDefinition } from 'gitnexus-shared';
import { indexTopLevelExportsByName } from 'gitnexus-shared';
import { canonicalTypeScriptName } from './identifiers.js';

/** Keep written graph identities while exposing canonical ECMAScript export names. */
export function typescriptModuleExports(parsed: ParsedFile): ReadonlyMap<string, SymbolDefinition> {
  const exports = new Map<string, SymbolDefinition>();
  const ambiguous = new Set<string>();
  for (const [spelling, definition] of indexTopLevelExportsByName(parsed.localDefs)) {
    const name = canonicalTypeScriptName(spelling);
    const previous = exports.get(name);
    if (previous && previous.nodeId !== definition.nodeId) ambiguous.add(name);
    else exports.set(name, definition);
  }
  for (const name of ambiguous) exports.delete(name);
  return exports;
}

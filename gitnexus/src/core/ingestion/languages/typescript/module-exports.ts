import type { ParsedFile, SymbolDefinition } from 'gitnexus-shared';
import { indexTopLevelExportsByName } from 'gitnexus-shared';
import { canonicalTypeScriptName } from './identifiers.js';

/** `export * from M` never re-exports `M`'s default export (ECMA-262 `GetExportedNames`). */
export const ECMASCRIPT_WILDCARD_REEXPORT_EXCLUDED_NAMES: ReadonlySet<string> = new Set([
  'default',
]);

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
  // ECMAScript publishes the default export under the name `default`. Indexing
  // only the marked defs picks the same callable winner a named import gets for
  // overloads and `const f = () => …`; two differently named defaults (invalid
  // input) publish none.
  const defaults = indexTopLevelExportsByName(
    parsed.localDefs.filter((definition) => definition.isDefaultExport === true),
  );
  if (defaults.size === 1) {
    for (const definition of defaults.values()) exports.set('default', definition);
  }
  return exports;
}

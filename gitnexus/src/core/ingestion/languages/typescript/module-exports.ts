import type { ParsedFile, SymbolDefinition } from 'gitnexus-shared';
import { indexTopLevelExportsByName } from 'gitnexus-shared';
import { canonicalModuleExportName, canonicalTypeScriptName } from './identifiers.js';

/** The export name ECMAScript gives a module's default export. */
const DEFAULT_EXPORT_NAME = 'default';

/** `export * from M` never re-exports `M`'s default export (ECMA-262 `GetExportedNames`). */
export const ECMASCRIPT_WILDCARD_REEXPORT_EXCLUDED_NAMES: ReadonlySet<string> = new Set([
  DEFAULT_EXPORT_NAME,
]);

/** Keep written graph identities while exposing canonical ECMAScript export names. */
export function typescriptModuleExports(parsed: ParsedFile): ReadonlyMap<string, SymbolDefinition> {
  const exports = new Map<string, SymbolDefinition>();
  const ambiguous = new Set<string>();
  const publish = (name: string, definition: SymbolDefinition) => {
    const previous = exports.get(name);
    if (previous && previous.nodeId !== definition.nodeId) ambiguous.add(name);
    else exports.set(name, definition);
  };
  for (const [spelling, definition] of indexTopLevelExportsByName(parsed.localDefs)) {
    if (definition.namedExports === undefined) {
      publish(canonicalTypeScriptName(spelling), definition);
    } else {
      for (const written of definition.namedExports) {
        const name = canonicalModuleExportName(written);
        if (name !== null) publish(name, definition);
      }
    }
    for (const name of definition.typeOnlyExports ?? []) publish(name, definition);
  }
  for (const name of ambiguous) exports.delete(name);
  // Indexing only the marked defs picks the same callable winner a named import
  // gets for overloads and `const f = () => …`; two differently named defaults
  // (invalid input) publish none. Most files have no default: skip the index.
  const marked = parsed.localDefs.filter((definition) => definition.isDefaultExport === true);
  if (marked.length > 0) {
    const defaults = indexTopLevelExportsByName(marked);
    if (defaults.size === 1) {
      for (const definition of defaults.values()) exports.set(DEFAULT_EXPORT_NAME, definition);
    }
  }
  return exports;
}

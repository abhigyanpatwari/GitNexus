import type { ParsedFile, SymbolDefinition } from 'gitnexus-shared';
import { indexTopLevelExportsByName } from 'gitnexus-shared';
import { canonicalModuleExportName, canonicalTypeScriptName } from './identifiers.js';
import { declarationScope } from './module-kind.js';

/** The export name ECMAScript gives a module's default export. */
const DEFAULT_EXPORT_NAME = 'default';

/** `export * from M` never re-exports `M`'s default export (ECMA-262 `GetExportedNames`). */
export const ECMASCRIPT_WILDCARD_REEXPORT_EXCLUDED_NAMES: ReadonlySet<string> = new Set([
  DEFAULT_EXPORT_NAME,
]);

/** Keep written graph identities while exposing canonical ECMAScript export names. */
export function typescriptModuleExports(parsed: ParsedFile): ReadonlyMap<string, SymbolDefinition> {
  const scope = declarationScope(parsed.captureSideChannel);
  if (scope?.script) {
    if (!scope.commonJs) return new Map();
    return publishedNames(parsed.localDefs.filter((def) => def.isExported === true));
  }
  const erased = parsed.localDefs.filter(isErasedDeclaration);
  if (erased.length === 0) return publishedNames(parsed.localDefs);
  // A type and a value can share a spelling. Select the runtime declaration
  // first, preserving the erased type when it is the only owner.
  const exports = publishedNames(parsed.localDefs.filter((def) => !isErasedDeclaration(def)));
  for (const [name, def] of publishedNames(erased)) {
    if (!exports.has(name)) exports.set(name, { ...def, typeOnlyExports: [name] });
  }
  return exports;
}

function isErasedDeclaration(def: SymbolDefinition): boolean {
  return def.type === 'Interface' || def.type === 'TypeAlias';
}

function publishedNames(definitions: readonly SymbolDefinition[]): Map<string, SymbolDefinition> {
  const exports = new Map<string, SymbolDefinition>();
  const ambiguous = new Set<string>();
  const publish = (name: string, definition: SymbolDefinition) => {
    const previous = exports.get(name);
    if (previous && previous.nodeId !== definition.nodeId) ambiguous.add(name);
    else exports.set(name, definition);
  };
  for (const [spelling, definition] of indexTopLevelExportsByName(definitions)) {
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
  const defaultExport = findDefaultExport(definitions);
  if (defaultExport) exports.set(DEFAULT_EXPORT_NAME, defaultExport);
  return exports;
}

function findDefaultExport(definitions: readonly SymbolDefinition[]): SymbolDefinition | undefined {
  // Indexing only the marked defs picks the same callable winner a named import
  // gets for overloads and `const f = () => …`; two differently named defaults
  // (invalid input) publish none. Most files have no default: skip the index.
  const marked = definitions.filter((definition) => definition.isDefaultExport === true);
  if (marked.length === 0) return undefined;
  const defaults = indexTopLevelExportsByName(marked);
  return defaults.size === 1 ? defaults.values().next().value : undefined;
}

import type { ParsedFile, SymbolDefinition } from 'gitnexus-shared';
import { indexTopLevelExportsByName } from 'gitnexus-shared';
import { canonicalModuleExportName, canonicalTypeScriptName } from './identifiers.js';
import { declarationScope } from './module-kind.js';
import { tsconfigFor, type TsconfigIndex } from './tsconfig.js';
import { nodePackageIsEsm, type NodeWorkspacePackages } from './workspace-packages.js';

/** The export name ECMAScript gives a module's default export. */
const DEFAULT_EXPORT_NAME = 'default';

const compiledDefaults = new WeakMap<ParsedFile, SymbolDefinition>();

export function bindCompiledCommonJsDefaults(
  files: readonly ParsedFile[],
  configs: TsconfigIndex | null,
  packages: NodeWorkspacePackages | null,
): void {
  for (const file of files) {
    const positions = declarationScope(file.captureSideChannel)?.possibleCommonJsDefaults;
    if (!positions?.length) continue;
    compiledDefaults.delete(file);
    const mode = tsconfigFor(configs, file.filePath)?.module;
    const commonJs =
      mode === 'commonjs' ||
      (/^node(?:16|18|20|next)$/.test(mode ?? '') && !nodePackageIsEsm(file.filePath, packages));
    if (!commonJs) continue;
    const candidates = file.localDefs.filter((def) => {
      const at = def.declarationRange;
      return def.type === 'Function' && at && positions.includes(`${at.startLine}:${at.startCol}`);
    });
    if (candidates.length === 1) compiledDefaults.set(file, candidates[0]);
  }
}

/** `export * from M` never re-exports `M`'s default export (ECMA-262 `GetExportedNames`). */
export const ECMASCRIPT_WILDCARD_REEXPORT_EXCLUDED_NAMES: ReadonlySet<string> = new Set([
  DEFAULT_EXPORT_NAME,
]);

/** Keep written graph identities while exposing canonical ECMAScript export names. */
export function typescriptModuleExports(parsed: ParsedFile): ReadonlyMap<string, SymbolDefinition> {
  const compiled = compiledDefaults.get(parsed);
  const definitions = compiled
    ? parsed.localDefs.map((def) =>
        def === compiled ? { ...def, isExported: true, isDefaultExport: true } : def,
      )
    : parsed.localDefs;
  const scope = declarationScope(parsed.captureSideChannel);
  if (scope?.script) {
    if (!scope.commonJs) return new Map();
    return publishedNames(definitions.filter((def) => def.isExported === true));
  }
  const erased = definitions.filter(isErasedDeclaration);
  if (erased.length === 0) return publishedNames(definitions);
  // A type and a value can share a spelling. Select the runtime declaration
  // first, preserving the erased type when it is the only owner.
  const exports = publishedNames(definitions.filter((def) => !isErasedDeclaration(def)));
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

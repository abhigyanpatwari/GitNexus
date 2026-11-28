import type { ParsedFile, SymbolDefinition } from 'gitnexus-shared';
import { indexTopLevelExportsByName } from 'gitnexus-shared';
import { sourceRangeKey } from '../../utils/ast-helpers.js';
import { canonicalModuleExportName, canonicalTypeScriptName } from './identifiers.js';
import { declarationScope } from './module-kind.js';
import type { ConditionalEsmExports } from '../../ts-js-export-marker.js';
import { tsconfigFor, type TsconfigIndex } from './tsconfig.js';
import { nodePackageIsEsm, type NodeWorkspacePackages } from './workspace-packages.js';

/** The export name ECMAScript gives a module's default export. */
const DEFAULT_EXPORT_NAME = 'default';

type NativeModule = { format: 'esm' | 'commonjs'; definitions: readonly SymbolDefinition[] };
const formatExports = new WeakMap<ParsedFile, NativeModule>();

/** A guarded reference to module.exports can also occur in a native ES module. */
export function hasCommonJsWrapper(file: ParsedFile): boolean {
  const bound = formatExports.get(file);
  if (bound) return bound.format === 'commonjs';
  return (
    file.captureSideChannel === true || declarationScope(file.captureSideChannel)?.commonJs === true
  );
}

function explicitEsmDefinitions(
  file: ParsedFile,
  esm?: ConditionalEsmExports,
): readonly SymbolDefinition[] {
  if (!esm) return file.localDefs;
  const definitions: SymbolDefinition[] = [];
  for (const def of file.localDefs) {
    const publication = def.nameRange && esm.declarations[sourceRangeKey(def.nameRange)];
    if (publication) definitions.push({ ...def, isExported: true, ...publication });
  }
  return definitions;
}

function commonJsDefinitions(
  definitions: readonly SymbolDefinition[],
  positions?: readonly string[],
): readonly SymbolDefinition[] {
  if (!positions?.length) return definitions;
  const candidates = definitions.filter((def) => {
    const at = def.declarationRange;
    return def.type === 'Function' && at && positions.includes(`${at.startLine}:${at.startCol}`);
  });
  if (candidates.length !== 1) return definitions;
  return definitions.map((def) =>
    def === candidates[0] ? { ...def, isExported: true, isDefaultExport: true } : def,
  );
}

function projectModuleFormat(
  filePath: string,
  configs: TsconfigIndex | null,
  packages: NodeWorkspacePackages | null,
  hasModuleSyntax?: boolean,
): NativeModule['format'] | undefined {
  const isJs = /\.jsx?$/i.test(filePath);
  const mode = isJs ? undefined : tsconfigFor(configs, filePath)?.module;
  const nodeMode = /^node(?:16|18|20|next)$/.test(mode ?? '');
  const esmEmit = /^(?:es6|es2015|es2020|es2022|esnext)$/.test(mode ?? '');
  const usesPackageFormat = !mode || nodeMode || esmEmit || mode === 'preserve';
  if (usesPackageFormat && nodePackageIsEsm(filePath, packages)) return 'esm';
  if ((isJs || esmEmit) && hasModuleSyntax) return 'esm';
  if (mode === 'commonjs' || nodeMode) return 'commonjs';
}

/** Resolve ambiguous .js/.ts syntax using the project's compiler and Node package scope. */
export function bindModuleFormatExports(
  files: readonly ParsedFile[],
  configs: TsconfigIndex | null,
  packages: NodeWorkspacePackages | null,
): void {
  for (const file of files) {
    const scope = declarationScope(file.captureSideChannel);
    const esm = scope?.conditionalEsmExports;
    const positions = scope?.possibleCommonJsDefaults;
    const possibleWrapper = file.captureSideChannel === true || scope?.commonJs;
    if ((!esm && !positions?.length && !possibleWrapper) || !/\.[jt]sx?$/i.test(file.filePath))
      continue;
    formatExports.delete(file);
    const format = projectModuleFormat(file.filePath, configs, packages, esm?.hasModuleSyntax);
    if (format === 'esm') {
      // A CommonJS wrapper alone supplies no exports in a native ES module.
      const definitions = !esm && possibleWrapper ? [] : explicitEsmDefinitions(file, esm);
      formatExports.set(file, { format: 'esm', definitions });
      continue;
    }
    if (format === 'commonjs')
      formatExports.set(file, {
        format,
        definitions: commonJsDefinitions(file.localDefs, positions),
      });
  }
}

/** `export * from M` never re-exports `M`'s default export (ECMA-262 `GetExportedNames`). */
export const ECMASCRIPT_WILDCARD_REEXPORT_EXCLUDED_NAMES: ReadonlySet<string> = new Set([
  DEFAULT_EXPORT_NAME,
]);

/** Keep written graph identities while exposing canonical ECMAScript export names. */
export function typescriptModuleExports(parsed: ParsedFile): ReadonlyMap<string, SymbolDefinition> {
  const definitions = formatExports.get(parsed)?.definitions ?? parsed.localDefs;
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

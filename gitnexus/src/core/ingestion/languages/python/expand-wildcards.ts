import type { ParsedFile, ScopeId, SymbolDefinition } from 'gitnexus-shared';
import type { PythonCaptureSideChannel } from './module-accessors.js';

/** A module's bindings, narrowed to its literal `__all__` when it has one. */
interface WildcardSurface {
  readonly names: readonly string[];
  readonly literalAll: ReadonlySet<string> | undefined;
}

const namesByWorkspace = new WeakMap<
  readonly ParsedFile[],
  ReadonlyMap<ScopeId, WildcardSurface | null>
>();

/** Keep each module binding's definition, rather than looking its name up again
 * among class members and nested functions in the file's flat definition list. */
export function pythonModuleExports(parsed: ParsedFile): ReadonlyMap<string, SymbolDefinition> {
  const exports = new Map<string, SymbolDefinition>();
  const module = parsed.scopes.find((scope) => scope.id === parsed.moduleScope);
  for (const [name, bindings] of module?.bindings ?? []) {
    const definition = bindings[0]?.def;
    if (
      definition !== undefined &&
      bindings.every((binding) => binding.def.nodeId === definition.nodeId)
    ) {
      exports.set(name, definition);
    }
  }
  return exports;
}

/** Restored side channels are plain data: anything but a Python snapshot's
 * string array is absent. */
function readLiteralAll(parsed: ParsedFile): ReadonlySet<string> | undefined {
  const channel = parsed.captureSideChannel as Partial<PythonCaptureSideChannel> | undefined;
  if (channel?.kind !== 'python-capture') return undefined;
  const names = channel.literalAll;
  return Array.isArray(names) && names.every((name) => typeof name === 'string')
    ? new Set(names)
    : undefined;
}

/** Names imported by `from module import *`: exactly a literal `__all__`'s
 * available names, else the public ones. Any other `__all__` form is not
 * represented by ParsedFile, so decline it rather than assume every public
 * declaration was exported.
 */
export function expandPythonWildcardNames(
  targetModuleScope: ScopeId,
  parsedFiles: readonly ParsedFile[],
  availableNames?: readonly string[],
): readonly string[] {
  let byScope = namesByWorkspace.get(parsedFiles);
  if (byScope === undefined) {
    const collected = new Map<ScopeId, WildcardSurface | null>();
    for (const parsed of parsedFiles) {
      const module = parsed.scopes.find((scope) => scope.id === parsed.moduleScope);
      // Scope-creating declarations are owned by their body scope, but bind
      // in the parent. The parsed module's binding keys preserve that rule.
      const names = [...(module?.bindings.keys() ?? [])];
      const importsAll = parsed.parsedImports.some(
        (edge) =>
          'localName' in edge &&
          edge.localName === '__all__' &&
          (edge.declaredAtScope === undefined || edge.declaredAtScope === parsed.moduleScope),
      );
      const literalAll = readLiteralAll(parsed);
      const unknownExports = importsAll || (literalAll === undefined && names.includes('__all__'));
      collected.set(parsed.moduleScope, unknownExports ? null : { names, literalAll });
    }
    byScope = collected;
    namesByWorkspace.set(parsedFiles, byScope);
  }
  const surface = byScope.get(targetModuleScope);
  if (surface == null) return [];
  const listed = surface.literalAll;
  const exported =
    listed === undefined
      ? (name: string) => name.length > 0 && !name.startsWith('_')
      : (name: string) => listed.has(name);
  return [...new Set((availableNames ?? surface.names).filter(exported))];
}

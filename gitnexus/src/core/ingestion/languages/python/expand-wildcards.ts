import type { ParsedFile, ScopeId, SymbolDefinition } from 'gitnexus-shared';

const namesByWorkspace = new WeakMap<
  readonly ParsedFile[],
  ReadonlyMap<ScopeId, readonly string[] | null>
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

/** Public declarations imported by `from module import *`.
 * Explicit `__all__` values are not represented by ParsedFile. Decline those
 * modules rather than assume that every public declaration was exported.
 */
export function expandPythonWildcardNames(
  targetModuleScope: ScopeId,
  parsedFiles: readonly ParsedFile[],
  availableNames?: readonly string[],
): readonly string[] {
  let byScope = namesByWorkspace.get(parsedFiles);
  if (byScope === undefined) {
    const collected = new Map<ScopeId, readonly string[] | null>();
    for (const parsed of parsedFiles) {
      const module = parsed.scopes.find((scope) => scope.id === parsed.moduleScope);
      // Scope-creating declarations are owned by their body scope, but bind
      // in the parent. The parsed module's binding keys preserve that rule.
      const names = [...(module?.bindings.keys() ?? [])];
      const hasExplicitExports =
        names.includes('__all__') ||
        parsed.parsedImports.some(
          (edge) =>
            'localName' in edge &&
            edge.localName === '__all__' &&
            (edge.declaredAtScope === undefined || edge.declaredAtScope === parsed.moduleScope),
        );
      collected.set(parsed.moduleScope, hasExplicitExports ? null : names);
    }
    byScope = collected;
    namesByWorkspace.set(parsedFiles, byScope);
  }
  const localNames = byScope.get(targetModuleScope);
  if (localNames == null) return [];
  return [
    ...new Set(
      (availableNames ?? localNames).filter((name) => name.length > 0 && !name.startsWith('_')),
    ),
  ];
}

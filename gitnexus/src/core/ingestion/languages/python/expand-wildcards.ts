import type { ParsedFile, ScopeId } from 'gitnexus-shared';

const namesByWorkspace = new WeakMap<
  readonly ParsedFile[],
  ReadonlyMap<ScopeId, readonly string[]>
>();

/** Public declarations imported by `from module import *`.
 * Explicit `__all__` values are not represented by ParsedFile. Decline those
 * modules rather than assume that every public declaration was exported.
 */
export function expandPythonWildcardNames(
  targetModuleScope: ScopeId,
  parsedFiles: readonly ParsedFile[],
): readonly string[] {
  let byScope = namesByWorkspace.get(parsedFiles);
  if (byScope === undefined) {
    const collected = new Map<ScopeId, readonly string[]>();
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
      collected.set(
        parsed.moduleScope,
        hasExplicitExports
          ? []
          : [...new Set(names.filter((name) => name.length > 0 && !name.startsWith('_')))],
      );
    }
    byScope = collected;
    namesByWorkspace.set(parsedFiles, byScope);
  }
  return byScope.get(targetModuleScope) ?? [];
}

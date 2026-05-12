import type { ParsedFile, ScopeId, SymbolDefinition } from 'gitnexus-shared';

/**
 * Per-file set of function names declared with `static` storage class.
 * Populated during `emitCScopeCaptures` and consumed by `expandCWildcardNames`
 * to exclude file-local symbols from cross-file wildcard import visibility.
 *
 * NOTE: module-level state, single-process-single-repo use only.
 * For server-mode or multi-repo-in-one-process use cases, call
 * `clearStaticNames()` at the start of each resolution pass to avoid
 * stale static-linkage data from a previous invocation.
 *
 * Key: filePath, Value: Set of static function names.
 */
const staticNames = new Map<string, Set<string>>();

/** Record a symbol name as `static` (file-local linkage) for the given file. */
export function markStaticName(filePath: string, name: string): void {
  let names = staticNames.get(filePath);
  if (names === undefined) {
    names = new Set<string>();
    staticNames.set(filePath, names);
  }
  names.add(name);
}

/** Check whether a symbol name has `static` linkage in the given file. */
export function isStaticName(filePath: string, name: string): boolean {
  return staticNames.get(filePath)?.has(name) ?? false;
}

/** Clear tracked static names (for testing). */
export function clearStaticNames(): void {
  staticNames.clear();
}

/**
 * Return the names visible through a C wildcard import (`#include`).
 * All module-scope defs from the target file are visible EXCEPT those
 * declared with `static` storage class (file-local linkage in C).
 */
export function expandCWildcardNames(
  targetModuleScope: ScopeId,
  parsedFiles: readonly ParsedFile[],
): readonly string[] {
  const target = parsedFiles.find((p) => p.moduleScope === targetModuleScope);
  if (target === undefined) return [];

  const seen = new Set<string>();
  const names: string[] = [];
  for (const def of target.localDefs) {
    const name = simpleName(def);
    if (name === '') continue;
    if (isStaticName(target.filePath, name)) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

function simpleName(def: SymbolDefinition): string {
  return def.qualifiedName?.split('.').pop() ?? def.qualifiedName ?? '';
}

/**
 * Enumerate names a Solidity path-only `import "./Foo.sol"` brings into scope —
 * every exported top-level symbol of the target file (contracts, interfaces,
 * libraries, etc.). Mirror of Dart's `expandDartWildcardNames`.
 */

import type { ParsedFile, ScopeId } from 'gitnexus-shared';

export function expandSolidityWildcardNames(
  targetModuleScope: ScopeId,
  parsedFiles: readonly ParsedFile[],
): readonly string[] {
  const target = parsedFiles.find((p) => p.moduleScope === targetModuleScope);
  if (target === undefined) return [];

  const seen = new Set<string>();
  const names: string[] = [];
  for (const def of target.localDefs) {
    // Path-only imports bind top-level types, not nested methods/properties.
    if (
      def.type !== 'Class' &&
      def.type !== 'Interface' &&
      def.type !== 'Struct' &&
      def.type !== 'Enum'
    ) {
      continue;
    }
    const qn = def.qualifiedName;
    if (qn === undefined || qn.length === 0) continue;
    // Prefer module-owned types (contracts/interfaces/libraries live at file scope).
    const name = qn.includes('.') ? qn.split('.').pop()! : qn;
    if (name === '' || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

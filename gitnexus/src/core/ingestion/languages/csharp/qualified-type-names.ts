/**
 * Stamp namespace-qualified `qualifiedName` on file-level type defs so
 * `QualifiedNameIndex` can resolve `new B.Foo()` across colliding simple
 * names (#2046 / #1928 F35). C# scope queries emit only the simple type
 * name; file-scoped `namespace X;` places classes under Module, not the
 * Namespace scope, so `tagNamespacePrefixes` alone cannot key `B.Foo`.
 */
import type { ParsedFile, SymbolDefinition } from 'gitnexus-shared';
import { isClassLike } from '../../scope-resolution/scope/walkers.js';

function isFileLevelTypeDef(def: SymbolDefinition): boolean {
  return isClassLike(def.type) || def.type === 'Enum';
}

export function populateCsharpNamespaceQualifiedNames(parsed: ParsedFile): void {
  const scopesById = new Map(parsed.scopes.map((s) => [s.id, s]));
  const fileNamespaceName = (): string | undefined => {
    for (const scope of parsed.scopes) {
      if (scope.kind !== 'Namespace') continue;
      const nsDef = scope.ownedDefs.find((d) => d.type === 'Namespace');
      const q = nsDef?.qualifiedName;
      if (q !== undefined && q.length > 0) return q;
    }
    return undefined;
  };
  const fileNs = fileNamespaceName();

  for (const scope of parsed.scopes) {
    if (scope.kind !== 'Class') continue;
    const parent = scope.parent === null ? undefined : scopesById.get(scope.parent);
    if (parent === undefined) continue;
    if (parent.kind !== 'Module' && parent.kind !== 'Namespace') continue;

    const prefix =
      parent.kind === 'Namespace'
        ? parent.ownedDefs.find((d) => d.type === 'Namespace')?.qualifiedName
        : fileNs;
    if (prefix === undefined || prefix.length === 0) continue;

    for (const def of scope.ownedDefs) {
      if (!isFileLevelTypeDef(def)) continue;
      const q = def.qualifiedName;
      if (q === undefined || q.length === 0 || q.includes('.')) continue;
      (def as { qualifiedName: string }).qualifiedName = `${prefix}.${q}`;
    }
  }
}

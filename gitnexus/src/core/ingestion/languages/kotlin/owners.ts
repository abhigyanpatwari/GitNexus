import type { ParsedFile, ScopeId, SymbolDefinition } from 'gitnexus-shared';
import { isClassLike, populateClassOwnedMembers } from '../../scope-resolution/scope/walkers.js';

export function populateKotlinOwners(parsed: ParsedFile): void {
  populateClassOwnedMembers(parsed);
  populateCompanionMembersOnEnclosingClass(parsed);
}

function populateCompanionMembersOnEnclosingClass(parsed: ParsedFile): void {
  const scopesById = new Map<ScopeId, ParsedFile['scopes'][number]>();
  for (const scope of parsed.scopes) scopesById.set(scope.id, scope);

  for (const scope of parsed.scopes) {
    if (scope.kind !== 'Function' || scope.parent === null) continue;
    const parent = scopesById.get(scope.parent);
    if (parent === undefined || parent.kind !== 'Class') continue;
    if (parent.ownedDefs.some((def) => isClassLike(def.type))) continue;

    const enclosing = findEnclosingClassWithDef(parent.parent, scopesById);
    if (enclosing === undefined) continue;
    for (const def of scope.ownedDefs) {
      if (def.ownerId !== undefined) continue;
      (def as { ownerId?: string }).ownerId = enclosing.nodeId;
      qualify(def, enclosing);
    }
  }
}

function findEnclosingClassWithDef(
  start: ScopeId | null,
  scopesById: ReadonlyMap<ScopeId, ParsedFile['scopes'][number]>,
): SymbolDefinition | undefined {
  let current = start;
  while (current !== null) {
    const scope = scopesById.get(current);
    if (scope === undefined) return undefined;
    if (scope.kind === 'Class') {
      const classDef = scope.ownedDefs.find((def) => isClassLike(def.type));
      if (classDef !== undefined) return classDef;
    }
    current = scope.parent;
  }
  return undefined;
}

function qualify(def: SymbolDefinition, owner: SymbolDefinition): void {
  if (def.qualifiedName === undefined || def.qualifiedName.includes('.')) return;
  if (owner.qualifiedName === undefined || owner.qualifiedName.length === 0) return;
  (def as { qualifiedName: string }).qualifiedName = `${owner.qualifiedName}.${def.qualifiedName}`;
}

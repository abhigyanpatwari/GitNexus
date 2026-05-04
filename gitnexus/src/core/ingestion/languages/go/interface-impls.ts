import type { ParsedFile, SymbolDefinition } from 'gitnexus-shared';
import type { SemanticModel } from '../../model/semantic-model.js';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';

export function detectGoInterfaceImplementations(
  parsedFiles: readonly ParsedFile[],
  _indexes: ScopeResolutionIndexes,
  _model: SemanticModel,
): Map<string, string[]> {
  // 1. Collect interface defs → method names (from scope.ownedDefs)
  const interfaceMethods = new Map<string, Set<string>>();
  const interfaceDefsById = new Map<string, SymbolDefinition>();

  // 2. Collect struct defs → method names
  const structMethods = new Map<string, Set<string>>();

  for (const parsed of parsedFiles) {
    // Collect interface defs and their owned methods
    for (const scope of parsed.scopes) {
      if (scope.kind !== 'Class') continue;

      // Find the type def for this scope
      const typeDef = scope.ownedDefs.find((d) => d.type === 'Interface' || d.type === 'Struct');
      if (typeDef === undefined) continue;

      if (typeDef.type === 'Interface') {
        interfaceDefsById.set(typeDef.nodeId, typeDef);
        const methodNames = new Set<string>();
        // Methods are in child scopes (Function kind) or ownedDefs
        for (const childScope of parsed.scopes) {
          if (childScope.parent === scope.id && childScope.kind === 'Function') {
            for (const def of childScope.ownedDefs) {
              if (def.type === 'Method' || def.type === 'Function') {
                methodNames.add(def.qualifiedName?.split('.').pop() ?? '');
              }
            }
          }
        }
        // Also check if methods have ownerId pointing to this interface
        for (const def of parsed.localDefs) {
          if (
            (def as { ownerId?: string }).ownerId === typeDef.nodeId &&
            (def.type === 'Method' || def.type === 'Function')
          ) {
            methodNames.add(def.qualifiedName?.split('.').pop() ?? '');
          }
        }
        interfaceMethods.set(typeDef.nodeId, methodNames);
      }

      if (typeDef.type === 'Struct') {
        const methodNames = new Set<string>();
        for (const def of parsed.localDefs) {
          if (
            (def as { ownerId?: string }).ownerId === typeDef.nodeId &&
            (def.type === 'Method' || def.type === 'Function')
          ) {
            methodNames.add(def.qualifiedName?.split('.').pop() ?? '');
          }
        }
        structMethods.set(typeDef.nodeId, methodNames);
      }
    }
  }

  // 3. For each interface, find structs whose method set is a superset
  const impls = new Map<string, string[]>();
  for (const [ifaceId, ifaceMethods] of interfaceMethods) {
    if (ifaceMethods.size === 0) continue;
    const implementors: string[] = [];
    for (const [structId, methods] of structMethods) {
      if (isSuperset(methods, ifaceMethods)) {
        implementors.push(structId);
      }
    }
    if (implementors.length > 0) impls.set(ifaceId, implementors);
  }

  return impls;
}

function isSuperset(superset: Set<string>, subset: Set<string>): boolean {
  for (const item of subset) {
    if (!superset.has(item)) return false;
  }
  return true;
}

import { describe, expect, it } from 'vitest';
import {
  buildDefIndex,
  buildMethodDispatchIndex,
  buildModuleScopeIndex,
  buildQualifiedNameIndex,
  buildScopeTree,
  type BindingRef,
  type Range,
  type ReferenceSite,
  type Scope,
  type ScopeId,
  type SymbolDefinition,
  type TypeRef,
} from 'gitnexus-shared';
import { resolveReferenceSites } from '../../../src/core/ingestion/resolve-references.js';
import type { ScopeResolutionIndexes } from '../../../src/core/ingestion/model/scope-resolution-indexes.js';

const range = (sl = 1, sc = 0, el = 100, ec = 0): Range => ({
  startLine: sl,
  startCol: sc,
  endLine: el,
  endCol: ec,
});

const mkDef = (overrides: Partial<SymbolDefinition> & { nodeId: string }): SymbolDefinition => ({
  nodeId: overrides.nodeId,
  filePath: overrides.filePath ?? 'x.ts',
  type: overrides.type ?? 'Class',
  ...overrides,
});

const mkScope = (input: {
  id: ScopeId;
  parent: ScopeId | null;
  kind?: Scope['kind'];
  filePath?: string;
  range?: Range;
  bindings?: Record<string, readonly BindingRef[]>;
  typeBindings?: Record<string, TypeRef>;
  ownedDefs?: readonly SymbolDefinition[];
}): Scope => ({
  id: input.id,
  parent: input.parent,
  kind: input.kind ?? 'Module',
  filePath: input.filePath ?? 'x.ts',
  range: input.range ?? range(),
  bindings: new Map(Object.entries(input.bindings ?? {})),
  imports: [],
  typeBindings: new Map(Object.entries(input.typeBindings ?? {})),
  ownedDefs: input.ownedDefs ?? [],
});

const typeRef = (rawName: string, declaredAtScope: ScopeId): TypeRef => ({
  rawName,
  declaredAtScope,
  source: 'parameter-annotation',
});

function makeIndexes(
  scopes: Scope[],
  defs: SymbolDefinition[],
  referenceSites: readonly ReferenceSite[],
  mro: Record<string, readonly string[]> = {},
): ScopeResolutionIndexes {
  return {
    scopeTree: buildScopeTree(scopes),
    defs: buildDefIndex(defs),
    qualifiedNames: buildQualifiedNameIndex(defs),
    moduleScopes: buildModuleScopeIndex(
      scopes
        .filter((scope) => scope.kind === 'Module')
        .map((scope) => ({ filePath: scope.filePath, moduleScopeId: scope.id })),
    ),
    methodDispatch: buildMethodDispatchIndex({
      owners: Array.from(new Set(defs.map((def) => def.nodeId))),
      computeMro: (owner) => mro[owner] ?? [],
      implementsOf: () => [],
    }),
    imports: new Map(),
    bindings: new Map(),
    bindingAugmentations: new Map(),
    referenceSites,
    sccs: [],
    stats: {
      totalFiles: 0,
      totalEdges: 0,
      linkedEdges: 0,
      unresolvedEdges: 0,
      sccCount: 0,
      largestSccSize: 0,
    },
  };
}

describe('resolveReferenceSites', () => {
  it('uses ownedMembersByOwner to resolve a hook-provided receiver member', () => {
    const userClass = mkDef({ nodeId: 'def:User', type: 'Class', qualifiedName: 'User' });
    const saveMethod = mkDef({
      nodeId: 'def:User.save',
      type: 'Method',
      qualifiedName: 'User.save',
      ownerId: 'def:User',
    });
    const scope = mkScope({
      id: 'scope:call',
      parent: null,
      typeBindings: { user: typeRef('User', 'scope:call') },
    });
    const referenceSite: ReferenceSite = {
      name: 'save',
      atRange: range(5, 2, 5, 6),
      inScope: 'scope:call',
      kind: 'call',
      explicitReceiver: { name: 'user' },
      arity: 0,
    };
    const indexes = makeIndexes([scope], [userClass], [referenceSite]);

    const result = resolveReferenceSites({
      scopes: indexes,
      ownedMembersByOwner: (ownerDefId, memberName) =>
        ownerDefId === 'def:User' && memberName === 'save' ? [saveMethod] : [],
    });

    expect(result.stats).toEqual({ sitesProcessed: 1, referencesEmitted: 1, unresolved: 0 });
    expect(result.referenceIndex.bySourceScope.get('scope:call')).toHaveLength(1);
    expect(result.referenceIndex.bySourceScope.get('scope:call')?.[0]?.toDef).toBe('def:User.save');
  });

  it('threads providers.arityCompatibility through to filter hook-provided overloads', () => {
    const userClass = mkDef({ nodeId: 'def:User', type: 'Class', qualifiedName: 'User' });
    const saveOne = mkDef({
      nodeId: 'def:User.save#1',
      type: 'Method',
      qualifiedName: 'User.save',
      ownerId: 'def:User',
      parameterCount: 1,
    });
    const saveTwo = mkDef({
      nodeId: 'def:User.save#2',
      type: 'Method',
      qualifiedName: 'User.save',
      ownerId: 'def:User',
      parameterCount: 2,
    });
    const scope = mkScope({
      id: 'scope:call',
      parent: null,
      typeBindings: { user: typeRef('User', 'scope:call') },
    });
    const referenceSite: ReferenceSite = {
      name: 'save',
      atRange: range(5, 2, 5, 6),
      inScope: 'scope:call',
      kind: 'call',
      explicitReceiver: { name: 'user' },
      arity: 1,
    };
    const indexes = makeIndexes([scope], [userClass], [referenceSite]);

    const result = resolveReferenceSites({
      scopes: indexes,
      ownedMembersByOwner: (ownerDefId, memberName) =>
        ownerDefId === 'def:User' && memberName === 'save' ? [saveOne, saveTwo] : [],
      providers: {
        arityCompatibility: (callsite, def) =>
          def.parameterCount === callsite.arity ? 'compatible' : 'incompatible',
      },
    });

    expect(result.stats).toEqual({ sitesProcessed: 1, referencesEmitted: 1, unresolved: 0 });
    expect(result.referenceIndex.bySourceScope.get('scope:call')).toHaveLength(1);
    expect(result.referenceIndex.bySourceScope.get('scope:call')?.[0]?.toDef).toBe(
      'def:User.save#1',
    );
  });
});

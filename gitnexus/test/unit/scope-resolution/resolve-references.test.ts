import { describe, expect, it } from 'vitest';
import {
  buildDefIndex,
  buildMethodDispatchIndex,
  buildModuleScopeIndex,
  buildQualifiedNameIndex,
  buildScopeTree,
  type BindingRef,
  type ImportEdge,
  type Range,
  type ReferenceSite,
  type Scope,
  type ScopeId,
  type SymbolDefinition,
  type TypeRef,
} from 'gitnexus-shared';
import { resolveReferenceSites } from '../../../src/core/ingestion/resolve-references.js';
import type { ScopeResolutionIndexes } from '../../../src/core/ingestion/model/scope-resolution-indexes.js';
import { createKnowledgeGraph } from '../../../src/core/graph/graph.js';
import { createSemanticModel } from '../../../src/core/ingestion/model/semantic-model.js';
import { buildGraphNodeLookup } from '../../../src/core/ingestion/scope-resolution/graph-bridge/node-lookup.js';
import { emitReceiverBoundCalls } from '../../../src/core/ingestion/scope-resolution/passes/receiver-bound-calls.js';
import { resolveCompoundReceiverClass } from '../../../src/core/ingestion/scope-resolution/passes/compound-receiver.js';
import { buildWorkspaceResolutionIndex } from '../../../src/core/ingestion/scope-resolution/workspace-index.js';
import type { SourceBindingResolution } from '../../../src/core/ingestion/scope-resolution/source-binding-resolution.js';

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
    workspaceFqnBindings: new Map(),
    workspaceTypeBindings: new Map(),
    namespaceFqnBindings: new Map(),
    namespaceTypeBindings: new Map(),
    accessibleNamespacesByScope: new Map(),
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
      ambiguousWildcardExports: [],
    },
  };
}

describe('resolveReferenceSites', () => {
  it('resolves a written qualified type without falling back to an unrelated leaf', () => {
    const definitions = ['Outer', 'Other'].map((owner) =>
      mkDef({ nodeId: `${owner}.Target`, type: 'Class', qualifiedName: `${owner}.Target` }),
    );
    const module = mkScope({
      id: 'module',
      parent: null,
      bindings: { Target: [{ def: definitions[1]!, origin: 'local' }] },
    });
    const exact: ReferenceSite = {
      name: 'Target',
      rawQualifiedName: 'Outer::Target',
      kind: 'type-reference',
      inScope: module.id,
      atRange: range(3, 0, 3, 13),
    };
    const absent: ReferenceSite = {
      ...exact,
      rawQualifiedName: 'Missing::Target',
      atRange: range(4, 0, 4, 15),
    };
    const bindings = new Map<ReferenceSite, SourceBindingResolution>();
    const result = resolveReferenceSites({
      scopes: makeIndexes([module], definitions, [exact, absent]),
      ownedMembersByOwner: () => [],
      recordSourceBinding: (site, binding) => bindings.set(site, binding),
    });
    expect(
      result.referenceIndex.bySourceScope.get(module.id)?.map((reference) => reference.toDef),
    ).toEqual([definitions[0]!.nodeId]);
    expect(bindings.get(exact)).toMatchObject({
      status: 'resolved',
      targetDefIds: [definitions[0]!.nodeId],
    });
    expect(bindings.get(absent)).toMatchObject({ status: 'unresolved', targetDefIds: [] });
  });

  it('honors a shadowed or imported qualifier before considering a global qualified type', () => {
    const decoy = mkDef({
      nodeId: 'decoy.Target',
      type: 'Class',
      qualifiedName: 'Outer.Target',
      filePath: 'decoy.ts',
    });
    const actual = mkDef({
      nodeId: 'source.Target',
      type: 'Class',
      qualifiedName: 'Target',
      filePath: 'source.ts',
    });
    const module = mkScope({ id: 'module', parent: null });
    const inner: Scope = {
      ...mkScope({ id: 'inner', parent: module.id, kind: 'Function' }),
      lexicalNames: new Set(['Outer']),
    };
    const imported: ReferenceSite = {
      name: 'Target',
      rawQualifiedName: 'Outer.Target',
      kind: 'type-reference',
      inScope: module.id,
      atRange: range(3, 0, 3, 12),
    };
    const shadowed: ReferenceSite = { ...imported, inScope: inner.id, atRange: range(5, 0, 5, 12) };
    const imports = new Map<ScopeId, readonly ImportEdge[]>();
    const indexes = {
      ...makeIndexes([module, inner], [decoy, actual], [imported, shadowed]),
      imports,
    };
    imports.set(module.id, [
      {
        kind: 'namespace',
        localName: 'Outer',
        targetExportedName: '*',
        targetFile: actual.filePath,
      },
    ]);
    const bindings = new Map<ReferenceSite, SourceBindingResolution>();
    const result = resolveReferenceSites({
      scopes: indexes,
      ownedMembersByOwner: () => [],
      recordSourceBinding: (site, binding) => bindings.set(site, binding),
    });
    expect(
      result.referenceIndex.bySourceScope.get(module.id)?.map((reference) => reference.toDef),
    ).toEqual([actual.nodeId]);
    expect(result.referenceIndex.bySourceScope.get(inner.id)).toBeUndefined();
    expect(bindings.get(shadowed)).toMatchObject({ status: 'blocked', targetDefIds: [] });
  });

  it('does not mistake a nearer class qualifier for a globally spelled owner', () => {
    const decoy = mkDef({ nodeId: 'Outer.Target', type: 'Class', qualifiedName: 'Outer.Target' });
    const local = mkDef({ nodeId: 'Local.Outer', type: 'Class', qualifiedName: 'Local.Outer' });
    const module = mkScope({ id: 'module', parent: null });
    const inner = mkScope({
      id: 'inner',
      parent: module.id,
      kind: 'Function',
      bindings: { Outer: [{ def: local, origin: 'local' }] },
    });
    const site: ReferenceSite = {
      name: 'Target',
      rawQualifiedName: 'Outer::Target',
      kind: 'type-reference',
      inScope: inner.id,
      atRange: range(3, 0, 3, 13),
    };
    const bindings = new Map<ReferenceSite, SourceBindingResolution>();
    const result = resolveReferenceSites({
      scopes: makeIndexes([module, inner], [decoy, local], [site]),
      ownedMembersByOwner: () => [],
      recordSourceBinding: (reference, binding) => bindings.set(reference, binding),
    });
    expect(result.referenceIndex.bySourceScope.get(inner.id)).toBeUndefined();
    expect(bindings.get(site)).toMatchObject({ status: 'unresolved', targetDefIds: [] });
  });

  it('resolves finalized imported type bindings and preserves nearer lexical shadows', () => {
    const definition = mkDef({
      nodeId: 'source.Target',
      type: 'Class',
      qualifiedName: 'Target',
      filePath: 'source.ts',
    });
    const module = mkScope({ id: 'module', parent: null });
    const inner: Scope = {
      ...mkScope({ id: 'inner', parent: module.id, kind: 'Function' }),
      lexicalNames: new Set(['Alias']),
    };
    const imported: ReferenceSite = {
      name: 'Alias',
      kind: 'type-reference',
      inScope: module.id,
      atRange: range(3, 0, 3, 5),
    };
    const shadowed: ReferenceSite = { ...imported, inScope: inner.id, atRange: range(5, 0, 5, 5) };
    const importedBindings = new Map<ScopeId, ReadonlyMap<string, readonly BindingRef[]>>();
    const indexes = {
      ...makeIndexes([module, inner], [definition], [imported, shadowed]),
      bindings: importedBindings,
    };
    importedBindings.set(
      module.id,
      new Map([
        [
          'Alias',
          [
            {
              def: definition,
              origin: 'import',
              via: {
                kind: 'alias',
                localName: 'Alias',
                targetExportedName: 'Target',
                targetFile: definition.filePath,
                targetDefId: definition.nodeId,
              },
            },
          ],
        ],
      ]),
    );
    const bindings = new Map<ReferenceSite, SourceBindingResolution>();
    const result = resolveReferenceSites({
      scopes: indexes,
      ownedMembersByOwner: () => [],
      recordSourceBinding: (site, binding) => bindings.set(site, binding),
    });
    expect(
      result.referenceIndex.bySourceScope.get(module.id)?.map((reference) => reference.toDef),
    ).toEqual([definition.nodeId]);
    expect(result.referenceIndex.bySourceScope.get(inner.id)).toBeUndefined();
    expect(bindings.get(imported)).toMatchObject({
      status: 'resolved',
      targetDefIds: [definition.nodeId],
      bindingKind: 'import-alias',
    });
    expect(bindings.get(shadowed)).toMatchObject({ status: 'blocked', targetDefIds: [] });
  });

  it('retains every finalized import candidate instead of promoting the ranked first match', () => {
    const definitions = ['left', 'right'].map((name) =>
      mkDef({
        nodeId: `${name}.Target`,
        type: 'Class',
        qualifiedName: 'Target',
        filePath: `${name}.ts`,
      }),
    );
    const module = mkScope({ id: 'module', parent: null });
    const site: ReferenceSite = {
      name: 'Target',
      kind: 'type-reference',
      inScope: module.id,
      atRange: range(3, 0, 3, 6),
    };
    const importedBindings = new Map<ScopeId, ReadonlyMap<string, readonly BindingRef[]>>();
    const indexes = {
      ...makeIndexes([module], definitions, [site]),
      bindings: importedBindings,
    };
    importedBindings.set(
      module.id,
      new Map([['Target', definitions.map((def) => ({ def, origin: 'import' as const }))]]),
    );
    const bindings = new Map<ReferenceSite, SourceBindingResolution>();
    resolveReferenceSites({
      scopes: indexes,
      ownedMembersByOwner: () => [],
      recordSourceBinding: (reference, binding) => bindings.set(reference, binding),
    });
    expect(bindings.get(site)).toMatchObject({
      status: 'ambiguous',
      candidatesComplete: true,
      targetDefIds: definitions.map((def) => def.nodeId),
    });
  });

  it('does not promote a global type-name fallback into an exact receiver binding', () => {
    const owner = mkDef({
      nodeId: 'external-owner',
      type: 'Class',
      qualifiedName: 'External',
      filePath: 'unimported.ts',
    });
    const member = mkDef({
      nodeId: 'external-owner.run',
      type: 'Method',
      qualifiedName: 'External.run',
      ownerId: owner.nodeId,
      filePath: owner.filePath,
    });
    const scope = mkScope({
      id: 'scope:call',
      parent: null,
      typeBindings: { service: typeRef('External', 'scope:call') },
    });
    const site: ReferenceSite = {
      name: 'run',
      kind: 'call',
      callForm: 'member',
      explicitReceiver: { name: 'service' },
      inScope: scope.id,
      atRange: range(5, 1, 5, 14),
      arity: 0,
    };
    const indexes = makeIndexes([scope], [owner, member], [site]);
    const parsed = {
      filePath: 'x.ts',
      moduleScope: scope.id,
      scopes: [scope],
      localDefs: [],
      parsedImports: [],
      referenceSites: [site],
    };
    const model = createSemanticModel();
    model.methods.register(owner.nodeId, 'run', member);
    const graph = createKnowledgeGraph();
    graph.addNode({ id: 'file', label: 'File', properties: { name: 'x.ts', filePath: 'x.ts' } });
    graph.addNode({
      id: member.nodeId,
      label: 'Method',
      properties: { name: 'run', qualifiedName: member.qualifiedName, filePath: member.filePath },
    });
    const bindings = new Map<ReferenceSite, SourceBindingResolution>();
    emitReceiverBoundCalls(
      graph,
      indexes,
      [parsed],
      buildGraphNodeLookup(graph),
      new Set(),
      { isSuperReceiver: () => false, arityCompatibility: () => 'compatible' },
      buildWorkspaceResolutionIndex([parsed]),
      model,
      { recordSourceBinding: (reference, binding) => bindings.set(reference, binding) },
    );
    expect(
      graph.relationships.filter((relationship) => relationship.type === 'CALLS'),
    ).toHaveLength(1);
    expect(bindings.get(site)).toMatchObject({
      status: 'unresolved',
      targetDefIds: [member.nodeId],
    });
    let guesses = 0;
    expect(
      resolveCompoundReceiverClass(
        'service',
        scope.id,
        indexes,
        buildWorkspaceResolutionIndex([parsed]),
        {
          onNameFallback: () => {
            guesses++;
          },
        },
      ),
    ).toBe(owner);
    expect(guesses).toBe(1);
  });

  it('observes blocked lexical names and explicit same-spelling import aliases', () => {
    const definition = mkDef({ nodeId: 'def:Payload', type: 'Class', qualifiedName: 'Payload' });
    const module = mkScope({
      id: 'module',
      parent: null,
      bindings: {
        Payload: [
          {
            def: definition,
            origin: 'import',
            via: {
              kind: 'alias',
              localName: 'Payload',
              targetExportedName: 'Payload',
              targetFile: 'types.ts',
              targetDefId: definition.nodeId,
            },
          },
        ],
      },
    });
    const inner: Scope = {
      ...mkScope({ id: 'inner', parent: module.id, kind: 'Function' }),
      lexicalNames: new Set(['blocked']),
    };
    const alias: ReferenceSite = {
      name: 'Payload',
      kind: 'type-reference',
      inScope: inner.id,
      atRange: range(5, 1, 5, 8),
    };
    const blocked: ReferenceSite = {
      name: 'blocked',
      kind: 'read',
      inScope: inner.id,
      atRange: range(6, 1, 6, 8),
    };
    const bindings = new Map<ReferenceSite, SourceBindingResolution>();
    resolveReferenceSites({
      scopes: makeIndexes([module, inner], [definition], [alias, blocked]),
      ownedMembersByOwner: () => [],
      recordSourceBinding: (site, binding) => bindings.set(site, binding),
    });
    expect(bindings.get(blocked)).toMatchObject({ status: 'blocked', basis: 'lexical-name-claim' });
    expect(bindings.get(alias)).toMatchObject({
      status: 'resolved',
      targetDefIds: [definition.nodeId],
      bindingKind: 'import-alias',
      importAlias: {
        localName: 'Payload',
        importedName: 'Payload',
        targetFile: 'types.ts',
        scopeId: module.id,
      },
    });
  });

  it('keeps an interface written binding separate from runtime dispatch targets', () => {
    const api = mkDef({ nodeId: 'api', type: 'Interface', qualifiedName: 'Api' });
    const implementation = mkDef({ nodeId: 'impl', type: 'Class', qualifiedName: 'Impl' });
    const declared = mkDef({
      nodeId: 'api.run',
      type: 'Method',
      qualifiedName: 'Api.run',
      ownerId: api.nodeId,
    });
    const runtime = mkDef({
      nodeId: 'impl.run',
      type: 'Method',
      qualifiedName: 'Impl.run',
      ownerId: implementation.nodeId,
    });
    const scope = mkScope({
      id: 'scope:call',
      parent: null,
      bindings: { Api: [{ def: api, origin: 'local' }] },
      typeBindings: { service: typeRef('Api', 'scope:call') },
      ownedDefs: [api, implementation, declared, runtime],
    });
    const site: ReferenceSite = {
      name: 'run',
      kind: 'call',
      callForm: 'member',
      explicitReceiver: { name: 'service' },
      inScope: scope.id,
      atRange: range(5, 1, 5, 14),
      arity: 0,
    };
    const indexes = makeIndexes([scope], [api, implementation, declared, runtime], [site]);
    const parsed = {
      filePath: 'x.ts',
      moduleScope: scope.id,
      scopes: [scope],
      localDefs: [api, implementation, declared, runtime],
      parsedImports: [],
      referenceSites: [site],
    };
    const model = createSemanticModel();
    model.methods.register(api.nodeId, 'run', declared);
    model.methods.register(implementation.nodeId, 'run', runtime);
    const graph = createKnowledgeGraph();
    graph.addNode({ id: 'file', label: 'File', properties: { name: 'x.ts', filePath: 'x.ts' } });
    for (const definition of parsed.localDefs)
      graph.addNode({
        id: definition.nodeId,
        label: definition.type,
        properties: {
          name: definition.qualifiedName!.split('.').at(-1)!,
          qualifiedName: definition.qualifiedName,
          filePath: definition.filePath,
        },
      });
    graph.addRelationship({
      id: 'implements',
      sourceId: implementation.nodeId,
      targetId: api.nodeId,
      type: 'IMPLEMENTS',
      confidence: 1,
      reason: 'test',
    });
    const bindings = new Map<ReferenceSite, SourceBindingResolution>();
    emitReceiverBoundCalls(
      graph,
      indexes,
      [parsed],
      buildGraphNodeLookup(graph),
      new Set(),
      { isSuperReceiver: () => false, arityCompatibility: () => 'compatible' },
      buildWorkspaceResolutionIndex([parsed]),
      model,
      { recordSourceBinding: (reference, binding) => bindings.set(reference, binding) },
    );
    expect(
      graph.relationships
        .filter((relationship) => relationship.type === 'CALLS')
        .map((relationship) => relationship.targetId)
        .sort(),
    ).toEqual([declared.nodeId, runtime.nodeId]);
    expect(bindings.get(site)).toMatchObject({
      status: 'resolved',
      targetDefIds: [declared.nodeId],
    });
  });

  it('observes all candidates without certifying the registry tie break as a binding', () => {
    const first = mkDef({ nodeId: 'def:first', type: 'Function', qualifiedName: 'save' });
    const second = mkDef({ nodeId: 'def:second', type: 'Function', qualifiedName: 'save' });
    const scope = mkScope({
      id: 'scope:call',
      parent: null,
      bindings: {
        save: [
          { def: first, origin: 'local' },
          { def: second, origin: 'local' },
        ],
      },
    });
    const site: ReferenceSite = {
      name: 'save',
      kind: 'call',
      inScope: scope.id,
      atRange: range(5, 2, 5, 8),
    };
    const bindings = new Map<ReferenceSite, { status: string; targetDefIds: readonly string[] }>();
    const output = resolveReferenceSites({
      scopes: makeIndexes([scope], [first, second], [site]),
      ownedMembersByOwner: () => [],
      recordSourceBinding: (reference, binding) => bindings.set(reference, binding),
    });
    expect(output.stats.referencesEmitted).toBe(1);
    expect(bindings.get(site)).toMatchObject({
      status: 'ambiguous',
      targetDefIds: [first.nodeId, second.nodeId],
    });
  });

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

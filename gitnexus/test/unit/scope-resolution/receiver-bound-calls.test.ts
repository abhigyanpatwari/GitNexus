import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildDefIndex,
  buildMethodDispatchIndex,
  buildModuleScopeIndex,
  buildQualifiedNameIndex,
  buildScopeTree,
  type BindingRef,
  type NodeLabel,
  type ParsedFile,
  type Range,
  type ReferenceSite,
  type Scope,
  type ScopeId,
  type SymbolDefinition,
  type TypeRef,
} from 'gitnexus-shared';

const { resolveCompoundReceiverClassMock } = vi.hoisted(() => ({
  resolveCompoundReceiverClassMock: vi.fn(),
}));

vi.mock(
  '../../../src/core/ingestion/scope-resolution/passes/compound-receiver.js',
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import('../../../src/core/ingestion/scope-resolution/passes/compound-receiver.js')
    >()),
    resolveCompoundReceiverClass: resolveCompoundReceiverClassMock,
    resolveCompoundReceiverTyped: (...args: Parameters<typeof resolveCompoundReceiverClassMock>) => {
      const def = resolveCompoundReceiverClassMock(...args);
      return def === undefined ? undefined : { def, declaredSpelling: undefined };
    },
  }),
);

import { createKnowledgeGraph } from '../../../src/core/graph/graph.js';
import type { KnowledgeGraph } from '../../../src/core/graph/types.js';
import { createSemanticModel } from '../../../src/core/ingestion/model/semantic-model.js';
import type { ScopeResolutionIndexes } from '../../../src/core/ingestion/model/scope-resolution-indexes.js';
import type { ResolutionOutcome } from '../../../src/core/ingestion/scope-resolution/resolution-outcome.js';
import { buildGraphNodeLookup } from '../../../src/core/ingestion/scope-resolution/graph-bridge/node-lookup.js';
import { emitReceiverBoundCalls } from '../../../src/core/ingestion/scope-resolution/passes/receiver-bound-calls.js';
import { buildWorkspaceResolutionIndex } from '../../../src/core/ingestion/scope-resolution/workspace-index.js';

const FILE = 'receiver-bound.ts';
const MODULE_SCOPE = 'scope:receiver-bound.ts#module' as ScopeId;

const range = (startLine = 1, startCol = 0, endLine = 100, endCol = 0): Range => ({
  startLine,
  startCol,
  endLine,
  endCol,
});

function definition(
  nodeId: string,
  type: NodeLabel,
  qualifiedName: string,
  metadata: Partial<SymbolDefinition> = {},
): SymbolDefinition {
  return { nodeId, filePath: FILE, type, qualifiedName, ...metadata };
}

function scope(
  id: ScopeId,
  parent: ScopeId | null,
  kind: Scope['kind'],
  options: {
    readonly bindings?: ReadonlyMap<string, readonly BindingRef[]>;
    readonly ownedDefs?: readonly SymbolDefinition[];
    readonly typeBindings?: ReadonlyMap<string, TypeRef>;
    readonly range?: Range;
  } = {},
): Scope {
  return {
    id,
    parent,
    kind,
    range: options.range ?? range(),
    filePath: FILE,
    bindings: options.bindings ?? new Map(),
    ownedDefs: options.ownedDefs ?? [],
    imports: [],
    typeBindings: options.typeBindings ?? new Map(),
  };
}

function indexes(
  scopes: readonly Scope[],
  defs: readonly SymbolDefinition[],
  sites: readonly ReferenceSite[],
): ScopeResolutionIndexes {
  return {
    scopeTree: buildScopeTree([...scopes]),
    defs: buildDefIndex([...defs]),
    qualifiedNames: buildQualifiedNameIndex([...defs]),
    moduleScopes: buildModuleScopeIndex([{ filePath: FILE, moduleScopeId: MODULE_SCOPE }]),
    methodDispatch: buildMethodDispatchIndex({
      owners: defs.filter((def) => def.type === 'Class').map((def) => def.nodeId),
      computeMro: () => [],
      implementsOf: () => [],
    }),
    imports: new Map(),
    bindings: new Map(),
    bindingAugmentations: new Map(),
    workspaceFqnBindings: new Map(),
    workspaceTypeBindings: new Map(),
    namespaceFqnBindings: new Map(),
    namespaceTypeBindings: new Map(),
    accessibleNamespacesByScope: new Map(),
    referenceSites: sites,
    sccs: [],
    stats: {
      totalFiles: 1,
      totalEdges: 0,
      linkedEdges: 0,
      unresolvedEdges: 0,
      sccCount: 1,
      largestSccSize: 1,
    },
  };
}

function parsedFile(
  scopes: readonly Scope[],
  defs: readonly SymbolDefinition[],
  sites: readonly ReferenceSite[],
): ParsedFile {
  return {
    filePath: FILE,
    moduleScope: MODULE_SCOPE,
    scopes,
    parsedImports: [],
    localDefs: defs,
    referenceSites: sites,
  };
}

function addGraphNode(
  graph: KnowledgeGraph,
  id: string,
  label: NodeLabel,
  name: string,
  qualifiedName: string,
  properties: Record<string, unknown> = {},
): void {
  graph.addNode({
    id,
    label,
    properties: { filePath: FILE, name, qualifiedName, ...properties },
  });
}

beforeEach(() => {
  resolveCompoundReceiverClassMock.mockReset();
  resolveCompoundReceiverClassMock.mockReturnValue(undefined);
});

describe('emitReceiverBoundCalls provider outcomes', () => {
  it('treats a class-receiver unresolved result as terminal and preserves its evidence', () => {
    const classDef = definition('def:Factory', 'Class', 'Factory');
    const callerDef = definition('def:entry', 'Function', 'entry');
    const model = createSemanticModel();
    const fallbackMethod = model.symbols.add(FILE, 'run', 'def:Factory.run', 'Method', {
      ownerId: classDef.nodeId,
      qualifiedName: 'Factory.run',
      parameterCount: 0,
    });
    const module = scope(MODULE_SCOPE, null, 'Module', {
      bindings: new Map([['Factory', [{ def: classDef, origin: 'local' as const }]]]),
      ownedDefs: [classDef],
    });
    const classScope = scope('scope:receiver-bound.ts#Factory' as ScopeId, MODULE_SCOPE, 'Class', {
      ownedDefs: [classDef, fallbackMethod],
      range: range(1, 0, 15, 0),
    });
    const functionScope = scope(
      'scope:receiver-bound.ts#entry' as ScopeId,
      MODULE_SCOPE,
      'Function',
      { ownedDefs: [callerDef], range: range(20, 0, 40, 0) },
    );
    const site: ReferenceSite = {
      name: 'run',
      atRange: range(30, 4, 30, 7),
      inScope: functionScope.id,
      kind: 'call',
      callForm: 'member',
      explicitReceiver: { name: 'Factory' },
      arity: 0,
    };
    const scopes = [module, classScope, functionScope];
    const defs = [classDef, fallbackMethod, callerDef];
    const parsed = parsedFile(scopes, defs, [site]);
    const resolutionIndexes = indexes(scopes, defs, [site]);
    const graph = createKnowledgeGraph();
    addGraphNode(graph, 'graph:entry', 'Function', 'entry', 'entry');
    addGraphNode(graph, 'graph:Factory.run', 'Method', 'run', 'Factory.run', {
      parameterCount: 0,
    });
    const handledSites = new Set<string>();
    const outcomes: ResolutionOutcome[] = [];

    const result = emitReceiverBoundCalls(
      graph,
      resolutionIndexes,
      [parsed],
      buildGraphNodeLookup(graph),
      handledSites,
      {
        isSuperReceiver: () => false,
        resolveClassNameReceiversViaMemberHook: true,
        resolveReceiverMember: () => ({
          kind: 'unresolved',
          reason: 'receiver-unresolved',
          candidateIds: [fallbackMethod.nodeId],
        }),
      },
      buildWorkspaceResolutionIndex([parsed]),
      model,
      { recordResolutionOutcome: (outcome) => outcomes.push(outcome) },
    );

    expect(result.emitted).toBe(0);
    expect(graph.relationships.filter((relationship) => relationship.type === 'CALLS')).toEqual([]);
    expect(handledSites).toContain(`${FILE}:30:4`);
    expect(outcomes).toEqual([
      expect.objectContaining({
        kind: 'suppressed',
        phase: 'receiver-bound-calls',
        reason: 'receiver-unresolved',
        candidateIds: [fallbackMethod.nodeId],
      }),
    ]);
  });

  it('uses a provider class-chain lookup with a synthetic callsite only', () => {
    const classDef = definition('def:Factory', 'Class', 'Factory');
    const productDef = definition('def:Product', 'Class', 'Product');
    const callerDef = definition('def:entry', 'Function', 'entry');
    const categoryMethod = definition(
      'def:Factory(Category).make',
      'Method',
      'Factory(Category).+make',
      { ownerId: 'def:Factory(Category)', returnType: 'Product *', parameterCount: 0 },
    );
    const module = scope(MODULE_SCOPE, null, 'Module', {
      bindings: new Map([
        ['Factory', [{ def: classDef, origin: 'local' as const }]],
        ['Product', [{ def: productDef, origin: 'local' as const }]],
      ]),
      ownedDefs: [classDef, productDef],
    });
    const functionScope = scope(
      'scope:receiver-bound.ts#entry' as ScopeId,
      MODULE_SCOPE,
      'Function',
      { ownedDefs: [callerDef], range: range(20, 0, 40, 0) },
    );
    const site: ReferenceSite = {
      name: '-finish',
      atRange: range(30, 4, 30, 11),
      inScope: functionScope.id,
      kind: 'call',
      callForm: 'member',
      explicitReceiver: { name: '[Factory make]' },
      receiverChain: '2|Factory|cmake',
      candidateNames: ['-finish', '+finish'],
      arity: 2,
      argumentTypes: ['OuterOnly', 'OuterOnly'],
    };
    const scopes = [module, functionScope];
    const defs = [classDef, productDef, callerDef, categoryMethod];
    const parsed = parsedFile(scopes, defs, [site]);
    const resolutionIndexes = indexes(scopes, defs, [site]);
    const providerLookup = vi.fn(() => ({
      kind: 'resolved' as const,
      definition: categoryMethod,
    }));
    let chainResolution: unknown;
    resolveCompoundReceiverClassMock.mockImplementation(
      (_receiverText, _inScope, _scopes, _index, options: Record<string, unknown>) => {
        const resolveChainMember = options.resolveChainMember as
          | ((
              owner: SymbolDefinition,
              receiverName: string,
              memberName: string,
              candidateNames: readonly string[],
              receiverKind: 'class' | 'instance',
            ) => unknown)
          | undefined;
        chainResolution = resolveChainMember?.(classDef, 'Factory', 'make', ['+make'], 'class');
        return undefined;
      },
    );

    emitReceiverBoundCalls(
      createKnowledgeGraph(),
      resolutionIndexes,
      [parsed],
      new Map(),
      new Set(),
      {
        isSuperReceiver: () => false,
        resolveClassNameReceiversViaMemberHook: true,
        resolveReceiverMember: providerLookup,
        receiverChainMemberCandidates: (memberName, receiverKind) =>
          receiverKind === 'class' ? [`+${memberName}`] : [`-${memberName}`],
        resolveReceiverChainResultOwner: () => productDef,
      },
      buildWorkspaceResolutionIndex([parsed]),
      createSemanticModel(),
    );

    expect(providerLookup).toHaveBeenCalledTimes(1);
    const syntheticCallsite = providerLookup.mock.calls[0]![2];
    expect(syntheticCallsite).toEqual({ candidateNames: ['+make'] });
    expect(syntheticCallsite.arity).toBeUndefined();
    expect(syntheticCallsite.argumentTypes).toBeUndefined();
    expect(chainResolution).toMatchObject({
      kind: 'resolved',
      method: categoryMethod,
      resultOwner: productDef,
    });
  });

  it('preserves every candidate id from an ambiguous raw class-chain lookup', () => {
    const classDef = definition('def:Factory', 'Class', 'Factory');
    const callerDef = definition('def:entry', 'Function', 'entry');
    const model = createSemanticModel();
    const declaration = model.symbols.add(FILE, '+make', 'def:Factory.make.declaration', 'Method', {
      ownerId: classDef.nodeId,
      qualifiedName: 'Factory.+make',
      parameterCount: 0,
    });
    const implementation = model.symbols.add(
      FILE,
      '+make',
      'def:Factory.make.implementation',
      'Method',
      {
        ownerId: classDef.nodeId,
        qualifiedName: 'Factory.+make',
        parameterCount: 0,
      },
    );
    const module = scope(MODULE_SCOPE, null, 'Module', {
      bindings: new Map([['Factory', [{ def: classDef, origin: 'local' as const }]]]),
      ownedDefs: [classDef],
    });
    const functionScope = scope(
      'scope:receiver-bound.ts#entry' as ScopeId,
      MODULE_SCOPE,
      'Function',
      { ownedDefs: [callerDef], range: range(20, 0, 40, 0) },
    );
    const site: ReferenceSite = {
      name: '-finish',
      atRange: range(30, 4, 30, 11),
      inScope: functionScope.id,
      kind: 'call',
      callForm: 'member',
      explicitReceiver: { name: '[Factory make]' },
      receiverChain: '2|Factory|cmake',
    };
    const scopes = [module, functionScope];
    const defs = [classDef, callerDef, declaration, implementation];
    const parsed = parsedFile(scopes, defs, [site]);
    let chainResolution: unknown;
    resolveCompoundReceiverClassMock.mockImplementation(
      (_receiverText, _inScope, _scopes, _index, options: Record<string, unknown>) => {
        const resolveChainMember = options.resolveChainMember as
          | ((
              owner: SymbolDefinition,
              receiverName: string,
              memberName: string,
              candidateNames: readonly string[],
              receiverKind: 'class' | 'instance',
            ) => unknown)
          | undefined;
        chainResolution = resolveChainMember?.(classDef, 'Factory', 'make', ['+make'], 'class');
        return undefined;
      },
    );

    emitReceiverBoundCalls(
      createKnowledgeGraph(),
      indexes(scopes, defs, [site]),
      [parsed],
      new Map(),
      new Set(),
      {
        isSuperReceiver: () => false,
        resolveReceiverChainResultOwner: () => undefined,
      },
      buildWorkspaceResolutionIndex([parsed]),
      model,
    );

    expect(chainResolution).toEqual({
      kind: 'ambiguous',
      candidateIds: ['def:Factory.make.declaration', 'def:Factory.make.implementation'],
    });
  });
});

describe('emitReceiverBoundCalls Case 3b option parity', () => {
  it('passes the historical file options when the provider declares no receiver-chain hooks', () => {
    const site: ReferenceSite = {
      name: 'finish',
      atRange: range(10, 2, 10, 8),
      inScope: MODULE_SCOPE,
      kind: 'call',
      callForm: 'member',
      explicitReceiver: { name: 'result' },
      receiverChain: '2|service|cget',
    };
    const module = scope(MODULE_SCOPE, null, 'Module', {
      typeBindings: new Map([
        [
          'result',
          {
            rawName: 'service.get',
            declaredAtScope: MODULE_SCOPE,
            source: 'assignment-inferred',
          },
        ],
      ]),
    });
    const parsed = parsedFile([module], [], [site]);
    const resolutionIndexes = indexes([module], [], [site]);

    emitReceiverBoundCalls(
      createKnowledgeGraph(),
      resolutionIndexes,
      [parsed],
      new Map(),
      new Set(),
      { isSuperReceiver: () => false },
      buildWorkspaceResolutionIndex([parsed]),
      createSemanticModel(),
    );

    const case3bOptions = resolveCompoundReceiverClassMock.mock.calls
      .filter(
        ([receiverText]) => receiverText === 'service.get' || receiverText === 'service.get()',
      )
      .map((call) => call[4] as Record<string, unknown>);
    expect(case3bOptions).toHaveLength(2);
    for (const options of case3bOptions) {
      expect(Object.hasOwn(options, 'receiverChain')).toBe(false);
      expect(Object.hasOwn(options, 'memberNameCandidates')).toBe(false);
      expect(Object.hasOwn(options, 'relatedResultOwnerOf')).toBe(false);
    }
  });
});

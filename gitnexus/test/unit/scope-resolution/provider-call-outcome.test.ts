import { describe, expect, it } from 'vitest';
import {
  buildDefIndex,
  buildMethodDispatchIndex,
  buildModuleScopeIndex,
  buildQualifiedNameIndex,
  buildScopeTree,
  type ParsedFile,
  type ReferenceSite,
  type Scope,
  type SymbolDefinition,
  type TypeRef,
} from 'gitnexus-shared';
import { createKnowledgeGraph } from '../../../src/core/graph/graph.js';
import { createSemanticModel } from '../../../src/core/ingestion/model/semantic-model.js';
import type { ScopeResolutionIndexes } from '../../../src/core/ingestion/model/scope-resolution-indexes.js';
import type {
  ReceiverMemberResolution,
  ScopeResolver,
} from '../../../src/core/ingestion/scope-resolution/contract/scope-resolver.js';
import { buildGraphNodeLookup } from '../../../src/core/ingestion/scope-resolution/graph-bridge/node-lookup.js';
import { emitFreeCallFallback } from '../../../src/core/ingestion/scope-resolution/passes/free-call-fallback.js';
import { emitReceiverBoundCalls } from '../../../src/core/ingestion/scope-resolution/passes/receiver-bound-calls.js';
import { applyPreciseCallResultBindings } from '../../../src/core/ingestion/scope-resolution/pipeline/run.js';
import { createCalleeIdAccumulator } from '../../../src/core/ingestion/scope-resolution/graph-bridge/callee-id-sink.js';
import {
  callSuppressionIdentities,
  providerCallOutcome,
  selectedCallKey,
} from '../../../src/core/ingestion/scope-resolution/passes/provider-call-outcome.js';
import type { ResolutionOutcome } from '../../../src/core/ingestion/scope-resolution/resolution-outcome.js';
import { buildWorkspaceResolutionIndex } from '../../../src/core/ingestion/scope-resolution/workspace-index.js';

function fixture(
  extraDefinitions: readonly SymbolDefinition[] = [],
  ownerType: 'Class' | 'Interface' = 'Class',
  ownerFilePath = 'owner.ts',
) {
  const caller: SymbolDefinition = {
    nodeId: 'def:caller',
    filePath: 'caller.ts',
    type: 'Function',
    qualifiedName: 'main',
  };
  const first: SymbolDefinition = {
    nodeId: 'def:first',
    filePath: 'first.ts',
    type: 'Function',
    qualifiedName: 'choose',
  };
  const second: SymbolDefinition = {
    nodeId: 'def:second',
    filePath: 'second.ts',
    type: 'Function',
    qualifiedName: 'choose',
  };
  const owner: SymbolDefinition = {
    nodeId: 'def:owner',
    filePath: ownerFilePath,
    type: ownerType,
    qualifiedName: 'Owner',
  };
  const member: SymbolDefinition = {
    nodeId: 'def:member',
    filePath: ownerFilePath,
    type: 'Method',
    qualifiedName: 'Owner.choose',
    ownerId: owner.nodeId,
    parameterCount: 1,
    parameterTypes: ['int'],
  };
  const defs = [caller, first, second, owner, member, ...extraDefinitions];
  const moduleScope: Scope = {
    id: 'scope:module',
    parent: null,
    kind: 'Module',
    filePath: 'caller.ts',
    range: { startLine: 0, startCol: 0, endLine: 30, endCol: 0 },
    ownedDefs: [],
    imports: [],
    typeBindings: new Map(),
    bindings: new Map(),
  };
  const scope: Scope = {
    id: 'scope:caller',
    parent: moduleScope.id,
    kind: 'Function',
    filePath: 'caller.ts',
    range: { startLine: 1, startCol: 0, endLine: 20, endCol: 0 },
    ownedDefs: [caller],
    imports: [],
    typeBindings: new Map(),
    bindings: new Map([['choose', [{ def: first, origin: 'local' }]]]),
  };
  const site: ReferenceSite = {
    inScope: scope.id,
    name: 'choose',
    kind: 'call',
    callForm: 'free',
    arity: 1,
    atRange: { startLine: 3, startCol: 2, endLine: 3, endCol: 10 },
  };
  const parsed: ParsedFile = {
    filePath: scope.filePath,
    moduleScope: moduleScope.id,
    scopes: [moduleScope, scope],
    localDefs: defs,
    parsedImports: [],
    referenceSites: [site],
  };
  const scopes = {
    scopeTree: buildScopeTree([moduleScope, scope]),
    defs: buildDefIndex(defs),
    qualifiedNames: buildQualifiedNameIndex(defs),
    moduleScopes: buildModuleScopeIndex([
      { filePath: scope.filePath, moduleScopeId: moduleScope.id },
    ]),
    methodDispatch: buildMethodDispatchIndex({
      owners: [],
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
    referenceSites: [site],
    sccs: [],
  } as unknown as ScopeResolutionIndexes;
  const graph = createKnowledgeGraph();
  for (const [definition, id] of [
    [caller, 'Function:caller.ts:main'],
    [first, 'Function:first.ts:choose'],
    [second, 'Function:second.ts:choose'],
    [owner, 'Class:owner.ts:Owner'],
    [member, 'Method:owner.ts:Owner.choose#1'],
    ...extraDefinitions.map((definition) => [definition, `graph:${definition.nodeId}`] as const),
  ] as const) {
    graph.addNode({
      id,
      label: definition.type,
      properties: {
        name: definition.qualifiedName!.split('.').at(-1)!,
        qualifiedName: definition.qualifiedName,
        filePath: definition.filePath,
        parameterCount: definition.parameterCount,
        parameterTypes: definition.parameterTypes,
      },
    });
  }
  const nodeLookup = buildGraphNodeLookup(graph);
  const model = createSemanticModel();
  const outcomes: ResolutionOutcome[] = [];
  const handled = new Set<string>();
  const context = { graph, scopes, nodeLookup, model };
  const run = (
    decision: ReceiverMemberResolution | undefined,
    selectedCalls?: Map<string, SymbolDefinition | null>,
  ) => {
    emitFreeCallFallback(
      graph,
      scopes,
      [parsed],
      nodeLookup,
      { bySourceScope: new Map() },
      handled,
      model,
      buildWorkspaceResolutionIndex([parsed]),
      {
        resolveUnqualifiedCall: () => decision,
        recordResolutionOutcome: (o) => outcomes.push(o),
        selectedCalls,
      },
    );
    return graph.relationships.filter((relation) => relation.type === 'CALLS');
  };
  return {
    context,
    site,
    member,
    owner,
    first,
    second,
    outcomes,
    handled,
    run,
    parsed,
    scope,
    moduleScope,
  };
}

function receiverFixture() {
  const owners: SymbolDefinition[] = ['First', 'Second'].map((name) => ({
    nodeId: `def:${name}`,
    filePath: 'caller.ts',
    type: 'Class',
    qualifiedName: name,
  }));
  const implementations = owners.map(
    (owner): SymbolDefinition => ({
      nodeId: `${owner.nodeId}.choose`,
      filePath: owner.filePath,
      type: 'Method',
      qualifiedName: `${owner.qualifiedName}.choose`,
      ownerId: owner.nodeId,
      parameterCount: 1,
      parameterTypes: ['int'],
    }),
  );
  const f = fixture([...owners, ...implementations], 'Interface', 'caller.ts');
  const site: ReferenceSite = {
    ...f.site,
    callForm: 'member',
    explicitReceiver: { name: 'service' },
  };
  const scope: Scope = {
    ...f.scope,
    bindings: new Map([['Owner', [{ def: f.owner, origin: 'local' }]]]),
    typeBindings: new Map([
      [
        'service',
        {
          rawName: 'Owner',
          declaredAtScope: f.scope.id,
          source: 'parameter-annotation',
        },
      ],
    ]),
  };
  const parsed = {
    ...f.parsed,
    scopes: [f.moduleScope, scope],
    referenceSites: [site],
  };
  const scopes = {
    ...f.context.scopes,
    scopeTree: buildScopeTree(parsed.scopes),
    referenceSites: [site],
  };
  const { graph, model, nodeLookup } = f.context;
  model.methods.register(f.owner.nodeId, 'choose', f.member);
  for (const implementation of implementations) {
    model.methods.register(implementation.ownerId!, 'choose', implementation);
  }
  for (const owner of owners) {
    graph.addRelationship({
      id: `implements:${owner.nodeId}`,
      sourceId: `graph:${owner.nodeId}`,
      targetId: 'Class:owner.ts:Owner',
      type: 'IMPLEMENTS',
      confidence: 1,
      reason: 'test',
    });
  }
  const run = (
    resolution: ReceiverMemberResolution,
    dispatch?: ScopeResolver['resolveSelectedMethodImplementation'],
  ) => {
    emitReceiverBoundCalls(
      graph,
      scopes,
      [parsed],
      nodeLookup,
      f.handled,
      {
        isSuperReceiver: () => false,
        arityCompatibility: () => 'compatible',
        resolveReceiverMember: () => resolution,
        resolveSelectedMethodImplementation: dispatch,
      },
      buildWorkspaceResolutionIndex([parsed]),
      model,
      { recordResolutionOutcome: (outcome) => f.outcomes.push(outcome) },
    );
    return graph.relationships.filter((edge) => edge.type === 'CALLS');
  };
  return { ...f, owners, implementations, run };
}

describe('provider call outcomes', () => {
  it('distinguishes nested calls that share their starting position', () => {
    const f = fixture();
    expect(selectedCallKey('caller.ts', f.site.atRange)).not.toBe(
      selectedCallKey('caller.ts', {
        ...f.site.atRange,
        endCol: f.site.atRange.endCol + 4,
      }),
    );
  });

  it('uses the selected primary return even when runtime dispatch has several targets', () => {
    const f = fixture();
    const parsed = {
      ...f.parsed,
      callResultAssignmentSites: [{ callSite: f.site.atRange, inScope: f.scope.id, lhs: 'result' }],
    };
    const returned: TypeRef = {
      rawName: 'Owner',
      declaredAtScope: 'scope:declaration',
      source: 'return-annotation',
    };
    const index = {
      ...buildWorkspaceResolutionIndex([parsed]),
      declaredReturnTypeByCallableId: new Map([[f.first.nodeId, returned]]),
    };
    const calleeIds = createCalleeIdAccumulator();
    calleeIds.add('caller.ts', 3, 2, 'Function:first.ts:choose');
    calleeIds.add('caller.ts', 3, 2, 'Function:second.ts:choose');
    const selected = new Map([[selectedCallKey('caller.ts', f.site.atRange), f.first]]);
    const update = () =>
      applyPreciseCallResultBindings(
        [parsed],
        f.context.scopes,
        index,
        calleeIds,
        f.context.nodeLookup,
        f.context.model,
        true,
        selected,
      );
    expect(update()).toBe(1);
    expect(f.scope.typeBindings.get('result')).toMatchObject({
      rawName: 'Owner',
      declaredAtScope: 'scope:declaration',
    });
    expect(update()).toBe(0);
  });

  it.each([undefined, null])(
    'clears an inferred assignment before an unselected producer can leak a target (%s)',
    (primary) => {
      const f = fixture();
      const parsed = {
        ...f.parsed,
        callResultAssignmentSites: [
          { callSite: f.site.atRange, inScope: f.scope.id, lhs: 'result' },
        ],
      };
      (f.scope.typeBindings as Map<string, TypeRef>).set('result', {
        rawName: 'WrongReturn',
        declaredAtScope: f.scope.id,
        source: 'assignment-inferred',
      });
      const selected = new Map<string, SymbolDefinition | null>();
      if (primary === null) selected.set(selectedCallKey('caller.ts', f.site.atRange), null);
      const update = () =>
        applyPreciseCallResultBindings(
          [parsed],
          f.context.scopes,
          buildWorkspaceResolutionIndex([parsed]),
          createCalleeIdAccumulator(),
          f.context.nodeLookup,
          f.context.model,
          true,
          selected,
        );
      expect(update()).toBe(1);
      expect(f.scope.typeBindings.has('result')).toBe(false);
      expect(update()).toBe(0);
    },
  );

  it('keeps scope identities separate from graph method, owner and caller identities', () => {
    const f = fixture();
    const result = providerCallOutcome(
      {
        kind: 'unknown',
        candidateIds: [f.member.nodeId],
        candidateSetComplete: true,
      },
      f.site,
      'caller.ts',
      'receiver-bound-calls',
      f.context,
    );
    expect(result).toMatchObject({
      kind: 'suppressed',
      reason: 'overload-unknown',
      siteKind: 'call',
      candidateIds: ['def:member'],
      candidateGraphIds: ['Method:owner.ts:Owner.choose#1'],
      candidateOwnerIds: ['Class:owner.ts:Owner'],
      callerId: 'Function:caller.ts:main',
      candidateSetComplete: true,
    });
  });

  it('retains known candidates and reports incomplete identity coverage', () => {
    const f = fixture();
    const result = callSuppressionIdentities([f.member.nodeId, 'def:missing'], f.site, f.context);
    expect(result.candidateGraphIds).toEqual(['Method:owner.ts:Owner.choose#1']);
    expect(result.candidateSetComplete).toBe(false);
  });

  it.each(['unknown', 'ambiguous', 'inapplicable'] as const)(
    'does not resume lexical fallback after a provider %s decision',
    (kind) => {
      const f = fixture();
      expect(
        f.run({
          kind,
          candidateIds: [f.first.nodeId],
          candidateSetComplete: true,
        }),
      ).toEqual([]);
      expect(f.handled.has('caller.ts:3:2')).toBe(true);
      expect(f.outcomes).toContainEqual(
        expect.objectContaining({
          kind: 'suppressed',
          candidateGraphIds: ['Function:first.ts:choose'],
          callerId: 'Function:caller.ts:main',
          candidateSetComplete: true,
          reason: kind === 'ambiguous' ? 'member-lookup-ambiguous' : `overload-${kind}`,
        }),
      );
    },
  );

  it('honors the selected declaration before a different lexical first match', () => {
    const f = fixture();
    expect(f.run({ kind: 'resolved', definition: f.second }).map((edge) => edge.targetId)).toEqual([
      'Function:second.ts:choose',
    ]);
    expect(f.outcomes).toContainEqual(
      expect.objectContaining({
        kind: 'resolved',
        phase: 'free-call-fallback',
        targetId: f.second.nodeId,
      }),
    );
  });

  it('preserves existing lookup when the provider declines handling', () => {
    const f = fixture();
    const selected = new Map<string, SymbolDefinition | null>();
    expect(f.run(undefined, selected).map((edge) => edge.targetId)).toEqual([
      'Function:first.ts:choose',
    ]);
    expect(selected.get(selectedCallKey('caller.ts', f.site.atRange))).toBe(f.first);
  });

  it('retains a partial boundary when a selected declaration has no graph identity', () => {
    const f = fixture();
    expect(
      f.run({
        kind: 'resolved',
        definition: {
          ...f.second,
          nodeId: 'def:missing',
          qualifiedName: 'missing',
        },
      }),
    ).toEqual([]);
    expect(f.handled.has('caller.ts:3:2')).toBe(true);
    expect(f.outcomes).toContainEqual(
      expect.objectContaining({
        kind: 'suppressed',
        reason: 'overload-unknown',
        candidateSetComplete: false,
      }),
    );
  });

  it.each(['unknown', 'ambiguous', 'inapplicable'] as const)(
    'does not emit a first member after a receiver %s decision',
    (kind) => {
      const f = receiverFixture();
      expect(
        f.run({
          kind,
          candidateIds: [f.member.nodeId],
          candidateSetComplete: true,
        }),
      ).toEqual([]);
      expect(f.handled.has('caller.ts:3:2')).toBe(true);
      expect(f.outcomes).toContainEqual(
        expect.objectContaining({
          kind: 'suppressed',
          phase: 'receiver-bound-calls',
          candidateSetComplete: true,
        }),
      );
    },
  );

  it('preserves the selected declaration while dispatching its signature', () => {
    const f = receiverFixture();
    const calls = f.run({ kind: 'resolved', definition: f.member }, (selected, owner) => {
      expect(selected).toBe(f.member);
      const implementation = f.implementations.find((item) => item.ownerId === owner.nodeId);
      return implementation === undefined
        ? undefined
        : { kind: 'resolved', definition: implementation };
    });
    expect(calls.map((edge) => edge.targetId).sort()).toEqual(
      [
        'Method:owner.ts:Owner.choose#1',
        ...f.implementations.map((item) => `graph:${item.nodeId}`),
      ].sort(),
    );
    expect(f.outcomes).toContainEqual(
      expect.objectContaining({
        kind: 'resolved',
        phase: 'receiver-bound-calls',
        targetId: f.member.nodeId,
      }),
    );
  });

  it('aggregates unresolved implementations separately from a resolved primary', () => {
    const f = receiverFixture();
    const calls = f.run({ kind: 'resolved', definition: f.member }, (_selected, owner) => ({
      kind: 'unknown',
      candidateSetComplete: true,
      candidateIds: f.implementations
        .filter((item) => item.ownerId === owner.nodeId)
        .map((item) => item.nodeId),
    }));
    expect(calls.map((edge) => edge.targetId)).toEqual(['Method:owner.ts:Owner.choose#1']);
    const dispatch = f.outcomes.filter((outcome) => outcome.phase === 'receiver-dispatch');
    expect(dispatch).toHaveLength(1);
    expect(dispatch[0]).toMatchObject({
      kind: 'suppressed',
      reason: 'overload-unknown',
      candidateSetComplete: true,
      candidateIds: f.implementations.map((item) => item.nodeId),
      candidateOwnerIds: f.owners.map((owner) => `graph:${owner.nodeId}`),
    });
  });
});

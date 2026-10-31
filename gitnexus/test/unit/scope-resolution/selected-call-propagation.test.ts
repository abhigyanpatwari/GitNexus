import { describe, expect, it } from 'vitest';
import {
  buildDefIndex,
  buildMethodDispatchIndex,
  buildModuleScopeIndex,
  buildQualifiedNameIndex,
  buildScopeTree,
  type BindingRef,
  type CallResultAssignmentSite,
  type ParsedFile,
  type ReferenceSite,
  type Scope,
  type SymbolDefinition,
  type TypeRef,
} from 'gitnexus-shared';
import { createKnowledgeGraph } from '../../../src/core/graph/graph.js';
import { createSemanticModel } from '../../../src/core/ingestion/model/semantic-model.js';
import type { ScopeResolutionIndexes } from '../../../src/core/ingestion/model/scope-resolution-indexes.js';
import { createCalleeIdAccumulator } from '../../../src/core/ingestion/scope-resolution/graph-bridge/callee-id-sink.js';
import { buildGraphNodeLookup } from '../../../src/core/ingestion/scope-resolution/graph-bridge/node-lookup.js';
import { emitReceiverBoundCalls } from '../../../src/core/ingestion/scope-resolution/passes/receiver-bound-calls.js';
import {
  callResultBindingKey,
  selectedCallKey,
} from '../../../src/core/ingestion/scope-resolution/passes/provider-call-outcome.js';
import { applyPreciseCallResultBindings } from '../../../src/core/ingestion/scope-resolution/pipeline/run.js';
import type { ResolutionOutcome } from '../../../src/core/ingestion/scope-resolution/resolution-outcome.js';
import { buildWorkspaceResolutionIndex } from '../../../src/core/ingestion/scope-resolution/workspace-index.js';

function chainFixture(reverse: boolean) {
  const count = 24;
  const filePath = 'chain.code';
  const caller: SymbolDefinition = {
    nodeId: 'caller',
    filePath,
    type: 'Function',
    qualifiedName: 'main',
  };
  const owners: SymbolDefinition[] = Array.from({ length: count }, (_, i) => ({
    nodeId: `owner:${i}`,
    filePath,
    type: 'Class',
    qualifiedName: `Owner${i}`,
  }));
  const methods: SymbolDefinition[] = owners.map((owner, i) => ({
    nodeId: `method:${i}`,
    filePath,
    type: 'Method',
    ownerId: owner.nodeId,
    qualifiedName: `${owner.qualifiedName}.${i + 1 < count ? `next${i}` : 'finish'}`,
    parameterCount: 0,
    parameterTypes: [],
  }));
  const module: Scope = {
    id: 'module',
    parent: null,
    kind: 'Module',
    filePath,
    range: { startLine: 0, startCol: 0, endLine: 100, endCol: 0 },
    ownedDefs: owners,
    imports: [],
    typeBindings: new Map(),
    bindings: new Map(
      owners.map((owner) => [owner.qualifiedName!, [{ def: owner, origin: 'local' }]]),
    ),
  };
  const bindings = new Map<string, readonly BindingRef[]>();
  const typeBindings = new Map<string, TypeRef>();
  for (let i = 0; i < count; i++) {
    // The producer join must clear every speculative inferred binding except
    // the explicitly typed chain root before reference resolution.
    typeBindings.set(`value${i}`, {
      rawName: `Owner${i}`,
      declaredAtScope: module.id,
      source: i === 0 ? 'parameter-annotation' : 'assignment-inferred',
    });
    bindings.set(`value${i}`, [
      {
        def: { nodeId: `value:${i}`, filePath, type: 'Variable', qualifiedName: `value${i}` },
        origin: 'local',
      },
    ]);
  }
  const scope: Scope = {
    id: 'function',
    parent: module.id,
    kind: 'Function',
    filePath,
    range: { startLine: 1, startCol: 0, endLine: 90, endCol: 0 },
    ownedDefs: [caller],
    imports: [],
    typeBindings,
    bindings,
  };
  const sites: ReferenceSite[] = methods.map((method, i) => ({
    inScope: scope.id,
    kind: 'call',
    callForm: 'member',
    arity: 0,
    name: method.qualifiedName!.split('.').at(-1)!,
    explicitReceiver: { name: `value${i}` },
    atRange: { startLine: i + 2, startCol: 0, endLine: i + 2, endCol: 15 },
  }));
  const assignments: CallResultAssignmentSite[] = sites.slice(0, -1).map((site, i) => ({
    callSite: site.atRange,
    inScope: scope.id,
    lhs: `value${i + 1}`,
  }));
  const defs = [caller, ...owners, ...methods];
  const parsed: ParsedFile = {
    filePath,
    moduleScope: module.id,
    scopes: [module, scope],
    localDefs: defs,
    parsedImports: [],
    referenceSites: reverse ? [...sites].reverse() : sites,
    callResultAssignmentSites: assignments,
  };
  const scopes = {
    scopeTree: buildScopeTree(parsed.scopes),
    defs: buildDefIndex(defs),
    qualifiedNames: buildQualifiedNameIndex(defs),
    moduleScopes: buildModuleScopeIndex([{ filePath, moduleScopeId: module.id }]),
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
    referenceSites: sites,
    sccs: [],
  } as unknown as ScopeResolutionIndexes;
  const graph = createKnowledgeGraph();
  for (const def of defs)
    graph.addNode({
      id: def.nodeId,
      label: def.type,
      properties: {
        name: def.qualifiedName!.split('.').at(-1)!,
        qualifiedName: def.qualifiedName,
        filePath,
        parameterCount: def.parameterCount,
        parameterTypes: def.parameterTypes,
      },
    });
  const nodeLookup = buildGraphNodeLookup(graph);
  const model = createSemanticModel();
  for (const [i, method] of methods.entries())
    model.methods.register(owners[i]!.nodeId, sites[i]!.name, method);
  const workspace = {
    ...buildWorkspaceResolutionIndex([parsed]),
    declaredReturnTypeByCallableId: new Map(
      methods.slice(0, -1).map((method, i) => [
        method.nodeId,
        {
          rawName: `Owner${i + 1}`,
          declaredAtScope: module.id,
          source: 'return-annotation' as const,
        },
      ]),
    ),
  };
  const selected = new Map<string, SymbolDefinition | null>();
  const pending = new Map<string, string>();
  const outcomes: ResolutionOutcome[] = [];
  const calleeIds = createCalleeIdAccumulator();
  const byProducer = new Map(
    assignments.map((assignment) => [selectedCallKey(filePath, assignment.callSite), assignment]),
  );
  const clearCount = applyPreciseCallResultBindings(
    [parsed],
    scopes,
    workspace,
    calleeIds,
    nodeLookup,
    model,
    true,
    selected,
  );
  let selections = 0;
  const run = (unknownRoot: boolean) =>
    emitReceiverBoundCalls(
      graph,
      scopes,
      [parsed],
      nodeLookup,
      new Set(),
      {
        isSuperReceiver: () => false,
        arityCompatibility: () => 'compatible',
        resolveReceiverMember: (owner) => {
          selections++;
          const definition = methods.find((method) => method.ownerId === owner.nodeId)!;
          return unknownRoot && owner.nodeId === owners[0]!.nodeId
            ? { kind: 'unknown', candidateIds: [definition.nodeId], candidateSetComplete: true }
            : { kind: 'resolved', definition };
        },
      },
      workspace,
      model,
      {
        selectedCalls: selected,
        pendingCallReceivers: pending,
        callResultProducers: new Map(
          assignments.map((assignment) => [
            callResultBindingKey(scope.id, assignment.lhs),
            assignment,
          ]),
        ),
        onSelectedCall: (key) => {
          const assignment = byProducer.get(key);
          if (assignment === undefined) return;
          // Deliver the exact dependency slice to the same return-binding join
          // used by the orchestrator; no workspace scan per selected producer.
          applyPreciseCallResultBindings(
            [{ ...parsed, callResultAssignmentSites: [assignment] }],
            scopes,
            workspace,
            calleeIds,
            nodeLookup,
            model,
            true,
            selected,
          );
        },
        recordResolutionOutcome: (outcome) => outcomes.push(outcome),
      },
    );
  return {
    count,
    clearCount,
    graph,
    methods,
    outcomes,
    pending,
    selected,
    typeBindings,
    run,
    selections: () => selections,
  };
}

describe('selected call dependency propagation', () => {
  it.each([false, true])(
    'resolves a long assignment chain in one receiver pass (reverse=%s)',
    (reverse) => {
      const f = chainFixture(reverse);
      expect(f.clearCount).toBe(f.count - 1);
      f.run(false);
      expect(
        [...f.graph.iterRelationshipsByType('CALLS')].map((edge) => edge.targetId).sort(),
      ).toEqual(f.methods.map((method) => method.nodeId).sort());
      expect(f.selections()).toBe(f.count);
      expect(f.pending.size).toBe(0);
      expect(f.typeBindings.get(`value${f.count - 1}`)?.declaredAtScope).toBe('module');
    },
  );

  it.each([false, true])('keeps a long unknown-origin chain suppressed (reverse=%s)', (reverse) => {
    const f = chainFixture(reverse);
    f.run(true);
    expect([...f.graph.iterRelationshipsByType('CALLS')]).toEqual([]);
    expect(f.selections()).toBe(1);
    expect(f.pending.size).toBe(f.count - 1);
    expect(f.typeBindings.size).toBe(1);
    expect(f.outcomes).toContainEqual(
      expect.objectContaining({ reason: 'receiver-unresolved', name: 'finish' }),
    );
  });
});

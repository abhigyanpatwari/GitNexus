import { describe, expect, it } from 'vitest';
import {
  buildDefIndex,
  buildMethodDispatchIndex,
  buildModuleScopeIndex,
  buildQualifiedNameIndex,
  buildScopeTree,
  type BindingRef,
  type CallableFlowOperand,
  type ParsedFile,
  type Range,
  type Scope,
  type ScopeId,
  type SymbolDefinition,
} from 'gitnexus-shared';
import { createKnowledgeGraph } from '../../../src/core/graph/graph.js';
import type { ScopeResolutionIndexes } from '../../../src/core/ingestion/model/scope-resolution-indexes.js';
import { buildGraphNodeLookup } from '../../../src/core/ingestion/scope-resolution/graph-bridge/node-lookup.js';
import { createCalleeIdAccumulator } from '../../../src/core/ingestion/scope-resolution/graph-bridge/callee-id-sink.js';
import { emitCallableValueFlow } from '../../../src/core/ingestion/scope-resolution/passes/callable-value-flow.js';

const FILE = 'chain.ts';
const MODULE = 'scope:module' as ScopeId;
const ENTRY_SCOPE = 'scope:entry' as ScopeId;

const range = (line: number): Range => ({
  startLine: line,
  startCol: 0,
  endLine: line,
  endCol: 8,
});

const targetDef: SymbolDefinition = {
  nodeId: 'def:chain.ts#1:0:Function:target',
  filePath: FILE,
  type: 'Function',
  qualifiedName: 'target',
  parameterCount: 0,
};

const entryDef: SymbolDefinition = {
  nodeId: 'def:chain.ts#2:0:Function:entry',
  filePath: FILE,
  type: 'Function',
  qualifiedName: 'entry',
  parameterCount: 0,
};

function scope(
  id: ScopeId,
  parent: ScopeId | null,
  kind: Scope['kind'],
  ownedDefs: readonly SymbolDefinition[],
  bindings: ReadonlyMap<string, readonly BindingRef[]> = new Map(),
): Scope {
  return {
    id,
    parent,
    kind,
    range: range(1),
    filePath: FILE,
    bindings,
    ownedDefs,
    imports: [],
    typeBindings: new Map(),
  };
}

function indexes(scopes: readonly Scope[]): ScopeResolutionIndexes {
  const defs = [targetDef, entryDef];
  return {
    scopeTree: buildScopeTree([...scopes]),
    defs: buildDefIndex(defs),
    qualifiedNames: buildQualifiedNameIndex(defs),
    moduleScopes: buildModuleScopeIndex([{ filePath: FILE, moduleScopeId: MODULE }]),
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
    referenceSites: [],
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

function operand(name: string, line: number): CallableFlowOperand {
  return {
    name,
    inScope: ENTRY_SCOPE,
    atRange: range(line),
    indirection: 0,
    addressOf: false,
    expressionKind: 'binding',
  };
}

function runReverseChain(length: number) {
  const moduleBindings = new Map<string, readonly BindingRef[]>([
    ['target', [{ def: targetDef }]],
    ['entry', [{ def: entryDef }]],
  ]);
  const scopes = [
    scope(MODULE, null, 'Module', [targetDef, entryDef], moduleBindings),
    scope(ENTRY_SCOPE, MODULE, 'Function', [entryDef]),
  ];
  const callSite = range(length + 10);
  const copies = Array.from({ length }, (_, index) => index)
    .reverse()
    .map((index) => ({
      kind: 'copy' as const,
      source: operand(`value${index}`, index + 3),
      destination: operand(`value${index + 1}`, index + 3),
    }));
  const parsed: ParsedFile = {
    filePath: FILE,
    moduleScope: MODULE,
    scopes,
    parsedImports: [],
    localDefs: [targetDef, entryDef],
    referenceSites: [
      {
        name: `value${length}`,
        atRange: callSite,
        inScope: ENTRY_SCOPE,
        kind: 'call',
        callForm: 'free',
      },
    ],
    callableFlowSites: [
      {
        kind: 'seed',
        destination: operand('value0', 3),
        targetName: 'target',
        targetRange: range(1),
      },
      ...copies,
      {
        kind: 'invoke',
        callSite,
        inScope: ENTRY_SCOPE,
        callee: operand(`value${length}`, callSite.startLine),
        invocationKind: 'indirect',
        arity: 0,
      },
    ],
  };
  const graph = createKnowledgeGraph();
  graph.addNode({
    id: 'Function:chain.ts:target',
    label: 'Function',
    properties: { name: 'target', qualifiedName: 'target', filePath: FILE },
  });
  graph.addNode({
    id: 'Function:chain.ts:entry',
    label: 'Function',
    properties: { name: 'entry', qualifiedName: 'entry', filePath: FILE },
  });
  const result = emitCallableValueFlow({
    graph,
    scopes: indexes(scopes),
    parsedFiles: [parsed],
    nodeLookup: buildGraphNodeLookup(graph),
    calleeIds: createCalleeIdAccumulator(),
    language: 'typescript',
  });
  return { graph, result };
}

describe('callable-value-flow dependency worklist', () => {
  it('scales linearly for reverse-ordered chains and resolves the terminal call', () => {
    const n = runReverseChain(128);
    const twoN = runReverseChain(256);

    expect(n.result.resolvedInvokes).toBe(1);
    expect(twoN.result.resolvedInvokes).toBe(1);
    expect(n.result.emitted).toBe(1);
    expect(twoN.result.emitted).toBe(1);
    expect(twoN.result.iterations).toBeLessThanOrEqual(n.result.iterations * 2 + 4);
    expect(twoN.result.iterations).toBeLessThan(1_024);
    expect(
      [...twoN.graph.iterRelationshipsByType('CALLS')].map(
        (relationship) => twoN.graph.getNode(relationship.targetId)?.properties.name,
      ),
    ).toEqual(['target']);
  });
});

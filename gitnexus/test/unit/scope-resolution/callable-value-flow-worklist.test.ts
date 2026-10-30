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
import {
  emitCallableValueFlow,
  collectDeferredIndirectCollection,
} from '../../../src/core/ingestion/scope-resolution/passes/callable-value-flow.js';

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
      ambiguousWildcardExports: [],
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
    ['target', [{ def: targetDef, origin: 'local' }]],
    ['entry', [{ def: entryDef, origin: 'local' }]],
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

describe('collectDeferredIndirectCollection', () => {
  it('retains no per-call signature index when there are no indirect invocations', () => {
    const parsed: ParsedFile = {
      filePath: FILE,
      moduleScope: MODULE,
      scopes: [],
      parsedImports: [],
      localDefs: [],
      referenceSites: Array.from({ length: 10_000 }, (_, line) => ({
        name: 'target',
        kind: 'call' as const,
        callForm: 'free' as const,
        atRange: range(line + 1),
        inScope: MODULE,
        arity: 0,
      })),
      callableFlowSites: [],
    };
    const collected = collectDeferredIndirectCollection([parsed]);
    expect(collected.sites.size).toBe(0);
    expect(collected.callSignaturesBySite.size).toBe(0);
  });

  it('keeps direct-call argument signatures across files when an indirect invoke needs them', () => {
    const direct: ParsedFile = {
      filePath: 'caller.ts',
      moduleScope: MODULE,
      scopes: [],
      parsedImports: [],
      localDefs: [],
      referenceSites: [
        { name: 'register', kind: 'call', atRange: range(1), inScope: MODULE, arity: 1 },
        { name: 'unrelated', kind: 'call', atRange: range(2), inScope: MODULE, arity: 0 },
        // Multiple captures at one call keep the richest overload evidence.
        {
          name: 'register',
          kind: 'call',
          atRange: range(1),
          inScope: MODULE,
          arity: 1,
          argumentTypes: ['Handler'],
        },
      ],
      callableFlowSites: [
        {
          kind: 'argument',
          callSite: range(1),
          parameterIndex: 0,
          source: operand('handler', 1),
          directCalleeName: 'register',
        },
      ],
    };
    const indirect: ParsedFile = {
      filePath: FILE,
      moduleScope: MODULE,
      scopes: [],
      parsedImports: [],
      localDefs: [],
      referenceSites: [{ name: 'callback', kind: 'call', atRange: range(3), inScope: ENTRY_SCOPE }],
      callableFlowSites: [
        {
          kind: 'invoke',
          callSite: range(3),
          inScope: ENTRY_SCOPE,
          callee: operand('callback', 3),
          invocationKind: 'indirect',
          arity: 0,
        },
      ],
    };
    const collected = collectDeferredIndirectCollection([direct, indirect]);
    expect([...collected.sites]).toEqual([`${FILE}:3:0`]);
    expect([...collected.callSignaturesBySite]).toEqual([
      ['caller.ts:1:0', { parameterCount: 1, parameterTypes: ['Handler'] }],
    ]);
    const unmatched = collectDeferredIndirectCollection([
      direct,
      { ...indirect, referenceSites: [] },
    ]);
    expect(unmatched.sites.size).toBe(0);
    expect(unmatched.callSignaturesBySite.size).toBe(0);
  });

  it('skips the callable solver for ordinary facts and reports unmatched invokes', () => {
    const graph = createKnowledgeGraph();
    const result = emitCallableValueFlow({
      graph,
      scopes: indexes([]),
      nodeLookup: buildGraphNodeLookup(graph),
      calleeIds: createCalleeIdAccumulator(),
      language: 'typescript',
      parsedFiles: [
        {
          filePath: FILE,
          moduleScope: MODULE,
          scopes: [],
          parsedImports: [],
          localDefs: [],
          referenceSites: [],
          callableFlowSites: [
            {
              kind: 'seed',
              destination: operand('unused', 1),
              targetName: 'target',
              targetRange: range(1),
            },
            {
              kind: 'invoke',
              callSite: range(3),
              inScope: ENTRY_SCOPE,
              callee: operand('stale', 3),
              invocationKind: 'indirect',
              arity: 0,
            },
          ],
        },
      ],
    });
    expect(result).toEqual({
      emitted: 0,
      resolvedInvokes: 0,
      ambiguousInvokes: 0,
      unmatchedInvokes: 1,
      iterations: 0,
    });
    expect(graph.relationshipCount).toBe(0);
  });
});

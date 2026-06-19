/**
 * Unit tests for the resolved-callee-id capture sink (#2227 follow-up plan U2).
 *
 * During Phase-4 scope-resolution CALLS-edge emission, each resolved call site's
 * `(line, col) → calleeId` is accumulated across ALL THREE CALLS emit paths,
 * each BEFORE its dedup (KTD6/R8), gated on `--pdg`. A later unit (U3) joins
 * this to CFG BasicBlocks by exact call-site position.
 *
 * Coordinate base (KTD7 — load-bearing): the sink keys on
 * `atRange.startLine` / `atRange.startCol`, which are 1-based line / 0-based col
 * (`nodeToCapture` builds them as `row + 1` / `column`; the `Range` doc confirms
 * "1-based startLine; 0-based startCol"). This is byte-equal to U1's
 * `SiteRecord.at` (`[startPosition.row + 1, startPosition.column]`), so the U3
 * position join lands.
 *
 * Strategy:
 *   - `tryEmitEdge` / `tryEmitEdgeWithExplicitTargetId` and `emitReferencesViaLookup`
 *     are driven directly with a real `ScopeResolutionIndexes` + `GraphNodeLookup`
 *     (the emit-references.test.ts fixture pattern), so the capture runs on the
 *     real emit path.
 *   - `emitFreeCallFallback` is driven with a hand-built but fully-typed real
 *     `ParsedFile` whose Module-scope bindings resolve a free call — exercising
 *     the inline `addRelationship` capture line (the regression guard for the
 *     "only tryEmitEdge" bug).
 */

import { describe, it, expect } from 'vitest';
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
  type Reference,
  type ReferenceSite,
  type Scope,
  type ScopeId,
  type SymbolDefinition,
} from 'gitnexus-shared';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import type { KnowledgeGraph } from '../../src/core/graph/types.js';
import type { ScopeResolutionIndexes } from '../../src/core/ingestion/model/scope-resolution-indexes.js';
import {
  buildGraphNodeLookup,
  type GraphNodeLookup,
} from '../../src/core/ingestion/scope-resolution/graph-bridge/node-lookup.js';
import {
  tryEmitEdge,
  tryEmitEdgeWithExplicitTargetId,
} from '../../src/core/ingestion/scope-resolution/graph-bridge/edges.js';
import { emitReferencesViaLookup } from '../../src/core/ingestion/scope-resolution/graph-bridge/references-to-edges.js';
import { emitFreeCallFallback } from '../../src/core/ingestion/scope-resolution/passes/free-call-fallback.js';
import { buildWorkspaceResolutionIndex } from '../../src/core/ingestion/scope-resolution/workspace-index.js';
import { createSemanticModel } from '../../src/core/ingestion/model/semantic-model.js';
import {
  createCalleeIdAccumulator,
  calleeIdPosKey,
  type CalleeIdAccumulator,
} from '../../src/core/ingestion/scope-resolution/graph-bridge/callee-id-sink.js';

// ─── Fixture builders ─────────────────────────────────────────────────────

const FILE = 'x.ts';

const range = (sl = 1, sc = 0, el = 100, ec = 0): Range => ({
  startLine: sl,
  startCol: sc,
  endLine: el,
  endCol: ec,
});

const def = (
  nodeId: string,
  type: SymbolDefinition['type'] = 'Function',
  qname?: string,
  filePath = FILE,
): SymbolDefinition => ({
  nodeId,
  filePath,
  type,
  ...(qname !== undefined ? { qualifiedName: qname } : {}),
});

const scope = (
  id: ScopeId,
  parent: ScopeId | null,
  kind: Scope['kind'],
  ownedDefs: readonly SymbolDefinition[] = [],
  r: Range = range(),
  filePath = FILE,
  bindings: Record<string, readonly BindingRef[]> = {},
): Scope => ({
  id,
  parent,
  kind,
  range: r,
  filePath,
  bindings: new Map(Object.entries(bindings)),
  ownedDefs,
  imports: [],
  typeBindings: new Map(),
});

function makeIndexes(
  scopes: readonly Scope[],
  allDefs: readonly SymbolDefinition[],
): ScopeResolutionIndexes {
  return {
    scopeTree: buildScopeTree([...scopes]),
    defs: buildDefIndex([...allDefs]),
    qualifiedNames: buildQualifiedNameIndex([...allDefs]),
    moduleScopes: buildModuleScopeIndex(
      scopes
        .filter((s) => s.kind === 'Module')
        .map((s) => ({ filePath: s.filePath, moduleScopeId: s.id })),
    ),
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
      totalFiles: 0,
      totalEdges: 0,
      linkedEdges: 0,
      unresolvedEdges: 0,
      sccCount: 0,
      largestSccSize: 0,
    },
  };
}

/** A graph node for a Function so `buildGraphNodeLookup` registers it. */
function fnNode(graph: KnowledgeGraph, id: string, name: string, filePath = FILE): void {
  graph.addNode({
    id,
    label: 'Function' as NodeLabel,
    properties: { name, filePath, qualifiedName: name },
  });
}

/** A call-kind reference site at a given position, for the receiver-bound /
 *  direct `tryEmitEdge` driver. The bridge reads `inScope`, `atRange`, `kind`. */
function callSite(inScope: ScopeId, line: number, col: number): ReferenceSite {
  return {
    name: 'callee',
    atRange: range(line, col, line, col + 4),
    inScope,
    kind: 'call',
  };
}

/** Collapse `accumulator.get(file)` into a plain `{ posKey: sortedIds[] }`
 *  object for unconditional `toEqual` / `toMatchObject` assertions. */
function snapshot(acc: CalleeIdAccumulator, filePath: string): Record<string, string[]> {
  const byPos = acc.get(filePath);
  const out: Record<string, string[]> = {};
  for (const [key, ids] of byPos ?? new Map<string, ReadonlySet<string>>()) {
    out[key] = [...ids].sort();
  }
  return out;
}

// ─── Path 1: tryEmitEdge ──────────────────────────────────────────────────

describe('callee-id capture — tryEmitEdge (receiver-bound path)', () => {
  it('captures two receiver-bound CALLS at distinct positions (pos → {id})', () => {
    const callerFn = def('def:caller', 'Function', 'caller');
    const targetA = def('def:targetA', 'Function', 'targetA');
    const targetB = def('def:targetB', 'Function', 'targetB');
    const mod = scope('scope:m', null, 'Module', [callerFn, targetA, targetB]);
    const indexes = makeIndexes([mod], [callerFn, targetA, targetB]);

    const graph = createKnowledgeGraph();
    fnNode(graph, 'fn:caller', 'caller');
    fnNode(graph, 'fn:targetA', 'targetA');
    fnNode(graph, 'fn:targetB', 'targetB');
    const lookup: GraphNodeLookup = buildGraphNodeLookup(graph);

    const acc = createCalleeIdAccumulator();
    const seen = new Set<string>();
    const okA = tryEmitEdge(
      graph,
      indexes,
      lookup,
      callSite('scope:m', 10, 4),
      targetA,
      'call',
      seen,
      0.85,
      false,
      { sink: acc, filePath: FILE },
    );
    const okB = tryEmitEdge(
      graph,
      indexes,
      lookup,
      callSite('scope:m', 20, 8),
      targetB,
      'call',
      seen,
      0.85,
      false,
      { sink: acc, filePath: FILE },
    );

    expect(okA).toBe(true);
    expect(okB).toBe(true);
    expect(snapshot(acc, FILE)).toEqual({
      [calleeIdPosKey(10, 4)]: ['fn:targetA'],
      [calleeIdPosKey(20, 8)]: ['fn:targetB'],
    });
  });

  it('R2 dispatch — one site, two resolved targets → pos → {idA, idB}', () => {
    const callerFn = def('def:caller', 'Function', 'caller');
    const targetA = def('def:dispA', 'Function', 'dispA');
    const targetB = def('def:dispB', 'Function', 'dispB');
    const mod = scope('scope:m', null, 'Module', [callerFn, targetA, targetB]);
    const indexes = makeIndexes([mod], [callerFn, targetA, targetB]);

    const graph = createKnowledgeGraph();
    fnNode(graph, 'fn:caller', 'caller');
    fnNode(graph, 'fn:dispA', 'dispA');
    fnNode(graph, 'fn:dispB', 'dispB');
    const lookup = buildGraphNodeLookup(graph);

    const acc = createCalleeIdAccumulator();
    const seen = new Set<string>();
    // Same site (same position) dispatched to two distinct targets — mirrors
    // interface-dispatch emitting a secondary CALLS edge for one call site.
    const site = callSite('scope:m', 30, 2);
    tryEmitEdge(graph, indexes, lookup, site, targetA, 'call', seen, 0.85, false, {
      sink: acc,
      filePath: FILE,
    });
    tryEmitEdge(graph, indexes, lookup, site, targetB, 'interface-dispatch', seen, 0.85, false, {
      sink: acc,
      filePath: FILE,
    });

    expect(snapshot(acc, FILE)).toEqual({
      [calleeIdPosKey(30, 2)]: ['fn:dispA', 'fn:dispB'],
    });
  });

  it('dedup-independence — same target, two lines, collapse on → both positions captured', () => {
    const callerFn = def('def:caller', 'Function', 'caller');
    const target = def('def:target', 'Function', 'target');
    const mod = scope('scope:m', null, 'Module', [callerFn, target]);
    const indexes = makeIndexes([mod], [callerFn, target]);

    const graph = createKnowledgeGraph();
    fnNode(graph, 'fn:caller', 'caller');
    fnNode(graph, 'fn:target', 'target');
    const lookup = buildGraphNodeLookup(graph);

    const acc = createCalleeIdAccumulator();
    const seen = new Set<string>();
    // collapse = true ⇒ the dedup key drops the line, so the SECOND edge is
    // deduped away (returns false). The capture is BEFORE the dedup, so BOTH
    // positions are recorded regardless.
    const okFirst = tryEmitEdge(
      graph,
      indexes,
      lookup,
      callSite('scope:m', 11, 0),
      target,
      'call',
      seen,
      0.85,
      true,
      { sink: acc, filePath: FILE },
    );
    const okSecond = tryEmitEdge(
      graph,
      indexes,
      lookup,
      callSite('scope:m', 12, 0),
      target,
      'call',
      seen,
      0.85,
      true,
      { sink: acc, filePath: FILE },
    );

    expect(okFirst).toBe(true);
    // Collapsed dedup drops the second EDGE...
    expect(okSecond).toBe(false);
    expect(graph.relationships).toHaveLength(1);
    // ...but BOTH call-site positions are captured.
    expect(snapshot(acc, FILE)).toEqual({
      [calleeIdPosKey(11, 0)]: ['fn:target'],
      [calleeIdPosKey(12, 0)]: ['fn:target'],
    });
  });

  it('R4 gating — sink undefined (pdg off): no capture and identical edge output', () => {
    const callerFn = def('def:caller', 'Function', 'caller');
    const target = def('def:target', 'Function', 'target');
    const mod = scope('scope:m', null, 'Module', [callerFn, target]);
    const indexes = makeIndexes([mod], [callerFn, target]);

    const withGraph = createKnowledgeGraph();
    fnNode(withGraph, 'fn:caller', 'caller');
    fnNode(withGraph, 'fn:target', 'target');
    const withLookup = buildGraphNodeLookup(withGraph);
    const acc = createCalleeIdAccumulator();
    tryEmitEdge(
      withGraph,
      indexes,
      withLookup,
      callSite('scope:m', 7, 3),
      target,
      'call',
      new Set<string>(),
      0.85,
      false,
      { sink: acc, filePath: FILE },
    );

    const offGraph = createKnowledgeGraph();
    fnNode(offGraph, 'fn:caller', 'caller');
    fnNode(offGraph, 'fn:target', 'target');
    const offLookup = buildGraphNodeLookup(offGraph);
    tryEmitEdge(
      offGraph,
      indexes,
      offLookup,
      callSite('scope:m', 7, 3),
      target,
      'call',
      new Set<string>(),
      0.85,
      false,
      undefined,
    );

    // pdg-off: nothing captured.
    expect(offGraph.relationships).toHaveLength(1);
    // The EDGE rows are byte-identical between on and off (only capture differs).
    expect(offGraph.relationships).toEqual(withGraph.relationships);
    // The on-run DID capture (so the comparison is meaningful, not vacuous).
    expect(snapshot(acc, FILE)).toEqual({ [calleeIdPosKey(7, 3)]: ['fn:target'] });
  });
});

// ─── Path 1b: tryEmitEdgeWithExplicitTargetId ─────────────────────────────

describe('callee-id capture — tryEmitEdgeWithExplicitTargetId', () => {
  it('captures the explicit target id at the call-site position', () => {
    const callerFn = def('def:caller', 'Function', 'caller');
    const mod = scope('scope:m', null, 'Module', [callerFn]);
    const indexes = makeIndexes([mod], [callerFn]);

    const graph = createKnowledgeGraph();
    fnNode(graph, 'fn:caller', 'caller');
    const lookup = buildGraphNodeLookup(graph);

    const acc = createCalleeIdAccumulator();
    const ok = tryEmitEdgeWithExplicitTargetId(
      graph,
      indexes,
      lookup,
      callSite('scope:m', 42, 6),
      'fn:explicitTarget',
      'global',
      new Set<string>(),
      0.85,
      false,
      { sink: acc, filePath: FILE },
    );

    expect(ok).toBe(true);
    expect(snapshot(acc, FILE)).toEqual({
      [calleeIdPosKey(42, 6)]: ['fn:explicitTarget'],
    });
  });
});

// ─── Path 3: emitReferencesViaLookup ──────────────────────────────────────

describe('callee-id capture — emitReferencesViaLookup', () => {
  it('captures a CALLS emitted via the inline addRelationship', () => {
    const callerFn = def('def:saveUser', 'Function', 'saveUser');
    const targetFn = def('def:User.save', 'Method', 'User.save');
    const mod = scope('scope:m', null, 'Module', [callerFn, targetFn]);
    const indexes = makeIndexes([mod], [callerFn, targetFn]);

    const graph = createKnowledgeGraph();
    fnNode(graph, 'fn:saveUser', 'saveUser');
    graph.addNode({
      id: 'm:User.save',
      label: 'Method' as NodeLabel,
      properties: { name: 'save', filePath: FILE, qualifiedName: 'User.save' },
    });
    const lookup = buildGraphNodeLookup(graph);

    const ref: Reference = {
      fromScope: 'scope:m',
      toDef: 'def:User.save',
      atRange: range(10, 4, 10, 8),
      kind: 'call',
      confidence: 0.75,
      evidence: [],
    };
    const referenceIndex = {
      bySourceScope: new Map<ScopeId, readonly Reference[]>([['scope:m', [ref]]]),
    };

    const acc = createCalleeIdAccumulator();
    const result = emitReferencesViaLookup(graph, indexes, referenceIndex, lookup, undefined, acc);

    expect(result.emitted).toBe(1);
    const targetId = graph.relationships[0]!.targetId;
    expect(snapshot(acc, FILE)).toEqual({
      [calleeIdPosKey(10, 4)]: [targetId],
    });
  });

  it('R4 gating — sink undefined: identical edges, nothing captured', () => {
    const callerFn = def('def:caller', 'Function', 'caller');
    const targetFn = def('def:helper', 'Function', 'helper');
    const mod = scope('scope:m', null, 'Module', [callerFn, targetFn]);
    const indexes = makeIndexes([mod], [callerFn, targetFn]);

    const ref: Reference = {
      fromScope: 'scope:m',
      toDef: 'def:helper',
      atRange: range(5, 2, 5, 8),
      kind: 'call',
      confidence: 0.8,
      evidence: [],
    };
    const referenceIndex = {
      bySourceScope: new Map<ScopeId, readonly Reference[]>([['scope:m', [ref]]]),
    };

    const mkGraph = (): KnowledgeGraph => {
      const g = createKnowledgeGraph();
      fnNode(g, 'fn:caller', 'caller');
      fnNode(g, 'fn:helper', 'helper');
      return g;
    };

    const onGraph = mkGraph();
    const acc = createCalleeIdAccumulator();
    emitReferencesViaLookup(
      onGraph,
      indexes,
      referenceIndex,
      buildGraphNodeLookup(onGraph),
      undefined,
      acc,
    );

    const offGraph = mkGraph();
    emitReferencesViaLookup(
      offGraph,
      indexes,
      referenceIndex,
      buildGraphNodeLookup(offGraph),
      undefined,
      undefined,
    );

    expect(offGraph.relationships).toEqual(onGraph.relationships);
    expect(offGraph.relationships).toHaveLength(1);
    expect(snapshot(acc, FILE)).toEqual({
      [calleeIdPosKey(5, 2)]: [onGraph.relationships[0]!.targetId],
    });
  });
});

// ─── Path 2: emitFreeCallFallback (regression guard for the "only tryEmitEdge" bug) ─

describe('callee-id capture — emitFreeCallFallback (inline addRelationship)', () => {
  // Build a real (hand-constructed, fully-typed) ParsedFile whose Module-scope
  // bindings resolve a free call `helper()` to a local Function — so
  // emitFreeCallFallback emits a CALLS via its own inline addRelationship and
  // the capture line runs.
  const FREE_FILE = 'free.ts';
  const targetDef = def('def:helper', 'Function', 'helper', FREE_FILE);
  const callerDef = def('def:main', 'Function', 'main', FREE_FILE);

  const freeCallSite: ReferenceSite = {
    name: 'helper',
    atRange: range(3, 2, 3, 8),
    inScope: 'scope:free-mod',
    kind: 'call',
    callForm: 'free',
    arity: 0,
  };

  const moduleScope = scope(
    'scope:free-mod',
    null,
    'Module',
    [callerDef, targetDef],
    range(1, 0, 100, 0),
    FREE_FILE,
    { helper: [{ def: targetDef, origin: 'local' }] },
  );

  const parsed: ParsedFile = {
    filePath: FREE_FILE,
    moduleScope: 'scope:free-mod',
    scopes: [moduleScope],
    parsedImports: [],
    localDefs: [callerDef, targetDef],
    referenceSites: [freeCallSite],
  };

  const buildDriver = (): {
    graph: KnowledgeGraph;
    indexes: ScopeResolutionIndexes;
    lookup: GraphNodeLookup;
  } => {
    const indexes = makeIndexes([moduleScope], [callerDef, targetDef]);
    const graph = createKnowledgeGraph();
    fnNode(graph, 'fn:main', 'main', FREE_FILE);
    fnNode(graph, 'fn:helper', 'helper', FREE_FILE);
    return { graph, indexes, lookup: buildGraphNodeLookup(graph) };
  };

  it('captures the resolved callee id at the free-call site', () => {
    const { graph, indexes, lookup } = buildDriver();
    const model = createSemanticModel();
    const workspaceIndex = buildWorkspaceResolutionIndex([parsed]);
    const acc = createCalleeIdAccumulator();

    const emitted = emitFreeCallFallback(
      graph,
      indexes,
      [parsed],
      lookup,
      { bySourceScope: new Map() },
      new Set<string>(),
      model,
      workspaceIndex,
      { calleeIdSink: acc },
    );

    expect(emitted).toBe(1);
    const callsEdge = graph.relationships.find((r) => r.type === 'CALLS')!;
    expect(callsEdge.targetId).toBe('fn:helper');
    expect(snapshot(acc, FREE_FILE)).toEqual({
      [calleeIdPosKey(3, 2)]: ['fn:helper'],
    });
  });

  it('R4 gating — sink undefined: same CALLS edge, nothing captured', () => {
    const on = buildDriver();
    const off = buildDriver();
    const model = createSemanticModel();
    const workspaceIndex = buildWorkspaceResolutionIndex([parsed]);
    const acc = createCalleeIdAccumulator();

    emitFreeCallFallback(
      on.graph,
      on.indexes,
      [parsed],
      on.lookup,
      { bySourceScope: new Map() },
      new Set<string>(),
      model,
      workspaceIndex,
      { calleeIdSink: acc },
    );
    emitFreeCallFallback(
      off.graph,
      off.indexes,
      [parsed],
      off.lookup,
      { bySourceScope: new Map() },
      new Set<string>(),
      createSemanticModel(),
      buildWorkspaceResolutionIndex([parsed]),
      {},
    );

    expect(off.graph.relationships).toEqual(on.graph.relationships);
    expect(off.graph.relationships.filter((r) => r.type === 'CALLS')).toHaveLength(1);
    expect(snapshot(acc, FREE_FILE)).toEqual({
      [calleeIdPosKey(3, 2)]: ['fn:helper'],
    });
  });
});

describe('callee-id accumulator — delete (R6 per-file release)', () => {
  it('delete(file) frees that file map and leaves other files intact', () => {
    const acc = createCalleeIdAccumulator();
    acc.add('a.ts', 2, 4, 'fn:a');
    acc.add('b.ts', 5, 0, 'fn:b');
    expect(snapshot(acc, 'a.ts')).toEqual({ [calleeIdPosKey(2, 4)]: ['fn:a'] });

    acc.delete('a.ts');

    expect(acc.get('a.ts')).toBeUndefined();
    expect(snapshot(acc, 'b.ts')).toEqual({ [calleeIdPosKey(5, 0)]: ['fn:b'] });
  });

  it('delete of an absent file is a no-op', () => {
    const acc = createCalleeIdAccumulator();
    acc.add('b.ts', 5, 0, 'fn:b');
    acc.delete('missing.ts');
    expect(snapshot(acc, 'b.ts')).toEqual({ [calleeIdPosKey(5, 0)]: ['fn:b'] });
  });
});

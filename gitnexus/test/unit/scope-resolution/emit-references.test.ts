/**
 * Unit tests for `emit-references` (RFC #909 Ring 2 PKG #925).
 *
 * Covers kind → RelationshipType mapping, enclosing-def resolution
 * through the scope tree, evidence serialization onto emitted edges,
 * skip counts, and the optional `INGESTION_EMIT_SCOPES` scope-node
 * flush.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  buildDefIndex,
  buildMethodDispatchIndex,
  buildModuleScopeIndex,
  buildQualifiedNameIndex,
  buildScopeTree,
  type BindingRef,
  type DefId,
  type Range,
  type Reference,
  type ReferenceIndex,
  type Scope,
  type ScopeId,
  type SymbolDefinition,
} from 'gitnexus-shared';
import { createKnowledgeGraph } from '../../../src/core/graph/graph.js';
import {
  emitReferencesToGraph,
  emitScopeGraph,
} from '../../../src/core/ingestion/emit-references.js';
import type { ScopeResolutionIndexes } from '../../../src/core/ingestion/model/scope-resolution-indexes.js';

// ─── Env isolation ────────────────────────────────────────────────────────

let savedEnv: string | undefined;
beforeEach(() => {
  savedEnv = process.env['INGESTION_EMIT_SCOPES'];
  delete process.env['INGESTION_EMIT_SCOPES'];
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env['INGESTION_EMIT_SCOPES'];
  else process.env['INGESTION_EMIT_SCOPES'] = savedEnv;
});

// ─── Fixture builders ─────────────────────────────────────────────────────

const range = (sl = 1, sc = 0, el = 100, ec = 0): Range => ({
  startLine: sl,
  startCol: sc,
  endLine: el,
  endCol: ec,
});

const def = (
  nodeId: string,
  type: SymbolDefinition['type'] = 'Method',
  qname?: string,
): SymbolDefinition => ({
  nodeId,
  filePath: 'x.ts',
  type,
  ...(qname !== undefined ? { qualifiedName: qname } : {}),
});

const scope = (
  id: ScopeId,
  parent: ScopeId | null,
  kind: Scope['kind'],
  ownedDefs: readonly SymbolDefinition[] = [],
  r: Range = range(),
  filePath = 'x.ts',
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

function makeIndexes(scopes: Scope[], allDefs: SymbolDefinition[]): ScopeResolutionIndexes {
  return {
    scopeTree: buildScopeTree(scopes),
    defs: buildDefIndex(allDefs),
    qualifiedNames: buildQualifiedNameIndex(allDefs),
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

function buildRefIndex(sourceScope: ScopeId, refs: readonly Reference[]): ReferenceIndex {
  const bySource = new Map<ScopeId, readonly Reference[]>();
  bySource.set(sourceScope, refs);
  const byTarget = new Map<DefId, Reference[]>();
  for (const ref of refs) {
    const bucket = byTarget.get(ref.toDef) ?? [];
    bucket.push(ref);
    byTarget.set(ref.toDef, bucket);
  }
  return {
    bySourceScope: bySource,
    byTargetDef: new Map(
      Array.from(byTarget.entries()).map(([k, v]) => [k, Object.freeze([...v])]),
    ),
  };
}

// ─── Kind mapping + basic emission ────────────────────────────────────────

describe('emitReferencesToGraph: kind mapping', () => {
  it('maps call → CALLS and carries confidence + evidence onto the edge', () => {
    const callerFn = def('def:saveUser', 'Function', 'saveUser');
    const targetFn = def('def:User.save', 'Method', 'User.save');
    const mod = scope('scope:m', null, 'Module', [callerFn, targetFn]);
    const indexes = makeIndexes([mod], [callerFn, targetFn]);

    const ref: Reference = {
      fromScope: 'scope:m',
      toDef: 'def:User.save',
      atRange: range(10, 4, 10, 8),
      kind: 'call',
      confidence: 0.75,
      evidence: [
        { kind: 'local', weight: 0.55 },
        { kind: 'arity-match', weight: 0.1, note: 'compatible' },
      ],
    };

    const graph = createKnowledgeGraph();
    const stats = emitReferencesToGraph({
      graph,
      scopes: indexes,
      referenceIndex: buildRefIndex('scope:m', [ref]),
    });

    expect(stats.edgesEmitted).toBe(1);
    expect(graph.relationships).toHaveLength(1);
    const edge = graph.relationships[0]!;
    expect(edge.type).toBe('CALLS');
    expect(edge.sourceId).toBe('def:saveUser');
    expect(edge.targetId).toBe('def:User.save');
    expect(edge.confidence).toBe(0.75);
    expect(edge.evidence).toEqual([
      { kind: 'local', weight: 0.55 },
      { kind: 'arity-match', weight: 0.1, note: 'compatible' },
    ]);
    expect(edge.reason).toContain('call');
    expect(edge.reason).toContain('0.750');
  });

  it('maps read / write → ACCESSES and stamps step=1 / step=2 for discrimination', () => {
    const fn = def('def:render', 'Function');
    const field = def('def:User.name', 'Property');
    const mod = scope('scope:m', null, 'Module', [fn, field]);
    const indexes = makeIndexes([mod], [fn, field]);

    const readRef: Reference = {
      fromScope: 'scope:m',
      toDef: 'def:User.name',
      atRange: range(5, 0, 5, 4),
      kind: 'read',
      confidence: 0.55,
      evidence: [{ kind: 'local', weight: 0.55 }],
    };
    const writeRef: Reference = {
      fromScope: 'scope:m',
      toDef: 'def:User.name',
      atRange: range(6, 0, 6, 4),
      kind: 'write',
      confidence: 0.55,
      evidence: [{ kind: 'local', weight: 0.55 }],
    };

    const graph = createKnowledgeGraph();
    emitReferencesToGraph({
      graph,
      scopes: indexes,
      referenceIndex: buildRefIndex('scope:m', [readRef, writeRef]),
    });

    const edges = graph.relationships;
    expect(edges).toHaveLength(2);
    expect(edges.every((e) => e.type === 'ACCESSES')).toBe(true);
    const readEdge = edges.find((e) => e.step === 1)!;
    const writeEdge = edges.find((e) => e.step === 2)!;
    expect(readEdge).toBeDefined();
    expect(writeEdge).toBeDefined();
  });

  it('maps inherits → INHERITS and type-reference/import-use → USES', () => {
    const hostFn = def('def:host', 'Function');
    const base = def('def:Base', 'Class');
    const mixin = def('def:Mixin', 'Class');
    const module = def('def:SomeModule', 'Namespace');
    const mod = scope('scope:m', null, 'Module', [hostFn, base, mixin, module]);
    const indexes = makeIndexes([mod], [hostFn, base, mixin, module]);

    const refs: Reference[] = [
      {
        fromScope: 'scope:m',
        toDef: 'def:Base',
        atRange: range(1, 0, 1, 4),
        kind: 'inherits',
        confidence: 0.9,
        evidence: [],
      },
      {
        fromScope: 'scope:m',
        toDef: 'def:Mixin',
        atRange: range(2, 0, 2, 4),
        kind: 'type-reference',
        confidence: 0.7,
        evidence: [],
      },
      {
        fromScope: 'scope:m',
        toDef: 'def:SomeModule',
        atRange: range(3, 0, 3, 4),
        kind: 'import-use',
        confidence: 0.5,
        evidence: [],
      },
    ];

    const graph = createKnowledgeGraph();
    emitReferencesToGraph({
      graph,
      scopes: indexes,
      referenceIndex: buildRefIndex('scope:m', refs),
    });

    const types = graph.relationships.map((r) => r.type).sort();
    expect(types).toEqual(['INHERITS', 'USES', 'USES']);
  });
});

// ─── Enclosing-def resolution ─────────────────────────────────────────────

describe('enclosing-def resolution', () => {
  it('uses the innermost Function/Method ancestor as the caller', () => {
    const method = def('def:User.save', 'Method');
    const classScope = scope('scope:c', 'scope:m', 'Class', [], range(5, 0, 40, 0));
    const methodScope = scope('scope:f', 'scope:c', 'Function', [method], range(10, 0, 30, 0));
    const mod = scope('scope:m', null, 'Module', [], range(1, 0, 100, 0));
    const target = def('def:Logger.log', 'Method');
    const indexes = makeIndexes([mod, classScope, methodScope], [method, target]);

    // Reference fires from a block inside the method scope.
    const ref: Reference = {
      fromScope: 'scope:f',
      toDef: 'def:Logger.log',
      atRange: range(20, 4, 20, 8),
      kind: 'call',
      confidence: 0.75,
      evidence: [],
    };

    const graph = createKnowledgeGraph();
    emitReferencesToGraph({
      graph,
      scopes: indexes,
      referenceIndex: buildRefIndex('scope:f', [ref]),
    });

    expect(graph.relationships[0]!.sourceId).toBe('def:User.save');
  });

  it('walks up to the parent Class if the immediate scope has no Function def', () => {
    const classDef = def('def:User', 'Class');
    const targetFn = def('def:Logger.log', 'Method');
    const mod = scope('scope:m', null, 'Module', [], range(1, 0, 100, 0));
    // Class scope owns the Class def but no Function/Method; fallback
    // walks into the Class's owned defs.
    const classScope = scope('scope:c', 'scope:m', 'Class', [classDef], range(5, 0, 50, 0));
    const indexes = makeIndexes([mod, classScope], [classDef, targetFn]);

    const ref: Reference = {
      fromScope: 'scope:c',
      toDef: 'def:Logger.log',
      atRange: range(7, 0, 7, 4),
      kind: 'call',
      confidence: 0.55,
      evidence: [],
    };

    const graph = createKnowledgeGraph();
    emitReferencesToGraph({
      graph,
      scopes: indexes,
      referenceIndex: buildRefIndex('scope:c', [ref]),
    });

    // No Function ancestor — falls back to the first owned def: the class itself.
    expect(graph.relationships[0]!.sourceId).toBe('def:User');
  });

  it('increments skippedNoCaller when no ancestor has any owned defs', () => {
    // Module scope is empty; the lone child scope references something
    // but neither it nor its ancestors own anything.
    const target = def('def:someClass', 'Class');
    const mod = scope('scope:m', null, 'Module', [], range(1, 0, 100, 0));
    const child = scope('scope:c', 'scope:m', 'Function', [], range(5, 0, 10, 0));
    const indexes = makeIndexes([mod, child], [target]);

    const ref: Reference = {
      fromScope: 'scope:c',
      toDef: 'def:someClass',
      atRange: range(7, 0, 7, 4),
      kind: 'type-reference',
      confidence: 0.3,
      evidence: [],
    };

    const graph = createKnowledgeGraph();
    const stats = emitReferencesToGraph({
      graph,
      scopes: indexes,
      referenceIndex: buildRefIndex('scope:c', [ref]),
    });

    expect(stats.edgesEmitted).toBe(0);
    expect(stats.skippedNoCaller).toBe(1);
    expect(graph.relationships).toHaveLength(0);
  });
});

// ─── Missing target ──────────────────────────────────────────────────────

describe('missing target', () => {
  it('skips references whose toDef is not in the DefIndex', () => {
    const callerFn = def('def:caller', 'Function');
    const mod = scope('scope:m', null, 'Module', [callerFn]);
    const indexes = makeIndexes([mod], [callerFn]); // target def missing

    const ref: Reference = {
      fromScope: 'scope:m',
      toDef: 'def:ghost',
      atRange: range(5, 0, 5, 4),
      kind: 'call',
      confidence: 0.3,
      evidence: [],
    };
    const graph = createKnowledgeGraph();
    const stats = emitReferencesToGraph({
      graph,
      scopes: indexes,
      referenceIndex: buildRefIndex('scope:m', [ref]),
    });
    expect(stats.edgesEmitted).toBe(0);
    expect(stats.skippedMissingTarget).toBe(1);
    expect(graph.relationships).toHaveLength(0);
  });
});

// ─── Scope-graph emission (INGESTION_EMIT_SCOPES) ─────────────────────────

describe('scope-graph emission', () => {
  it('stays off by default — no scope nodes emitted', () => {
    const callerFn = def('def:caller', 'Function');
    const targetFn = def('def:target', 'Method');
    const mod = scope('scope:m', null, 'Module', [callerFn, targetFn]);
    const indexes = makeIndexes([mod], [callerFn, targetFn]);

    const ref: Reference = {
      fromScope: 'scope:m',
      toDef: 'def:target',
      atRange: range(5, 0, 5, 4),
      kind: 'call',
      confidence: 0.5,
      evidence: [],
    };
    const graph = createKnowledgeGraph();
    const stats = emitReferencesToGraph({
      graph,
      scopes: indexes,
      referenceIndex: buildRefIndex('scope:m', [ref]),
    });
    expect(stats.scopeNodesEmitted).toBe(0);
    expect(stats.scopeEdgesEmitted).toBe(0);
    // No scope nodes in the graph either.
    expect(graph.nodes.filter((n) => n.id.startsWith('scope:')).length).toBe(0);
  });

  it('emits Scope nodes + CONTAINS + DEFINES when INGESTION_EMIT_SCOPES=1', () => {
    process.env['INGESTION_EMIT_SCOPES'] = '1';
    const fn = def('def:fn', 'Function');
    const childScope = scope('scope:f', 'scope:m', 'Function', [fn], range(5, 0, 10, 0));
    const mod = scope('scope:m', null, 'Module', [], range(1, 0, 100, 0));
    const indexes = makeIndexes([mod, childScope], [fn]);

    const graph = createKnowledgeGraph();
    const stats = emitReferencesToGraph({
      graph,
      scopes: indexes,
      referenceIndex: buildRefIndex('scope:f', []),
    });

    expect(stats.scopeNodesEmitted).toBe(2); // module + function scope
    // 1 CONTAINS (module→function) + 1 DEFINES (function→fn def) = 2
    expect(stats.scopeEdgesEmitted).toBe(2);
    const containsEdge = graph.relationships.find((e) => e.type === 'CONTAINS');
    const definesEdge = graph.relationships.find((e) => e.type === 'DEFINES');
    expect(containsEdge).toBeDefined();
    expect(containsEdge!.sourceId).toBe('scope:m');
    expect(containsEdge!.targetId).toBe('scope:f');
    expect(definesEdge).toBeDefined();
    expect(definesEdge!.targetId).toBe('def:fn');
  });

  it("treats 'true', 'yes' (case-insensitive) as enabled; anything else as disabled", () => {
    const fn = def('def:fn', 'Function');
    const mod = scope('scope:m', null, 'Module', [fn]);
    const indexes = makeIndexes([mod], [fn]);

    for (const value of ['true', 'TRUE', 'yes', '1']) {
      process.env['INGESTION_EMIT_SCOPES'] = value;
      const g = createKnowledgeGraph();
      const stats = emitReferencesToGraph({
        graph: g,
        scopes: indexes,
        referenceIndex: buildRefIndex('scope:m', []),
      });
      expect(stats.scopeNodesEmitted).toBeGreaterThan(0);
    }
    for (const value of ['false', '0', '', 'off', 'tru']) {
      process.env['INGESTION_EMIT_SCOPES'] = value;
      const g = createKnowledgeGraph();
      const stats = emitReferencesToGraph({
        graph: g,
        scopes: indexes,
        referenceIndex: buildRefIndex('scope:m', []),
      });
      expect(stats.scopeNodesEmitted).toBe(0);
    }
  });

  it('emitScopeGraph can be called directly (bypasses env flag)', () => {
    const fn = def('def:fn', 'Function');
    const mod = scope('scope:m', null, 'Module', [fn]);
    const indexes = makeIndexes([mod], [fn]);

    const graph = createKnowledgeGraph();
    const stats = emitScopeGraph({ graph, scopes: indexes });
    expect(stats.scopeNodesEmitted).toBe(1);
    expect(stats.scopeEdgesEmitted).toBe(1); // only the DEFINES edge; no parent scope
  });
});

// ─── Empty input ──────────────────────────────────────────────────────────

describe('empty input', () => {
  it('returns zeroed stats and mutates nothing when ReferenceIndex is empty', () => {
    const mod = scope('scope:m', null, 'Module', []);
    const indexes = makeIndexes([mod], []);
    const graph = createKnowledgeGraph();
    const stats = emitReferencesToGraph({
      graph,
      scopes: indexes,
      referenceIndex: { bySourceScope: new Map(), byTargetDef: new Map() },
    });
    expect(stats).toEqual({
      edgesEmitted: 0,
      skippedNoCaller: 0,
      skippedMissingTarget: 0,
      scopeNodesEmitted: 0,
      scopeEdgesEmitted: 0,
    });
    expect(graph.nodes).toHaveLength(0);
    expect(graph.relationships).toHaveLength(0);
  });
});

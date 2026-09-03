/**
 * The CALLS edge a construction site emits must be distinguishable from the
 * one an invocation emits (PR #1432 review, item 2).
 *
 * A struct literal (`SpawnRequest{ .a = x }` in Zig, `Foo { a }` in Rust,
 * `Foo{}` in Go) and a `new Foo()` are tagged `@reference.call.constructor`
 * by their language queries and resolve to the type (or its constructor) as
 * an ordinary `kind: 'call'` reference. Both land in the graph as `CALLS`,
 * and relationships carry no free-form properties (adding one moves
 * SCHEMA_FINGERPRINT), so the call form rides in `reason` — the same channel
 * the IMPLEMENTS `-pointer` receiver form uses.
 *
 * Why the assertions are exact strings: a consumer that filters by the
 * exact `scope-resolution: call` is promised invocations only, and one that
 * matches the prefix is promised every call. Loosening either side would
 * silently break one of the two contracts.
 */

import { describe, it, expect } from 'vitest';
import {
  buildDefIndex,
  buildMethodDispatchIndex,
  buildModuleScopeIndex,
  buildQualifiedNameIndex,
  buildScopeTree,
  type NodeLabel,
  type Range,
  type Reference,
  type Scope,
  type ScopeId,
  type SymbolDefinition,
} from 'gitnexus-shared';
import { createKnowledgeGraph } from '../../../src/core/graph/graph.js';
import type { ScopeResolutionIndexes } from '../../../src/core/ingestion/model/scope-resolution-indexes.js';
import { buildGraphNodeLookup } from '../../../src/core/ingestion/scope-resolution/graph-bridge/node-lookup.js';
import {
  emitReferencesViaLookup,
  referenceEdgeReason,
} from '../../../src/core/ingestion/scope-resolution/graph-bridge/references-to-edges.js';
import { constructionSiteReason } from '../../../src/core/ingestion/scope-resolution/passes/free-call-fallback.js';

const FILE = 'x.zig';

const range = (sl: number, sc: number): Range => ({
  startLine: sl,
  startCol: sc,
  endLine: sl,
  endCol: sc + 4,
});

const def = (nodeId: string, type: SymbolDefinition['type'], qname: string): SymbolDefinition => ({
  nodeId,
  filePath: FILE,
  type,
  qualifiedName: qname,
});

function moduleScope(ownedDefs: readonly SymbolDefinition[]): Scope {
  return {
    id: 'scope:m',
    parent: null,
    kind: 'Module',
    range: { startLine: 1, startCol: 0, endLine: 100, endCol: 0 },
    filePath: FILE,
    bindings: new Map(),
    ownedDefs,
    imports: [],
    typeBindings: new Map(),
  };
}

function makeIndexes(scope: Scope, allDefs: readonly SymbolDefinition[]): ScopeResolutionIndexes {
  return {
    scopeTree: buildScopeTree([scope]),
    defs: buildDefIndex([...allDefs]),
    qualifiedNames: buildQualifiedNameIndex([...allDefs]),
    moduleScopes: buildModuleScopeIndex([{ filePath: FILE, moduleScopeId: scope.id }]),
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

describe('referenceEdgeReason', () => {
  it('marks only the constructor call form; every other kind keeps the plain reason', () => {
    expect(referenceEdgeReason({ kind: 'call', callForm: 'constructor' }, true)).toBe(
      'scope-resolution: call (constructor)',
    );
    expect(referenceEdgeReason({ kind: 'call', callForm: 'free' }, true)).toBe(
      'scope-resolution: call',
    );
    expect(referenceEdgeReason({ kind: 'call', callForm: 'member' }, true)).toBe(
      'scope-resolution: call',
    );
    // A `Reference` minted before the field existed (or by a path that does
    // not set it) is emitted exactly as before.
    expect(referenceEdgeReason({ kind: 'call' }, true)).toBe('scope-resolution: call');
    expect(referenceEdgeReason({ kind: 'read' }, true)).toBe('scope-resolution: read');
    expect(referenceEdgeReason({ kind: 'type-reference' }, true)).toBe(
      'scope-resolution: type-reference',
    );
  });

  it('is opt-in: a provider that did not set `markConstructionSites` gets the pinned string', () => {
    // The unsuffixed reasons are a contract asserted verbatim by the other
    // language suites; the marker must not leak into them by default.
    expect(referenceEdgeReason({ kind: 'call', callForm: 'constructor' }, undefined)).toBe(
      'scope-resolution: call',
    );
    expect(referenceEdgeReason({ kind: 'call', callForm: 'constructor' }, false)).toBe(
      'scope-resolution: call',
    );
  });

  it('keeps the plain `scope-resolution: call` as a prefix of the marked form', () => {
    // The compatibility promise: prefix matchers keep seeing construction
    // sites as calls.
    expect(
      referenceEdgeReason({ kind: 'call', callForm: 'constructor' }, true).startsWith(
        'scope-resolution: call',
      ),
    ).toBe(true);
  });
});

describe('constructionSiteReason (free-call fallback vocabulary)', () => {
  it('suffixes the legacy `local-call` / `import-resolved` only for an opted-in constructor site', () => {
    expect(constructionSiteReason('local-call', { callForm: 'constructor' }, true)).toBe(
      'local-call (constructor)',
    );
    expect(constructionSiteReason('import-resolved', { callForm: 'constructor' }, true)).toBe(
      'import-resolved (constructor)',
    );
    expect(constructionSiteReason('local-call', { callForm: 'free' }, true)).toBe('local-call');
    expect(constructionSiteReason('local-call', { callForm: 'constructor' }, undefined)).toBe(
      'local-call',
    );
  });
});

describe('emitReferencesViaLookup — construction site vs invocation', () => {
  it('emits both as CALLS, and only the construction site carries the constructor marker', () => {
    // `fn get_next_spawn() SpawnRequest { helper(); return SpawnRequest{ .a = 1 }; }`
    const caller = def('def:get_next_spawn', 'Function', 'get_next_spawn');
    const helper = def('def:helper', 'Function', 'helper');
    const spawnRequest = def('def:SpawnRequest', 'Struct', 'SpawnRequest');
    const allDefs = [caller, helper, spawnRequest];
    const indexes = makeIndexes(moduleScope(allDefs), allDefs);

    const graph = createKnowledgeGraph();
    graph.addNode({
      id: 'fn:get_next_spawn',
      label: 'Function' as NodeLabel,
      properties: { name: 'get_next_spawn', filePath: FILE, qualifiedName: 'get_next_spawn' },
    });
    graph.addNode({
      id: 'fn:helper',
      label: 'Function' as NodeLabel,
      properties: { name: 'helper', filePath: FILE, qualifiedName: 'helper' },
    });
    graph.addNode({
      id: 'struct:SpawnRequest',
      label: 'Struct' as NodeLabel,
      properties: { name: 'SpawnRequest', filePath: FILE, qualifiedName: 'SpawnRequest' },
    });

    const invocation: Reference = {
      fromScope: 'scope:m',
      toDef: 'def:helper',
      atRange: range(2, 4),
      kind: 'call',
      callForm: 'free',
      confidence: 0.9,
      evidence: [],
    };
    const construction: Reference = {
      fromScope: 'scope:m',
      toDef: 'def:SpawnRequest',
      atRange: range(3, 11),
      kind: 'call',
      callForm: 'constructor',
      confidence: 0.9,
      evidence: [],
    };
    const referenceIndex = {
      bySourceScope: new Map<ScopeId, readonly Reference[]>([
        ['scope:m', [invocation, construction]],
      ]),
    };

    const result = emitReferencesViaLookup(
      graph,
      indexes,
      referenceIndex,
      buildGraphNodeLookup(graph),
      undefined,
      undefined,
      undefined,
      { markConstructionSites: true },
    );

    expect(result).toEqual({ emitted: 2, skipped: 0 });
    const edges = graph.relationships.map((r) => ({
      type: r.type,
      targetId: r.targetId,
      reason: r.reason,
    }));
    expect(edges).toEqual([
      { type: 'CALLS', targetId: 'fn:helper', reason: 'scope-resolution: call' },
      {
        type: 'CALLS',
        targetId: 'struct:SpawnRequest',
        reason: 'scope-resolution: call (constructor)',
      },
    ]);
  });
});

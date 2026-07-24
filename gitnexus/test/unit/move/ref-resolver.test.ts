// gitnexus/test/unit/move/ref-resolver.test.ts
import { describe, it, expect } from 'vitest';
import { createKnowledgeGraph } from '../../../src/core/graph/graph.js';
import { resolveRefs, buildLocalNameIndex } from '../../../src/core/move/move-linker.js';
import { ExternalMoveSymbols } from '../../../src/core/move/move-linker.js';
import type { PendingRef, DroppedRef } from '../../../src/core/move/refs.js';
import { MOVE_EDGE_REASON } from '../../../src/core/move/constants.js';

function fnNode(graph: ReturnType<typeof createKnowledgeGraph>, id: string) {
  graph.addNode({
    id,
    label: 'Function',
    properties: {
      name: id,
      filePath: 'a.move',
      language: 'move',
      qualifiedName: id,
      usedTypes: [],
    },
  });
}
function structNode(graph: ReturnType<typeof createKnowledgeGraph>, id: string, qn: string) {
  graph.addNode({
    id,
    label: 'Struct',
    properties: { name: qn, filePath: 'a.move', language: 'move', qualifiedName: qn },
  });
}

describe('resolveRefs', () => {
  it('resolves a type ref to a mapped struct and records usedTypes', () => {
    const graph = createKnowledgeGraph();
    fnNode(graph, 'Function:a.move:0xa::m::f');
    structNode(graph, 'Struct:a.move:0xa::m::S', '0xa::m::S');
    const structNodeMap = new Map([['0xa::m::S', 'Struct:a.move:0xa::m::S']]);
    const drops: DroppedRef[] = [];
    const external = new ExternalMoveSymbols(graph, new Map([['0xa::m', 'Module:a.move:0xa::m']]));
    const refs: PendingRef[] = [
      {
        kind: 'type',
        knownNodeId: 'Function:a.move:0xa::m::f',
        target: '0xa::m::S',
        moduleQualified: '0xa::m',
        edgeType: 'USES_TYPE',
        reason: MOVE_EDGE_REASON.fnParamType,
      },
    ];
    resolveRefs(
      graph,
      refs,
      {
        structNodeMap,
        structIdsByLocalName: buildLocalNameIndex(structNodeMap),
        moduleFileMap: new Map(),
        functionNodeMap: new Map(),
      },
      external,
      drops,
    );
    const edges = [...graph.iterRelationshipsByType('USES_TYPE')];
    expect(edges).toHaveLength(1);
    expect(graph.getNode('Function:a.move:0xa::m::f')!.properties.usedTypes).toContain('0xa::m::S');
    expect(drops).toHaveLength(0);
  });

  it('drops an ambiguous local-name struct ref without externalizing', () => {
    const graph = createKnowledgeGraph();
    fnNode(graph, 'Function:a.move:0xa::m::f');
    structNode(graph, 'Struct:a.move:0xa::m::S', '0xa::m::S');
    structNode(graph, 'Struct:b.move:0xb::n::S', '0xb::n::S');
    const structNodeMap = new Map([
      ['0xa::m::S', 'Struct:a.move:0xa::m::S'],
      ['0xb::n::S', 'Struct:b.move:0xb::n::S'],
    ]);
    const drops: DroppedRef[] = [];
    const external = new ExternalMoveSymbols(graph, new Map());
    const refs: PendingRef[] = [
      {
        kind: 'resource',
        knownNodeId: 'Function:a.move:0xa::m::f',
        target: 'S',
        moduleQualified: '0xc::other',
        edgeType: 'READS_RESOURCE',
        reason: MOVE_EDGE_REASON.readsResource,
      },
    ];
    resolveRefs(
      graph,
      refs,
      {
        structNodeMap,
        structIdsByLocalName: buildLocalNameIndex(structNodeMap),
        moduleFileMap: new Map(),
        functionNodeMap: new Map(),
      },
      external,
      drops,
    );
    expect([...graph.iterRelationshipsByType('READS_RESOURCE')]).toHaveLength(0);
    expect(drops).toEqual([
      { kind: 'resource', sourceId: 'Function:a.move:0xa::m::f', target: 'S' },
    ]);
  });

  it('externalizes an unresolved qualified type ref', () => {
    const graph = createKnowledgeGraph();
    fnNode(graph, 'Function:a.move:0xa::m::f');
    const drops: DroppedRef[] = [];
    const external = new ExternalMoveSymbols(graph, new Map([['0xa::m', 'Module:a.move:0xa::m']]));
    const refs: PendingRef[] = [
      {
        kind: 'type',
        knownNodeId: 'Function:a.move:0xa::m::f',
        target: '0x1::coin::Coin',
        moduleQualified: '0xa::m',
        edgeType: 'USES_TYPE',
        reason: MOVE_EDGE_REASON.fnParamType,
      },
    ];
    resolveRefs(
      graph,
      refs,
      {
        structNodeMap: new Map(),
        structIdsByLocalName: new Map(),
        moduleFileMap: new Map(),
        functionNodeMap: new Map(),
      },
      external,
      drops,
    );
    expect([...graph.iterRelationshipsByType('USES_TYPE')]).toHaveLength(1);
    expect(drops).toHaveLength(0);
    expect(graph.getNode('Type::<external>:0x1::coin::Coin')).toBeTruthy();
  });

  it('resolves lambda-host with the resolved host as the edge source (known-target)', () => {
    const graph = createKnowledgeGraph();
    fnNode(graph, 'Function:a.move:0xa::m::host');
    fnNode(graph, 'Function:a.move:0xa::m::__lambda__0__host');
    const functionNodeMap = new Map([['0xa::m::host', 'Function:a.move:0xa::m::host']]);
    const drops: DroppedRef[] = [];
    const external = new ExternalMoveSymbols(graph, new Map());
    const refs: PendingRef[] = [
      {
        kind: 'lambda-host',
        knownNodeId: 'Function:a.move:0xa::m::__lambda__0__host',
        target: '0xa::m::host',
        moduleQualified: '',
        edgeType: 'CALLS',
        reason: MOVE_EDGE_REASON.lambdaHost,
      },
    ];
    resolveRefs(
      graph,
      refs,
      {
        structNodeMap: new Map(),
        structIdsByLocalName: new Map(),
        moduleFileMap: new Map(),
        functionNodeMap,
      },
      external,
      drops,
    );
    const calls = [...graph.iterRelationshipsByType('CALLS')];
    expect(calls).toHaveLength(1);
    expect(calls[0].sourceId).toBe('Function:a.move:0xa::m::host');
    expect(calls[0].targetId).toBe('Function:a.move:0xa::m::__lambda__0__host');
    // Behavior-preservation: lambda-host CALLS keeps the legacy 0.9 confidence
    // (resource/type/friend use 1.0).
    expect(calls[0].confidence).toBe(0.9);
  });
});

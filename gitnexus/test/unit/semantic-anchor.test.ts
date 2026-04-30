import { describe, expect, it } from 'vitest';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import {
  applySemanticAnchors,
  createSemanticAnchor,
} from '../../src/core/ingestion/semantic-anchor.js';

describe('semantic anchors', () => {
  it('creates deterministic heuristic anchors for symbols', () => {
    const anchor = createSemanticAnchor(
      {
        id: 'Function:src/auth.ts:checkPermissions',
        label: 'Function',
        properties: {
          name: 'checkPermissions',
          filePath: 'src/auth.ts',
          startLine: 1,
          endLine: 3,
          language: 'typescript',
          isExported: true,
        },
      },
      { incoming: 2, outgoing: 1, byType: { CALLS: 1 } },
      '2026-04-30T12:00:00.000Z',
    );

    expect(anchor).toMatchObject({
      summary:
        'Function checkPermissions implements behavior in auth.ts; 2 incoming, 1 outgoing, 1 call edge.',
      purpose:
        'Use this behavior anchor to trace callers, callees, and process participation before editing.',
      tags: ['exported', 'function', 'typescript'],
      anchorModel: 'heuristic-v1',
      anchorVersion: 1,
      anchorGeneratedAt: '2026-04-30T12:00:00.000Z',
    });
    expect(anchor?.anchorHash).toMatch(/^[0-9a-f]{8}$/);
  });

  it('applies anchors to graph nodes without overwriting existing descriptions', () => {
    const graph = createKnowledgeGraph();
    graph.addNode({
      id: 'Function:src/api.ts:updateUser',
      label: 'Function',
      properties: { name: 'updateUser', filePath: 'src/api.ts' },
    });
    graph.addNode({
      id: 'Tool:gitnexus_query',
      label: 'Tool',
      properties: {
        name: 'gitnexus_query',
        filePath: 'src/tools.ts',
        description: 'Existing tool description',
      },
    });
    graph.addRelationship({
      id: 'call:updateUser->gitnexus_query',
      sourceId: 'Function:src/api.ts:updateUser',
      targetId: 'Tool:gitnexus_query',
      type: 'CALLS',
      confidence: 1,
      reason: 'test',
    });

    const result = applySemanticAnchors(graph, '2026-04-30T12:00:00.000Z');
    const fn = graph.getNode('Function:src/api.ts:updateUser');
    const tool = graph.getNode('Tool:gitnexus_query');

    expect(result.anchoredNodes).toBe(2);
    expect(fn?.properties.description).toContain('Function updateUser implements behavior');
    expect(fn?.properties.summary).toBe(fn?.properties.description);
    expect(fn?.properties.tags).toEqual(['function']);
    expect(tool?.properties.description).toBe('Existing tool description');
    expect(tool?.properties.summary).toContain('Tool gitnexus_query');
  });
});

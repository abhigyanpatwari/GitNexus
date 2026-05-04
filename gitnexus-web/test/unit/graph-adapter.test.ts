import { describe, expect, it } from 'vitest';
import { createKnowledgeGraph } from '../../src/core/graph/graph';
import { knowledgeGraphToGraphology } from '../../src/lib/graph-adapter';
import { createFileNode, createFunctionNode } from '../fixtures/graph';

describe('knowledgeGraphToGraphology', () => {
  it('preserves parallel relationships between the same source and target', () => {
    const graph = createKnowledgeGraph();
    const file = createFileNode('app.ts', 'src/app.ts');
    const fn = createFunctionNode('main', 'src/app.ts', 1);

    graph.addNode(file);
    graph.addNode(fn);
    graph.addRelationship({
      id: 'defines-main',
      sourceId: file.id,
      targetId: fn.id,
      type: 'DEFINES',
      confidence: 1,
      reason: 'file owns symbol',
    });
    graph.addRelationship({
      id: 'decorates-main',
      sourceId: file.id,
      targetId: fn.id,
      type: 'DECORATES',
      confidence: 0.8,
      reason: 'annotation metadata',
    });

    const renderGraph = knowledgeGraphToGraphology(graph);
    const relationTypes: string[] = [];
    renderGraph.forEachEdge((_edgeId, attributes) => {
      relationTypes.push(attributes.relationType);
    });

    expect(relationTypes.sort()).toEqual(['DECORATES', 'DEFINES']);
  });
});

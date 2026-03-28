import { describe, expect, it } from 'vitest';
import { createKnowledgeGraph } from '../../src/core/graph/graph';
import {
  createFileNode,
  createFunctionNode,
  createCallsRelationship,
  createContainsRelationship,
} from '../fixtures/graph';

describe('createKnowledgeGraph', () => {
  it('starts empty', () => {
    const graph = createKnowledgeGraph();
    expect(graph.nodeCount).toBe(0);
    expect(graph.relationshipCount).toBe(0);
    expect(graph.nodes).toEqual([]);
    expect(graph.relationships).toEqual([]);
  });

  it('adds nodes', () => {
    const graph = createKnowledgeGraph();
    const node = createFileNode('index.ts', 'src/index.ts');
    graph.addNode(node);

    expect(graph.nodeCount).toBe(1);
    expect(graph.nodes[0].id).toBe('File:src/index.ts');
  });

  it('deduplicates nodes by id', () => {
    const graph = createKnowledgeGraph();
    const node = createFileNode('index.ts', 'src/index.ts');
    const duplicateNode = createFileNode('index.ts', 'src/index.ts');
    graph.addNode(node);
    graph.addNode(duplicateNode);

    expect(graph.nodeCount).toBe(1);
  });

  it('adds relationships', () => {
    const graph = createKnowledgeGraph();
    const rel = createCallsRelationship('fn:a', 'fn:b');
    graph.addRelationship(rel);

    expect(graph.relationshipCount).toBe(1);
    expect(graph.relationships[0].type).toBe('CALLS');
  });

  it('deduplicates relationships by id', () => {
    const graph = createKnowledgeGraph();
    const rel = createCallsRelationship('fn:a', 'fn:b');
    const duplicateRel = createCallsRelationship('fn:a', 'fn:b');
    graph.addRelationship(rel);
    graph.addRelationship(duplicateRel);

    expect(graph.relationshipCount).toBe(1);
  });

  it('builds a multi-node graph', () => {
    const graph = createKnowledgeGraph();
    const file = createFileNode('app.ts', 'src/app.ts');
    const fn1 = createFunctionNode('main', 'src/app.ts', 1);
    const fn2 = createFunctionNode('helper', 'src/app.ts', 20);

    graph.addNode(file);
    graph.addNode(fn1);
    graph.addNode(fn2);
    graph.addRelationship(createContainsRelationship(file.id, fn1.id));
    graph.addRelationship(createContainsRelationship(file.id, fn2.id));
    graph.addRelationship(createCallsRelationship(fn1.id, fn2.id));

    expect(graph.nodeCount).toBe(3);
    expect(graph.relationshipCount).toBe(3);
  });
});

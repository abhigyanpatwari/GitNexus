import { describe, expect, it } from 'vitest';
import { createKnowledgeGraph } from '../../src/core/graph/graph';
import { describeGraphDiff, diffKnowledgeGraphs } from '../../src/lib/graph-diff';
import {
  createCallsRelationship,
  createContainsRelationship,
  createFileNode,
  createFunctionNode,
} from '../fixtures/graph';

describe('diffKnowledgeGraphs', () => {
  it('reports no changes for equivalent graphs regardless of property order', () => {
    const before = createKnowledgeGraph();
    const after = createKnowledgeGraph();

    before.addNode({
      id: 'File:src/app.ts',
      label: 'File',
      properties: { name: 'app.ts', filePath: 'src/app.ts' },
    });
    after.addNode({
      id: 'File:src/app.ts',
      label: 'File',
      properties: { filePath: 'src/app.ts', name: 'app.ts' },
    });

    const diff = diffKnowledgeGraphs(before, after);

    expect(diff.hasChanges).toBe(false);
    expect(diff.summary).toEqual({
      addedNodes: 0,
      removedNodes: 0,
      changedNodes: 0,
      addedRelationships: 0,
      removedRelationships: 0,
      changedRelationships: 0,
    });
  });

  it('tracks added, removed, and changed nodes', () => {
    const before = createKnowledgeGraph();
    const after = createKnowledgeGraph();
    const file = createFileNode('app.ts', 'src/app.ts');
    const oldFn = createFunctionNode('oldFn', 'src/app.ts', 1);
    const changedFn = createFunctionNode('changedFn', 'src/app.ts', 20);
    const newFn = createFunctionNode('newFn', 'src/app.ts', 40);

    before.addNode(file);
    before.addNode(oldFn);
    before.addNode(changedFn);
    after.addNode(file);
    after.addNode({
      ...changedFn,
      properties: { ...changedFn.properties, endLine: 80 },
    });
    after.addNode(newFn);

    const diff = diffKnowledgeGraphs(before, after);

    expect(diff.addedNodeIds).toEqual([newFn.id]);
    expect(diff.removedNodeIds).toEqual([oldFn.id]);
    expect(diff.changedNodeIds).toEqual([changedFn.id]);
    expect(describeGraphDiff(diff)).toContain('+1 nodes');
  });

  it('tracks relationship structural and confidence changes', () => {
    const before = createKnowledgeGraph();
    const after = createKnowledgeGraph();
    const file = createFileNode('app.ts', 'src/app.ts');
    const fnA = createFunctionNode('a', 'src/app.ts', 1);
    const fnB = createFunctionNode('b', 'src/app.ts', 20);
    const fnC = createFunctionNode('c', 'src/app.ts', 40);
    const contains = createContainsRelationship(file.id, fnA.id);
    const oldCall = createCallsRelationship(fnA.id, fnB.id);
    const changedCall = { ...createCallsRelationship(fnB.id, fnC.id), confidence: 0.25 };
    const newCall = createCallsRelationship(fnA.id, fnC.id);

    [file, fnA, fnB, fnC].forEach((node) => {
      before.addNode(node);
      after.addNode(node);
    });
    before.addRelationship(contains);
    before.addRelationship(oldCall);
    before.addRelationship({ ...changedCall, confidence: 0.9 });
    after.addRelationship(contains);
    after.addRelationship(changedCall);
    after.addRelationship(newCall);

    const diff = diffKnowledgeGraphs(before, after);

    expect(diff.addedRelationshipIds).toEqual([newCall.id]);
    expect(diff.removedRelationshipIds).toEqual([oldCall.id]);
    expect(diff.changedRelationshipIds).toEqual([changedCall.id]);
    expect(diff.summary.changedRelationships).toBe(1);
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GraphNode, GraphRelationship, NodeLabel, RelationshipType } from 'gitnexus-shared';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import {
  pruneLocalValueSymbols,
  shouldKeepLocalValueSymbols,
} from '../../src/core/ingestion/local-symbol-pruner.js';
import { pruneLocalSymbolsPhase } from '../../src/core/ingestion/pipeline-phases/prune-local-symbols.js';

const fileNode = (): GraphNode => ({
  id: 'file:src/app.ts',
  label: 'File',
  properties: {
    name: 'app.ts',
    filePath: 'src/app.ts',
  },
});

const node = (
  id: string,
  label: NodeLabel,
  properties: Partial<GraphNode['properties']> = {},
): GraphNode => ({
  id,
  label,
  properties: {
    name: id,
    filePath: 'src/app.ts',
    startLine: 1,
    endLine: 1,
    ...properties,
  },
});

const rel = (
  id: string,
  sourceId: string,
  targetId: string,
  type: RelationshipType = 'DEFINES',
): GraphRelationship => ({
  id,
  sourceId,
  targetId,
  type,
  confidence: 1,
  reason: 'test',
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('pruneLocalValueSymbols', () => {
  it.each(['Const', 'Variable', 'Static'] as const)(
    'prunes inert block-scope %s nodes after scope resolution',
    (label) => {
      const graph = createKnowledgeGraph();
      graph.addNode(fileNode());
      graph.addNode(node(`${label}:tmp`, label, { scope: 'block' }));
      graph.addRelationship(rel(`rel:${label}`, 'file:src/app.ts', `${label}:tmp`));

      const stats = pruneLocalValueSymbols(graph);

      expect(stats).toEqual({
        candidateNodes: 1,
        prunedNodes: 1,
        keptWithSemanticEdges: 0,
        skippedByEnv: false,
      });
      expect(graph.getNode(`${label}:tmp`)).toBeUndefined();
      expect(graph.relationshipCount).toBe(0);
    },
  );

  it.each(['module', 'file'] as const)('keeps %s-scope value symbols', (scope) => {
    const graph = createKnowledgeGraph();
    graph.addNode(fileNode());
    graph.addNode(node(`Const:${scope}`, 'Const', { scope }));
    graph.addRelationship(rel(`rel:${scope}`, 'file:src/app.ts', `Const:${scope}`));

    const stats = pruneLocalValueSymbols(graph);

    expect(stats.prunedNodes).toBe(0);
    expect(stats.candidateNodes).toBe(0);
    expect(graph.getNode(`Const:${scope}`)).toBeDefined();
    expect(graph.relationshipCount).toBe(1);
  });

  it('keeps block-scope value symbols with semantic edges', () => {
    const graph = createKnowledgeGraph();
    graph.addNode(fileNode());
    graph.addNode(node('Function:run', 'Function'));
    graph.addNode(node('Const:client', 'Const', { scope: 'block' }));
    graph.addRelationship(rel('rel:def', 'file:src/app.ts', 'Const:client'));
    graph.addRelationship(rel('rel:access', 'Function:run', 'Const:client', 'ACCESSES'));

    const stats = pruneLocalValueSymbols(graph);

    expect(stats).toMatchObject({
      candidateNodes: 1,
      prunedNodes: 0,
      keptWithSemanticEdges: 1,
      skippedByEnv: false,
    });
    expect(graph.getNode('Const:client')).toBeDefined();
    expect(graph.relationshipCount).toBe(2);
  });

  it('keeps block-scope value symbols that are the source of an outgoing edge', () => {
    const graph = createKnowledgeGraph();
    graph.addNode(fileNode());
    graph.addNode(node('Element:thing', 'CodeElement'));
    graph.addNode(node('Const:config', 'Const', { scope: 'block' }));
    graph.addRelationship(rel('rel:file-def', 'file:src/app.ts', 'Const:config'));
    // Candidate is the SOURCE of an outgoing DEFINES edge — any outgoing edge is
    // semantic, so the node must be kept (guards the source-branch simplification).
    graph.addRelationship(rel('rel:out', 'Const:config', 'Element:thing', 'DEFINES'));

    const stats = pruneLocalValueSymbols(graph);

    expect(stats.prunedNodes).toBe(0);
    expect(stats.keptWithSemanticEdges).toBe(1);
    expect(graph.getNode('Const:config')).toBeDefined();
  });

  it('does not treat value symbols without a scope property as candidates', () => {
    const graph = createKnowledgeGraph();
    graph.addNode(fileNode());
    graph.addNode(node('Const:noScope', 'Const'));
    graph.addRelationship(rel('rel:def', 'file:src/app.ts', 'Const:noScope'));

    const stats = pruneLocalValueSymbols(graph);

    expect(stats.candidateNodes).toBe(0);
    expect(stats.prunedNodes).toBe(0);
    expect(graph.getNode('Const:noScope')).toBeDefined();
  });

  it('prunes block-scope value symbols even when parser metadata marks them exported', () => {
    const graph = createKnowledgeGraph();
    graph.addNode(fileNode());
    graph.addNode(node('Const:tmp', 'Const', { scope: 'block', isExported: true }));
    graph.addRelationship(rel('rel:def', 'file:src/app.ts', 'Const:tmp'));

    const stats = pruneLocalValueSymbols(graph);

    expect(stats.prunedNodes).toBe(1);
    expect(graph.getNode('Const:tmp')).toBeUndefined();
  });

  it('keeps block-scope value symbols defined by explicit scope graph nodes', () => {
    const graph = createKnowledgeGraph();
    graph.addNode(fileNode());
    graph.addNode(node('Scope:function:run', 'CodeElement'));
    graph.addNode(node('Const:client', 'Const', { scope: 'block' }));
    graph.addRelationship(rel('rel:file-def', 'file:src/app.ts', 'Const:client'));
    graph.addRelationship(rel('rel:scope-def', 'Scope:function:run', 'Const:client'));

    const stats = pruneLocalValueSymbols(graph);

    expect(stats.prunedNodes).toBe(0);
    expect(stats.keptWithSemanticEdges).toBe(1);
    expect(graph.getNode('Const:client')).toBeDefined();
  });

  it('does not prune function-like local symbols', () => {
    const graph = createKnowledgeGraph();
    graph.addNode(fileNode());
    graph.addNode(node('Function:inner', 'Function', { scope: 'block' }));
    graph.addRelationship(rel('rel:function', 'file:src/app.ts', 'Function:inner'));

    const stats = pruneLocalValueSymbols(graph);

    expect(stats.candidateNodes).toBe(0);
    expect(graph.getNode('Function:inner')).toBeDefined();
  });

  it('can be disabled with GITNEXUS_KEEP_LOCAL_VALUE_SYMBOLS', () => {
    vi.stubEnv('GITNEXUS_KEEP_LOCAL_VALUE_SYMBOLS', '1');

    const graph = createKnowledgeGraph();
    graph.addNode(fileNode());
    graph.addNode(node('Const:tmp', 'Const', { scope: 'block' }));
    graph.addRelationship(rel('rel:def', 'file:src/app.ts', 'Const:tmp'));

    const stats = pruneLocalValueSymbols(graph);

    expect(shouldKeepLocalValueSymbols()).toBe(true);
    expect(stats.skippedByEnv).toBe(true);
    expect(stats.prunedNodes).toBe(0);
    expect(graph.getNode('Const:tmp')).toBeDefined();
  });
});

describe('pruneLocalSymbolsPhase', () => {
  it('runs after scope resolution and returns prune stats', async () => {
    const graph = createKnowledgeGraph();
    graph.addNode(fileNode());
    graph.addNode(node('Const:tmp', 'Const', { scope: 'block' }));
    graph.addRelationship(rel('rel:def', 'file:src/app.ts', 'Const:tmp'));

    const stats = await pruneLocalSymbolsPhase.execute(
      {
        repoPath: '/repo',
        graph,
        onProgress: () => {},
        pipelineStart: Date.now(),
      },
      new Map(),
    );

    expect(pruneLocalSymbolsPhase.name).toBe('pruneLocalSymbols');
    expect(pruneLocalSymbolsPhase.deps).toEqual(['scopeResolution']);
    expect(stats.prunedNodes).toBe(1);
    expect(graph.getNode('Const:tmp')).toBeUndefined();
  });

  it('honors the keepLocalValueSymbols option without reading process.env', async () => {
    const graph = createKnowledgeGraph();
    graph.addNode(fileNode());
    graph.addNode(node('Const:tmp', 'Const', { scope: 'block' }));
    graph.addRelationship(rel('rel:def', 'file:src/app.ts', 'Const:tmp'));

    const stats = await pruneLocalSymbolsPhase.execute(
      {
        repoPath: '/repo',
        graph,
        onProgress: () => {},
        pipelineStart: Date.now(),
        options: { keepLocalValueSymbols: true },
      },
      new Map(),
    );

    expect(stats.skippedByEnv).toBe(true);
    expect(stats.prunedNodes).toBe(0);
    expect(graph.getNode('Const:tmp')).toBeDefined();
  });
});

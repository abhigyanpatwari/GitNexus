import { describe, expect, it } from 'vitest';
import { createKnowledgeGraph } from '../../src/core/graph/graph';
import { formatNodeMarker, parseNodeMarker, stripNodeMarkers } from '../../src/lib/agent-tracking';
import { knowledgeGraphToGraphology } from '../../src/lib/graph-adapter';
import { createFileNode, createFunctionNode } from '../fixtures/graph';

describe('agent tracking node markers', () => {
  it('round-trips encoded graph node ids', () => {
    const ids = ['File:src/app.ts', 'Function:src/app.ts:main:1'];
    const marker = formatNodeMarker('HIGHLIGHT_NODES', ids);

    expect(marker).toBe(
      '[HIGHLIGHT_NODES:File%3Asrc%2Fapp.ts,Function%3Asrc%2Fapp.ts%3Amain%3A1]',
    );
    expect(parseNodeMarker(marker, 'HIGHLIGHT_NODES')).toEqual(ids);
  });

  it('deduplicates marker ids while preserving order', () => {
    const marker = formatNodeMarker('IMPACT', ['node:a', 'node:a', '', 'node:b']);

    expect(parseNodeMarker(marker, 'IMPACT')).toEqual(['node:a', 'node:b']);
  });

  it('strips tracking markers from display text', () => {
    const text = 'Result body\n[HIGHLIGHT_NODES:File%3Asrc%2Fapp.ts]\n[IMPACT:node%3Aa]';

    expect(stripNodeMarkers(text)).toBe('Result body');
  });
});

describe('agent graph lens', () => {
  it('scores cited and tool-result nodes for the graph adapter', () => {
    const graph = createKnowledgeGraph();
    const file = createFileNode('app.ts', 'src/app.ts');
    const fn = createFunctionNode('main', 'src/app.ts', 1);
    graph.addNode(file);
    graph.addNode(fn);

    const renderGraph = knowledgeGraphToGraphology(graph, undefined, {
      colorMode: 'agent',
      citationNodeIds: new Set([file.id]),
      toolNodeIds: new Set([fn.id]),
    });

    expect(renderGraph.getNodeAttribute(file.id, 'agentScore')).toBe(0.72);
    expect(renderGraph.getNodeAttribute(fn.id, 'agentScore')).toBe(1);
  });
});

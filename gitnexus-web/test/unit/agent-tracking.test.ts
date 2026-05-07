import { describe, expect, it } from 'vitest';
import { createKnowledgeGraph } from '../../src/core/graph/graph';
import {
  formatNodeMarker,
  getToolResultText,
  parseNodeMarker,
  resolveTrackedNodeIds,
  stripNodeMarkers,
} from '../../src/lib/agent-tracking';
import { knowledgeGraphToGraphology } from '../../src/lib/graph-adapter';
import { createFileNode, createFunctionNode } from '../fixtures/graph';

describe('agent tracking node markers', () => {
  it('round-trips encoded graph node ids', () => {
    const ids = ['File:src/app.ts', 'Function:src/app.ts:main:1'];
    const marker = formatNodeMarker('HIGHLIGHT_NODES', ids);

    expect(marker).toBe('[HIGHLIGHT_NODES:File%3Asrc%2Fapp.ts,Function%3Asrc%2Fapp.ts%3Amain%3A1]');
    expect(parseNodeMarker(marker, 'HIGHLIGHT_NODES')).toEqual(ids);
  });

  it('deduplicates marker ids while preserving order', () => {
    const marker = formatNodeMarker('IMPACT', ['node:a', 'node:a', '', 'node:b']);

    expect(parseNodeMarker(marker, 'IMPACT')).toEqual(['node:a', 'node:b']);
  });

  it('parses multiple markers from nested tool result content blocks', () => {
    const result = {
      content: [
        { type: 'text', text: 'Found graph nodes\n[HIGHLIGHT_NODES:File%3Asrc%2Fapp.ts]' },
        {
          type: 'text',
          text: '[HIGHLIGHT_NODES:Function%3Asrc%2Fapp.ts%3Amain%3A12,File%3Asrc%2Fapp.ts]',
        },
      ],
    };

    expect(parseNodeMarker(result, 'HIGHLIGHT_NODES')).toEqual([
      'File:src/app.ts',
      'Function:src/app.ts:main:12',
    ]);
  });

  it('ignores absent or malformed marker text without throwing', () => {
    const result = {
      content: [
        { type: 'text', text: 'No graph marker here.' },
        { type: 'text', text: '[IMPACT:node%ZZ,node%ZZ,node%3Ab]' },
        { type: 'text', text: '[IMPACT:unfinished' },
      ],
    };

    expect(parseNodeMarker({ content: 'plain result' }, 'HIGHLIGHT_NODES')).toEqual([]);
    expect(parseNodeMarker(result, 'IMPACT')).toEqual(['node%ZZ', 'node:b']);
  });

  it('strips tracking markers from display text', () => {
    const text = 'Result body\n[HIGHLIGHT_NODES:File%3Asrc%2Fapp.ts]\n[IMPACT:node%3Aa]';

    expect(stripNodeMarkers(text)).toBe('Result body');
  });

  it('normalizes nested tool results before display or graph tracking', () => {
    const result = { content: [{ type: 'text', text: 'Result body\n[IMPACT:node%3Aa]' }] };

    expect(getToolResultText(result)).toBe('Result body\n[IMPACT:node%3Aa]');
    expect(stripNodeMarkers(result)).toBe('Result body');
  });

  it('resolves marker fallbacks against graph node metadata', () => {
    const file = createFileNode('app.ts', 'src/app.ts');
    const fn = createFunctionNode('main', 'src/app.ts', 12);

    expect(
      resolveTrackedNodeIds(
        ['Function:main', 'src/app.ts:15', 'main', 'app.ts', 'missing'],
        [file, fn],
      ),
    ).toEqual([fn.id, file.id]);
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

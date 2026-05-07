import { describe, expect, it } from 'vitest';
import {
  brightenColor,
  dimColor,
  resolveGraphEdgeVisual,
  resolveGraphNodeVisual,
} from '../../src/lib/graph-visual-state';
import { GRAPH_HIGHLIGHT_COLORS } from '../../src/lib/constants';

describe('graph visual state', () => {
  it('keeps selected nodes above spotlight colors', () => {
    const visual = resolveGraphNodeVisual({
      nodeId: 'node:a',
      color: '#10b981',
      size: 10,
      selectedNodeId: 'node:a',
      highlightedNodeIds: new Set(['node:a']),
      blastRadiusNodeIds: new Set(['node:a']),
    });

    expect(visual.color).toBe(brightenColor('#10b981', 1.25));
    expect(visual.highlighted).toBe(true);
    expect(visual.zIndex).toBe(4);
  });

  it('uses blast radius before query spotlight when nothing is selected', () => {
    const visual = resolveGraphNodeVisual({
      nodeId: 'node:a',
      color: '#10b981',
      size: 10,
      highlightedNodeIds: new Set(['node:a']),
      blastRadiusNodeIds: new Set(['node:a']),
    });

    expect(visual.color).toBe(GRAPH_HIGHLIGHT_COLORS.blast);
    expect(visual.size).toBeCloseTo(18);
  });

  it('dims inactive nodes when a spotlight is active', () => {
    const visual = resolveGraphNodeVisual({
      nodeId: 'node:b',
      color: '#10b981',
      size: 10,
      highlightedNodeIds: new Set(['node:a']),
    });

    expect(visual.color).toBe(dimColor('#10b981', 0.22));
    expect(visual.size).toBeCloseTo(5.2);
  });

  it('resolves edge colors from the same selected and spotlight priority', () => {
    const selected = resolveGraphEdgeVisual({
      sourceId: 'node:a',
      targetId: 'node:b',
      color: '#93c5fd',
      size: 1,
      selectedNodeId: 'node:a',
      highlightedNodeIds: new Set(['node:c']),
    });

    expect(selected.color).toBe(brightenColor('#93c5fd', 1.5));
    expect(selected.size).toBe(4);

    const spotlight = resolveGraphEdgeVisual({
      sourceId: 'node:a',
      targetId: 'node:b',
      color: '#93c5fd',
      size: 1,
      highlightedNodeIds: new Set(['node:a', 'node:b']),
    });

    expect(spotlight.color).toBe(GRAPH_HIGHLIGHT_COLORS.query);
    expect(spotlight.size).toBe(3);
  });

  it('keeps the active agent subgraph visible when one touched node is selected', () => {
    const nodeVisual = resolveGraphNodeVisual({
      nodeId: 'node:b',
      color: '#10b981',
      size: 10,
      selectedNodeId: 'node:a',
      highlightedNodeIds: new Set(['node:b']),
    });

    expect(nodeVisual.color).toBe(GRAPH_HIGHLIGHT_COLORS.query);
    expect(nodeVisual.size).toBeCloseTo(14.2);

    const edgeVisual = resolveGraphEdgeVisual({
      sourceId: 'node:b',
      targetId: 'node:c',
      color: '#93c5fd',
      size: 1,
      selectedNodeId: 'node:a',
      highlightedNodeIds: new Set(['node:b', 'node:c']),
    });

    expect(edgeVisual.color).toBe(GRAPH_HIGHLIGHT_COLORS.query);
    expect(edgeVisual.size).toBe(3);
  });
});

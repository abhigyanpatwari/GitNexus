/// <reference lib="dom" />

import Graph from 'graphology';
import Sigma from 'sigma';
import type { GraphPayload } from './graph-data';

declare global {
  interface Window {
    __GITNEXUS_GRAPH__?: GraphPayload;
  }
}

const payload = window.__GITNEXUS_GRAPH__;
const container = document.getElementById('graph-canvas');
const details = document.getElementById('graph-details');
const stats = document.getElementById('graph-stats');

if (!payload || !container || !details || !stats) {
  throw new Error('GitNexus graph payload is missing.');
}

const detailsElement = details;
const statsElement = stats;

const graph = new Graph();
for (const node of payload.nodes) {
  graph.addNode(node.id, {
    label: node.label,
    x: node.x,
    y: node.y,
    size: node.size,
    color: node.color,
    baseColor: node.color,
    kind: node.kind,
    details: node.details,
  });
}

for (const edge of payload.edges) {
  if (!graph.hasNode(edge.source) || !graph.hasNode(edge.target) || graph.hasEdge(edge.id)) {
    continue;
  }

  graph.addEdgeWithKey(edge.id, edge.source, edge.target, {
    label: edge.label,
    color: edge.color ?? '#475569',
    size: 1,
    type: 'line',
  });
}

statsElement.textContent = `${graph.order} nodes · ${graph.size} edges`;

const renderer = new Sigma(graph, container, {
  renderEdgeLabels: false,
  labelDensity: 0.1,
  labelGridCellSize: 90,
  labelRenderedSizeThreshold: 8,
  zIndex: true,
  allowInvalidContainer: false,
});

setDetails('Select a node to inspect its details. Scroll to zoom, drag to pan.');

renderer.on('clickNode', ({ node }) => {
  const attributes = graph.getNodeAttributes(node);
  const neighbors = graph.neighbors(node);

  const lines = [
    `Name: ${attributes.label as string}`,
    `Kind: ${String(attributes.kind ?? 'unknown')}`,
    `Neighbors: ${neighbors.length}`,
  ];

  if (typeof attributes.details === 'string' && attributes.details.trim()) {
    lines.push('', attributes.details);
  }

  setDetails(lines.join('\n'));
  highlightNeighborhood(node);
});

renderer.on('clickStage', () => {
  clearHighlight();
  setDetails('Select a node to inspect its details. Scroll to zoom, drag to pan.');
});

function setDetails(text: string): void {
  detailsElement.textContent = text;
}

function clearHighlight(): void {
  graph.forEachNode((node) => {
    graph.setNodeAttribute(node, 'highlighted', false);
    graph.setNodeAttribute(node, 'color', graph.getNodeAttribute(node, 'baseColor'));
  });

  renderer.refresh();
}

function highlightNeighborhood(nodeId: string): void {
  const neighborhood = new Set<string>([nodeId, ...graph.neighbors(nodeId)]);

  graph.forEachNode((node) => {
    const highlighted = neighborhood.has(node);
    const baseColor = graph.getNodeAttribute(node, 'baseColor');
    graph.setNodeAttribute(node, 'highlighted', highlighted);
    graph.setNodeAttribute(node, 'color', highlighted ? baseColor : '#64748b');
  });

  renderer.refresh();
}

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
let activeNodeId: string | undefined;

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
    baseColor: edge.color ?? '#475569',
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

const themeObserver = new MutationObserver(() => {
  applyThemeColors();
});

themeObserver.observe(document.body, {
  attributes: true,
  attributeFilter: ['class', 'data-vscode-theme-kind', 'data-vscode-theme-id'],
});

window.addEventListener(
  'beforeunload',
  () => {
    themeObserver.disconnect();
  },
  { once: true },
);

applyThemeColors();

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

function clearHighlight(refresh = true): void {
  activeNodeId = undefined;

  graph.forEachNode((node) => {
    graph.setNodeAttribute(node, 'highlighted', false);
    graph.setNodeAttribute(node, 'color', graph.getNodeAttribute(node, 'baseColor'));
  });

  if (refresh) {
    renderer.refresh();
  }
}

function highlightNeighborhood(nodeId: string, refresh = true): void {
  activeNodeId = nodeId;

  const neighborhood = new Set<string>([nodeId, ...graph.neighbors(nodeId)]);
  const palette = getThemePalette();

  graph.forEachNode((node) => {
    const highlighted = neighborhood.has(node);
    const baseColor = graph.getNodeAttribute(node, 'baseColor');
    graph.setNodeAttribute(node, 'highlighted', highlighted);
    graph.setNodeAttribute(node, 'color', highlighted ? baseColor : palette.dimmedNode);
  });

  if (refresh) {
    renderer.refresh();
  }
}

function applyThemeColors(): void {
  const palette = getThemePalette();
  const isDark = isDarkTheme();

  graph.forEachNode((node) => {
    const kind = graph.getNodeAttribute(node, 'kind');
    const fallbackColor = graph.getNodeAttribute(node, 'baseColor');
    const themedBaseColor = getNodeColor(kind, palette, fallbackColor);
    graph.setNodeAttribute(node, 'baseColor', themedBaseColor);
  });

  graph.forEachEdge((edge) => {
    const originalColor = graph.getEdgeAttribute(edge, 'baseColor');
    graph.setEdgeAttribute(edge, 'color', getEdgeColor(originalColor, palette, isDark));
  });

  if (activeNodeId && graph.hasNode(activeNodeId)) {
    highlightNeighborhood(activeNodeId, false);
  } else {
    clearHighlight(false);
  }

  renderer.refresh();
}

function getNodeColor(kind: unknown, palette: ThemePalette, fallback: unknown): string {
  if (kind === 'repo') {
    return palette.repo;
  }

  if (kind === 'module') {
    return palette.module;
  }

  if (kind === 'process') {
    return palette.process;
  }

  if (kind === 'symbol') {
    return palette.symbol;
  }

  if (typeof fallback === 'string' && fallback.trim()) {
    return fallback;
  }

  return palette.repo;
}

function getEdgeColor(originalColor: unknown, palette: ThemePalette, darkTheme: boolean): string {
  if (typeof originalColor !== 'string') {
    return palette.edge;
  }

  const normalized = originalColor.toLowerCase();
  if (normalized === '#e11d48' || normalized === '#be123c') {
    return darkTheme ? '#f43f5e' : '#be123c';
  }

  return palette.edge;
}

function isDarkTheme(): boolean {
  const classes = document.body.classList;

  if (classes.contains('vscode-light') || classes.contains('vscode-high-contrast-light')) {
    return false;
  }

  if (classes.contains('vscode-dark') || classes.contains('vscode-high-contrast')) {
    return true;
  }

  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? true;
}

function getThemePalette(): ThemePalette {
  if (isDarkTheme()) {
    return {
      repo: '#38bdf8',
      module: '#22c55e',
      process: '#f59e0b',
      symbol: '#f43f5e',
      edge: '#334155',
      dimmedNode: '#64748b',
    };
  }

  return {
    repo: '#0369a1',
    module: '#15803d',
    process: '#b45309',
    symbol: '#be123c',
    edge: '#94a3b8',
    dimmedNode: '#cbd5e1',
  };
}

interface ThemePalette {
  repo: string;
  module: string;
  process: string;
  symbol: string;
  edge: string;
  dimmedNode: string;
}

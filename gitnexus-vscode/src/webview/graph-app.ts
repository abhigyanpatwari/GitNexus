/// <reference lib="dom" />

import Graph from 'graphology';
import Sigma from 'sigma';
import type { NodeHoverDrawingFunction, NodeLabelDrawingFunction } from 'sigma/rendering';
import type { GraphPayload } from './graph-data';

declare global {
  interface Window {
    __GITNEXUS_GRAPH__?: GraphPayload;
  }
}

interface VsCodeApi {
  postMessage(message: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();

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
let activePalette = getThemePalette();

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
  labelColor: {
    color: activePalette.label,
  },
  defaultDrawNodeLabel: drawNodeLabel,
  defaultDrawNodeHover: drawNodeHover,
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
  const nodeKind = String(attributes.kind ?? '');
  const nodeLabel = String(attributes.label ?? '');

  if (nodeKind === 'symbol' || nodeKind === 'module' || nodeKind === 'process') {
    vscode.postMessage({
      command: 'gitnexus.openNodeSource',
      payload: {
        kind: nodeKind,
        label: nodeLabel,
      },
    });
  }

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
  activePalette = palette;

  renderer.setSetting('labelColor', {
    color: palette.label,
  });

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
      label: '#e2e8f0',
      hoverBackground: 'rgba(15, 23, 42, 0.94)',
      hoverLabel: '#f8fafc',
      hoverShadow: 'rgba(2, 6, 23, 0.75)',
    };
  }

  return {
    repo: '#0369a1',
    module: '#15803d',
    process: '#b45309',
    symbol: '#be123c',
    edge: '#94a3b8',
    dimmedNode: '#cbd5e1',
    label: '#0f172a',
    hoverBackground: 'rgba(255, 255, 255, 0.96)',
    hoverLabel: '#0f172a',
    hoverShadow: 'rgba(15, 23, 42, 0.25)',
  };
}

interface ThemePalette {
  repo: string;
  module: string;
  process: string;
  symbol: string;
  edge: string;
  dimmedNode: string;
  label: string;
  hoverBackground: string;
  hoverLabel: string;
  hoverShadow: string;
}

function drawNodeLabel(...args: Parameters<NodeLabelDrawingFunction>): void {
  const [context, data, settings] = args;
  drawNodeLabelWithColor(context, data, settings, activePalette.label);
}

function drawNodeHover(...args: Parameters<NodeHoverDrawingFunction>): void {
  const [context, data, settings] = args;
  const size = settings.labelSize;
  const font = settings.labelFont;
  const weight = settings.labelWeight;

  context.font = `${weight} ${size}px ${font}`;

  context.fillStyle = activePalette.hoverBackground;
  context.shadowOffsetX = 0;
  context.shadowOffsetY = 0;
  context.shadowBlur = 8;
  context.shadowColor = activePalette.hoverShadow;

  const padding = 2;

  if (typeof data.label === 'string') {
    const textWidth = context.measureText(data.label).width;
    const boxWidth = Math.round(textWidth + 5);
    const boxHeight = Math.round(size + 2 * padding);
    const radius = Math.max(data.size, size / 2) + padding;
    const angleRadian = Math.asin(boxHeight / 2 / radius);
    const xDeltaCoord = Math.sqrt(Math.abs(radius ** 2 - (boxHeight / 2) ** 2));

    context.beginPath();
    context.moveTo(data.x + xDeltaCoord, data.y + boxHeight / 2);
    context.lineTo(data.x + radius + boxWidth, data.y + boxHeight / 2);
    context.lineTo(data.x + radius + boxWidth, data.y - boxHeight / 2);
    context.lineTo(data.x + xDeltaCoord, data.y - boxHeight / 2);
    context.arc(data.x, data.y, radius, angleRadian, -angleRadian);
    context.closePath();
    context.fill();
  } else {
    context.beginPath();
    context.arc(data.x, data.y, data.size + padding, 0, Math.PI * 2);
    context.closePath();
    context.fill();
  }

  context.shadowOffsetX = 0;
  context.shadowOffsetY = 0;
  context.shadowBlur = 0;

  drawNodeLabelWithColor(context, data, settings, activePalette.hoverLabel);
}

function drawNodeLabelWithColor(
  context: Parameters<NodeLabelDrawingFunction>[0],
  data: Parameters<NodeLabelDrawingFunction>[1],
  settings: Parameters<NodeLabelDrawingFunction>[2],
  color: string,
): void {
  if (typeof data.label !== 'string' || data.label.length === 0) {
    return;
  }

  const size = settings.labelSize;
  const font = settings.labelFont;
  const weight = settings.labelWeight;

  context.fillStyle = color;
  context.font = `${weight} ${size}px ${font}`;
  context.fillText(data.label, data.x + data.size + 3, data.y + size / 3);
}

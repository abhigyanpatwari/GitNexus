/**
 * HTML Graph Viewer Generator
 *
 * Produces a self-contained graph.html that renders the knowledge graph
 * using Sigma.js v2 + graphology (both from CDN).
 *
 * Critical: node `content` fields are stripped before embedding to prevent
 * </script> injection from source code breaking the HTML parser.
 */

import { GraphNode, GraphRelationship } from './types.js'

// ─── CDN URLs ───────────────────────────────────────────────────────────

const CDN_GRAPHOLOGY =
  'https://cdn.jsdelivr.net/npm/graphology@0.25/dist/graphology.umd.min.js'
const CDN_SIGMA =
  'https://cdn.jsdelivr.net/npm/sigma@2/build/sigma.min.js'
const CDN_FA2 =
  'https://cdn.jsdelivr.net/npm/graphology-layout-forceatlas2@0.10/dist/graphology-layout-forceatlas2.min.js'

// ─── Public API ─────────────────────────────────────────────────────────

/**
 * Generate a self-contained HTML file that renders the knowledge graph.
 * Strips large/unsafe fields from nodes before embedding.
 */
export function generateHTMLGraphViewer(
  nodes: GraphNode[],
  relationships: GraphRelationship[],
  projectName: string,
): string {
  // Strip content + other large string fields to:
  //   1) Prevent </script> injection (source code breaks HTML parsing)
  //   2) Dramatically reduce output file size
  const liteNodes = nodes.map(n => ({
    id: n.id,
    label: n.label,
    properties: {
      name: n.properties.name,
      filePath: n.properties.filePath,
      startLine: n.properties.startLine,
      endLine: n.properties.endLine,
      heuristicLabel: n.properties.heuristicLabel,
      cohesion: n.properties.cohesion,
      symbolCount: n.properties.symbolCount,
      entryPointId: n.properties.entryPointId,
      terminalId: n.properties.terminalId,
    },
  }))

  const liteRelationships = relationships.map(r => ({
    id: r.id,
    type: r.type,
    sourceId: r.sourceId,
    targetId: r.targetId,
    confidence: r.confidence,
    step: r.step,
  }))

  // Escape </script> as a belt-and-suspenders safety measure
  const graphData = JSON.stringify({ nodes: liteNodes, relationships: liteRelationships })
    .replace(/<\/script>/gi, '<\\/script>')

  const parts: string[] = []

  // ── Head ──
  parts.push('<!DOCTYPE html>')
  parts.push('<html lang="en">')
  parts.push('<head>')
  parts.push('<meta charset="UTF-8">')
  parts.push('<meta name="viewport" content="width=device-width, initial-scale=1.0">')
  parts.push('<title>' + esc(projectName) + ' \u2014 Knowledge Graph</title>')
  parts.push('<style>')
  parts.push(VIEWER_CSS)
  parts.push('</style>')
  parts.push('</head>')

  // ── Body ──
  parts.push('<body>')
  parts.push('<div id="header">')
  parts.push('<div id="header-left">')
  parts.push('<span id="title">' + esc(projectName) + '</span>')
  parts.push('<span id="stats"></span>')
  parts.push('</div>')
  parts.push('<div id="legend"></div>')
  parts.push('</div>')
  parts.push('<div id="main">')
  parts.push('<div id="sigma-container"></div>')
  parts.push('<div id="info-panel" class="hidden">')
  parts.push('<div id="info-header"><span id="info-name"></span><button id="info-close">\u00d7</button></div>')
  parts.push('<div id="info-body"></div>')
  parts.push('</div>')
  parts.push('</div>')
  parts.push('<div id="tooltip"></div>')

  // ── Scripts ──
  parts.push('<script src="' + CDN_GRAPHOLOGY + '"><\/script>')
  parts.push('<script src="' + CDN_SIGMA + '"><\/script>')
  parts.push('<script src="' + CDN_FA2 + '"><\/script>')
  parts.push('<script>')
  parts.push('window.GRAPH_DATA = ' + graphData + ';')
  parts.push('window.PROJECT_NAME = ' + JSON.stringify(projectName) + ';')
  parts.push(VIEWER_JS)
  parts.push('<\/script>')

  parts.push('</body>')
  parts.push('</html>')

  return parts.join('\n')
}

// ─── Helpers ────────────────────────────────────────────────────────────

function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// ─── Static Assets ──────────────────────────────────────────────────────

const VIEWER_CSS = `
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0d0e17;color:#e2e8f0;display:flex;flex-direction:column;height:100vh;overflow:hidden}
#header{display:flex;align-items:center;justify-content:space-between;padding:10px 16px;background:#12131f;border-bottom:1px solid #1e2035;flex-shrink:0;gap:12px}
#header-left{display:flex;align-items:center;gap:12px;min-width:0}
#title{font-size:13px;font-weight:700;color:#a5b4fc;white-space:nowrap}
#stats{font-size:11px;color:#475569;white-space:nowrap}
#legend{display:flex;gap:8px;flex-wrap:wrap;flex:1;justify-content:flex-end}
.legend-item{display:flex;align-items:center;gap:4px;font-size:10px;color:#64748b;white-space:nowrap}
.legend-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
#main{flex:1;position:relative;overflow:hidden;display:flex}
#sigma-container{flex:1;position:relative}
#sigma-container canvas{display:block}
#info-panel{position:absolute;top:12px;right:12px;width:260px;background:#12131f;border:1px solid #1e2035;border-radius:8px;z-index:10;font-size:12px}
#info-panel.hidden{display:none}
#info-header{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border-bottom:1px solid #1e2035}
#info-name{font-weight:600;color:#c4b5fd;font-size:13px;word-break:break-all}
#info-close{background:none;border:none;color:#475569;cursor:pointer;font-size:16px;line-height:1;padding:0 2px}
#info-close:hover{color:#e2e8f0}
#info-body{padding:12px;display:flex;flex-direction:column;gap:6px}
.info-row{display:flex;flex-direction:column;gap:2px}
.info-label{font-size:10px;color:#475569;text-transform:uppercase;letter-spacing:.4px}
.info-value{color:#94a3b8;word-break:break-all;font-size:11px}
.info-badge{display:inline-block;padding:2px 6px;border-radius:4px;font-size:10px;font-weight:600;color:#0d0e17}
#tooltip{position:fixed;pointer-events:none;background:#12131f;border:1px solid #1e2035;border-radius:6px;padding:6px 10px;font-size:11px;color:#94a3b8;z-index:100;display:none;max-width:260px;line-height:1.6}
#tooltip strong{color:#c4b5fd;font-size:12px;display:block}
`;

// The client-side JS is kept as a plain string to avoid template literal conflicts
const VIEWER_JS = `
(function() {

// ── Color + size tables (mirrored from gitnexus-web) ──────────────────────
var NODE_COLORS = {
  Project:'#a855f7', Package:'#8b5cf6', Module:'#7c3aed', Folder:'#6366f1',
  File:'#3b82f6', Class:'#f59e0b', Function:'#10b981', Method:'#14b8a6',
  Variable:'#64748b', Interface:'#ec4899', Enum:'#f97316', Decorator:'#eab308',
  Import:'#475569', Type:'#a78bfa', CodeElement:'#64748b',
  Community:'#818cf8', Process:'#f43f5e',
};
var NODE_SIZES = {
  Project:20, Package:16, Module:13, Folder:10, File:6,
  Class:8, Function:4, Method:3, Variable:2, Interface:7, Enum:5,
  Decorator:2, Import:1.5, Type:3, CodeElement:2, Community:0, Process:0,
};
var EDGE_COLORS = {
  CONTAINS:'#2d5a3d', DEFINES:'#0e7490', IMPORTS:'#1d4ed8',
  CALLS:'#7c3aed', EXTENDS:'#c2410c', IMPLEMENTS:'#be185d',
};
var COMMUNITY_COLORS = [
  '#ef4444','#f97316','#eab308','#22c55e','#06b6d4','#3b82f6',
  '#8b5cf6','#d946ef','#ec4899','#f43f5e','#14b8a6','#84cc16',
];

// Types visible by default (hide noisy Import/Variable/Decorator/CodeElement)
var VISIBLE_LABELS = {
  Project:1, Package:1, Module:1, Folder:1, File:1,
  Class:1, Function:1, Method:1, Interface:1, Enum:1, Type:1,
};

function getCommunityColor(idx) {
  return COMMUNITY_COLORS[idx % COMMUNITY_COLORS.length];
}

// Scale node sizes for large graphs
function getScaledSize(base, nodeCount) {
  if (nodeCount > 20000) return Math.max(1, base * 0.5);
  if (nodeCount > 5000)  return Math.max(1.5, base * 0.65);
  if (nodeCount > 1000)  return Math.max(2, base * 0.8);
  return base;
}

// ── Graph building ────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', function() {
  var data = window.GRAPH_DATA;
  var container = document.getElementById('sigma-container');

  // Stats header
  var visible = data.nodes.filter(function(n) { return VISIBLE_LABELS[n.label]; });
  document.getElementById('stats').textContent =
    data.nodes.length + ' nodes  \u00b7  ' + data.relationships.length + ' edges';

  // Build legend
  var shownTypes = {};
  data.nodes.forEach(function(n) { if (VISIBLE_LABELS[n.label]) shownTypes[n.label] = true; });
  var legendEl = document.getElementById('legend');
  Object.keys(NODE_COLORS).forEach(function(label) {
    if (!shownTypes[label]) return;
    var item = document.createElement('div');
    item.className = 'legend-item';
    var dot = document.createElement('div');
    dot.className = 'legend-dot';
    dot.style.background = NODE_COLORS[label];
    item.appendChild(dot);
    item.appendChild(document.createTextNode(label));
    legendEl.appendChild(item);
  });

  // ── Build graphology graph ────────────────────────────────────────────

  var Graph = graphology.Graph || graphology;
  var graph = new Graph({ type: 'directed', multi: false });
  var nodeCount = data.nodes.length;

  // Build parent maps from structural relationships
  var parentOf = {};   // childId -> parentId
  var childrenOf = {}; // parentId -> [childId]
  var HIERARCHY = { CONTAINS:1, DEFINES:1, IMPORTS:1 };
  data.relationships.forEach(function(r) {
    if (HIERARCHY[r.type]) {
      parentOf[r.targetId] = r.sourceId;
      if (!childrenOf[r.sourceId]) childrenOf[r.sourceId] = [];
      childrenOf[r.sourceId].push(r.targetId);
    }
  });

  // Build community membership from MEMBER_OF relationships
  var communityOf = {}; // nodeId -> communityIndex
  var communityNodes = {};
  data.nodes.forEach(function(n) {
    if (n.label === 'Community') communityNodes[n.id] = true;
  });
  var memberIdx = {};
  var communityCounter = 0;
  data.relationships.forEach(function(r) {
    if (r.type === 'MEMBER_OF' && communityNodes[r.targetId]) {
      if (memberIdx[r.targetId] === undefined) {
        memberIdx[r.targetId] = communityCounter++;
      }
      communityOf[r.sourceId] = memberIdx[r.targetId];
    }
  });

  // Spread multiplier
  var spread = Math.sqrt(nodeCount) * 40;
  var childJitter = Math.sqrt(nodeCount) * 3;
  var clusterJitter = Math.sqrt(nodeCount) * 1.5;
  var GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

  // Cluster centers
  var clusterCenters = {};
  var uniqueCommunities = {};
  Object.values(communityOf).forEach(function(ci) { uniqueCommunities[ci] = true; });
  var communityList = Object.keys(uniqueCommunities).map(Number);
  communityList.forEach(function(ci, idx) {
    var angle = idx * GOLDEN_ANGLE;
    var radius = spread * 0.8 * Math.sqrt((idx + 1) / Math.max(communityList.length, 1));
    clusterCenters[ci] = { x: radius * Math.cos(angle), y: radius * Math.sin(angle) };
  });

  // Node positions cache
  var posMap = {};

  // Structural types positioned first, wide radial
  var STRUCTURAL = { Project:1, Package:1, Module:1, Folder:1 };
  var structural = data.nodes.filter(function(n) { return STRUCTURAL[n.label]; });

  structural.forEach(function(node, idx) {
    var angle = idx * GOLDEN_ANGLE;
    var radius = spread * Math.sqrt((idx + 1) / Math.max(structural.length, 1));
    var jitter = spread * 0.15;
    var x = radius * Math.cos(angle) + (Math.random() - 0.5) * jitter;
    var y = radius * Math.sin(angle) + (Math.random() - 0.5) * jitter;
    posMap[node.id] = { x: x, y: y };
  });

  function addNode(node) {
    if (graph.hasNode(node.id)) return;
    if (!VISIBLE_LABELS[node.label]) return; // skip Community, Process, Import by default

    var x, y;
    var ci = communityOf[node.id];
    var SYMBOLS = { Function:1, Class:1, Method:1, Interface:1 };

    if (ci !== undefined && SYMBOLS[node.label] && clusterCenters[ci]) {
      x = clusterCenters[ci].x + (Math.random() - 0.5) * clusterJitter;
      y = clusterCenters[ci].y + (Math.random() - 0.5) * clusterJitter;
    } else {
      var parentPos = posMap[parentOf[node.id]];
      if (parentPos) {
        x = parentPos.x + (Math.random() - 0.5) * childJitter;
        y = parentPos.y + (Math.random() - 0.5) * childJitter;
      } else {
        x = (Math.random() - 0.5) * spread * 0.5;
        y = (Math.random() - 0.5) * spread * 0.5;
      }
    }

    posMap[node.id] = { x: x, y: y };

    var baseSize = NODE_SIZES[node.label] || 4;
    var size = getScaledSize(baseSize, nodeCount);
    var color = (ci !== undefined) ? getCommunityColor(ci) : (NODE_COLORS[node.label] || '#94a3b8');

    graph.addNode(node.id, {
      x: x, y: y, size: size, color: color,
      label: node.properties.name || node.id,
      nodeType: node.label,
      filePath: node.properties.filePath,
      startLine: node.properties.startLine,
      endLine: node.properties.endLine,
      communityColor: ci !== undefined ? getCommunityColor(ci) : null,
    });
  }

  // BFS from structural nodes (parents before children)
  var queue = structural.map(function(n) { return n.id; });
  var visited = {};
  queue.forEach(function(id) { visited[id] = true; addNode(data.nodes.find(function(n) { return n.id === id; })); });

  while (queue.length) {
    var cur = queue.shift();
    var kids = childrenOf[cur] || [];
    kids.forEach(function(kidId) {
      if (!visited[kidId]) {
        visited[kidId] = true;
        var kidNode = data.nodes.find(function(n) { return n.id === kidId; });
        if (kidNode) { addNode(kidNode); queue.push(kidId); }
      }
    });
  }

  // Orphans
  data.nodes.forEach(function(n) {
    if (!visited[n.id]) { visited[n.id] = true; addNode(n); }
  });

  // Add edges
  var edgeBaseSize = nodeCount > 20000 ? 0.4 : nodeCount > 5000 ? 0.6 : 0.8;
  data.relationships.forEach(function(r) {
    if (!graph.hasNode(r.sourceId) || !graph.hasNode(r.targetId)) return;
    if (graph.hasEdge(r.sourceId, r.targetId)) return;
    var color = EDGE_COLORS[r.type] || '#2a2a3a';
    var sizeM = (r.type === 'CALLS') ? 0.8 : (r.type === 'EXTENDS' || r.type === 'IMPLEMENTS') ? 1.0 : 0.5;
    try {
      graph.addEdge(r.sourceId, r.targetId, {
        size: edgeBaseSize * sizeM,
        color: color,
        relationType: r.type,
      });
    } catch(e) {}
  });

  // ── Degree-based node sizing ──────────────────────────────────────────
  graph.forEachNode(function(node) {
    var deg = graph.degree(node);
    var cur = graph.getNodeAttribute(node, 'size');
    var bonus = Math.min(deg * 0.15, cur * 1.5);
    graph.setNodeAttribute(node, 'size', cur + bonus);
  });

  // ── ForceAtlas2 layout ────────────────────────────────────────────────
  var FA2Layout = typeof graphologyLayoutForceatlas2 !== 'undefined' ? graphologyLayoutForceatlas2 : null;
  if (FA2Layout && FA2Layout.assign) {
    try {
      FA2Layout.assign(graph, {
        iterations: nodeCount > 1000 ? 100 : 200,
        settings: {
          gravity: 1,
          scalingRatio: 2,
          barnesHutOptimize: nodeCount > 500,
        },
      });
    } catch(e) { console.warn('FA2 layout failed:', e); }
  }

  // ── Mount Sigma ────────────────────────────────────────────────────────

  var SigmaClass = typeof Sigma !== 'undefined' ? Sigma : window.Sigma;
  if (!SigmaClass) {
    container.innerHTML = '<div style="color:#ef4444;padding:40px;text-align:center">Sigma.js failed to load from CDN.<br>Check your internet connection.</div>';
    return;
  }

  var sigma = new SigmaClass(graph, container, {
    renderLabels: true,
    labelFont: 'monospace',
    labelSize: 10,
    labelWeight: '400',
    labelColor: { color: '#94a3b8' },
    labelRenderedSizeThreshold: 6,
    labelDensity: 0.07,
    labelGridCellSize: 80,
    defaultNodeColor: '#6b7280',
    defaultEdgeColor: '#1e2035',
    minCameraRatio: 0.005,
    maxCameraRatio: 50,
    hideEdgesOnMove: true,
    zIndex: true,
  });

  // ── Hover tooltip ──────────────────────────────────────────────────────

  var tooltip = document.getElementById('tooltip');

  sigma.on('enterNode', function(e) {
    var attrs = graph.getNodeAttributes(e.node);
    var html = '<strong>' + (attrs.label || e.node).replace(/</g, '&lt;') + '</strong>';
    if (attrs.nodeType) html += '<span style="color:#475569">' + attrs.nodeType + '</span>';
    if (attrs.filePath) html += '<span style="color:#64748b;font-size:10px;display:block">' + attrs.filePath + '</span>';
    tooltip.innerHTML = html;
    tooltip.style.display = 'block';
  });

  sigma.on('leaveNode', function() { tooltip.style.display = 'none'; });

  container.addEventListener('mousemove', function(e) {
    tooltip.style.left = (e.clientX + 14) + 'px';
    tooltip.style.top = (e.clientY - 8) + 'px';
  });

  // ── Node info panel + neighbor highlighting ────────────────────────────

  var panel = document.getElementById('info-panel');
  var infoName = document.getElementById('info-name');
  var infoBody = document.getElementById('info-body');
  var highlightedNode = null;
  var highlightedNeighbors = {};

  function row(label, value) {
    if (!value && value !== 0) return '';
    return '<div class="info-row"><div class="info-label">' + label + '</div>' +
           '<div class="info-value">' + String(value).replace(/</g,'&lt;').replace(/>/g,'&gt;') + '</div></div>';
  }

  function clearHighlight() {
    highlightedNode = null;
    highlightedNeighbors = {};
    sigma.setSetting('nodeReducer', null);
    sigma.setSetting('edgeReducer', null);
  }

  sigma.on('clickNode', function(e) {
    highlightedNode = e.node;
    highlightedNeighbors = {};
    graph.neighbors(e.node).forEach(function(n) { highlightedNeighbors[n] = true; });

    sigma.setSetting('nodeReducer', function(node, data) {
      if (node === highlightedNode || highlightedNeighbors[node]) return data;
      return Object.assign({}, data, { color: '#1a1b2e', label: null, zIndex: 0 });
    });

    sigma.setSetting('edgeReducer', function(edge, data) {
      var src = graph.source(edge);
      var tgt = graph.target(edge);
      if (src === highlightedNode || tgt === highlightedNode) return data;
      return Object.assign({}, data, { color: '#151520' });
    });

    var attrs = graph.getNodeAttributes(e.node);
    infoName.innerHTML = '<span class="info-badge" style="background:' + (attrs.color||'#6366f1') + '">' +
      (attrs.nodeType || '') + '</span> ' +
      (attrs.label || e.node).replace(/</g,'&lt;');
    var html = '';
    html += row('File', attrs.filePath);
    if (attrs.startLine) html += row('Lines', attrs.startLine + (attrs.endLine ? '\u2013' + attrs.endLine : ''));
    html += row('Connections', graph.degree(e.node));
    panel.classList.remove('hidden');
    infoBody.innerHTML = html;
  });

  sigma.on('clickStage', function() {
    clearHighlight();
    panel.classList.add('hidden');
  });

  document.getElementById('info-close').addEventListener('click', function() {
    clearHighlight();
    panel.classList.add('hidden');
  });
});

})();
`;

import type { ModuleSummary, ProcessSummary } from '../types';

export interface GraphNodeData {
  id: string;
  label: string;
  kind: 'repo' | 'module' | 'process' | 'symbol';
  x: number;
  y: number;
  size: number;
  color: string;
  details?: string;
}

export interface GraphEdgeData {
  id: string;
  source: string;
  target: string;
  label?: string;
  color?: string;
}

export interface GraphPayload {
  title: string;
  subtitle?: string;
  focusSymbol?: string;
  nodes: GraphNodeData[];
  edges: GraphEdgeData[];
}

export function buildGraphPayload(
  repoName: string,
  modules: ModuleSummary[],
  processes: ProcessSummary[],
  focusSymbol?: string,
): GraphPayload {
  const nodes: GraphNodeData[] = [];
  const edges: GraphEdgeData[] = [];

  const repoId = 'repo:active';
  nodes.push({
    id: repoId,
    label: repoName,
    kind: 'repo',
    x: 0,
    y: 0,
    size: 17,
    color: '#38bdf8',
    details: `Repository: ${repoName}`,
  });

  const shownModules = modules.slice(0, 20);
  const shownProcesses = processes.slice(0, 24);

  placeRingNodes(shownModules.length, 2.7, (index, x, y) => {
    const module = shownModules[index];
    const id = `module:${module.name}`;

    nodes.push({
      id,
      label: module.name,
      kind: 'module',
      x,
      y,
      size: clampSize(7 + module.symbols / 35, 7, 15),
      color: '#22c55e',
      details: `${module.name}\n${module.symbols} symbols`,
    });

    edges.push({
      id: `edge:${repoId}->${id}`,
      source: repoId,
      target: id,
      color: '#1f2937',
    });
  });

  placeRingNodes(shownProcesses.length, 5.5, (index, x, y) => {
    const process = shownProcesses[index];
    const id = `process:${process.name}`;

    nodes.push({
      id,
      label: process.name,
      kind: 'process',
      x,
      y,
      size: clampSize(6 + process.steps / 6, 6, 13),
      color: '#f59e0b',
      details: `${process.name}\nType: ${process.type}\nSteps: ${process.steps}`,
    });

    edges.push({
      id: `edge:${repoId}->${id}`,
      source: repoId,
      target: id,
      color: '#1f2937',
    });
  });

  for (const process of shownProcesses) {
    const processId = `process:${process.name}`;
    const linkedModules = matchModules(process.name, shownModules);

    for (const module of linkedModules.slice(0, 2)) {
      const moduleId = `module:${module.name}`;
      edges.push({
        id: `edge:${processId}->${moduleId}`,
        source: processId,
        target: moduleId,
        color: '#334155',
      });
    }
  }

  if (focusSymbol) {
    const symbolId = `symbol:${focusSymbol}`;

    nodes.push({
      id: symbolId,
      label: focusSymbol,
      kind: 'symbol',
      x: 0,
      y: -1.2,
      size: 12,
      color: '#f43f5e',
      details: `Focused symbol: ${focusSymbol}`,
    });

    edges.push({
      id: `edge:${symbolId}->${repoId}`,
      source: symbolId,
      target: repoId,
      label: 'focus',
      color: '#e11d48',
    });

    const symbolMatches = matchModules(focusSymbol, shownModules).slice(0, 4);
    for (const module of symbolMatches) {
      edges.push({
        id: `edge:${symbolId}->module:${module.name}`,
        source: symbolId,
        target: `module:${module.name}`,
        color: '#be123c',
      });
    }
  }

  return {
    title: 'GitNexus Interactive Graph',
    subtitle: `${shownModules.length} modules • ${shownProcesses.length} flows`,
    focusSymbol,
    nodes,
    edges,
  };
}

function placeRingNodes(
  count: number,
  radius: number,
  onNode: (index: number, x: number, y: number) => void,
): void {
  if (count === 0) {
    return;
  }

  for (let index = 0; index < count; index += 1) {
    const angle = (Math.PI * 2 * index) / count;
    const x = Math.cos(angle) * radius;
    const y = Math.sin(angle) * radius;
    onNode(index, x, y);
  }
}

function matchModules(name: string, modules: ModuleSummary[]): ModuleSummary[] {
  const symbolTokens = tokenize(name);
  if (symbolTokens.length === 0) {
    return [];
  }

  return modules
    .map((module) => ({
      module,
      score: scoreOverlap(symbolTokens, tokenize(module.name)),
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.module);
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3 && !STOP_WORDS.has(token));
}

function scoreOverlap(source: string[], target: string[]): number {
  if (target.length === 0) {
    return 0;
  }

  let score = 0;
  for (const token of source) {
    if (target.includes(token)) {
      score += 1;
    }
  }

  return score;
}

function clampSize(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Number.parseFloat(value.toFixed(2))));
}

const STOP_WORDS = new Set([
  'the',
  'with',
  'from',
  'that',
  'this',
  'into',
  'core',
  'data',
  'main',
  'flow',
  'module',
  'process',
]);

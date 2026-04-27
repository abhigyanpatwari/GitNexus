import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import {
  FIXTURES,
  getRelationships,
  getNodesByLabel,
  getNodesByLabelFull,
  runPipelineFromRepo,
  type PipelineResult,
} from './helpers.js';

describe('Python @mcp.tool() detection', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'python-mcp-tools'), () => {});
  }, 60000);

  it('creates Tool nodes for @mcp.tool() decorated functions', () => {
    const tools = getNodesByLabel(result, 'Tool');
    expect(tools).toContain('get_weather');
    expect(tools).toContain('search_docs');
    expect(tools).toContain('explicit_tool');
  });

  it('uses handler functions for HANDLES_TOOL edges', () => {
    const edges = getRelationships(result, 'HANDLES_TOOL');
    expect(edges.length).toBeGreaterThanOrEqual(2);

    const weatherEdge = edges.find((e) => e.target === 'get_weather');
    expect(weatherEdge).toBeDefined();
    expect(weatherEdge!.source).toBe('get_weather');
    expect(weatherEdge!.sourceLabel).toBe('Function');

    const searchEdge = edges.find((e) => e.target === 'search_docs');
    expect(searchEdge).toBeDefined();
    expect(searchEdge!.source).toBe('search_docs');
    expect(searchEdge!.sourceLabel).toBe('Function');
  });

  it('detects exactly 3 tools from the fixture', () => {
    const tools = getNodesByLabel(result, 'Tool');
    expect(tools).toHaveLength(3);
  });

  it('uses Python handler docstrings as tool descriptions', () => {
    const tools = getNodesByLabelFull(result, 'Tool');
    const descriptions = new Map(tools.map((tool) => [tool.name, tool.properties.description]));

    expect(descriptions.get('get_weather')).toBe('Get weather for a city.');
    expect(descriptions.get('search_docs')).toBe('Search documentation.');
    expect(descriptions.get('explicit_tool')).toBe('Explicit description');
  });

  it('links each tool only to flows rooted at its handler', () => {
    const edges = getRelationships(result, 'ENTRY_POINT_OF').filter(
      (e) => e.sourceLabel === 'Tool' && e.targetLabel === 'Process',
    );

    const flowsByTool = new Map<string, string[]>();
    for (const edge of edges) {
      let flows = flowsByTool.get(edge.source);
      if (flows === undefined) {
        flows = [];
        flowsByTool.set(edge.source, flows);
      }
      flows.push(edge.target);
    }

    const weatherFlows = flowsByTool.get('get_weather') ?? [];
    const searchFlows = flowsByTool.get('search_docs') ?? [];

    expect(weatherFlows).toHaveLength(1);
    expect(weatherFlows[0]).toContain('Get_weather');
    expect(weatherFlows[0]).toContain('_format_weather');
    expect(searchFlows).toHaveLength(1);
    expect(searchFlows[0]).toContain('Search_docs');
    expect(searchFlows[0]).toContain('_rank_docs');
    expect(weatherFlows).not.toEqual(searchFlows);
  });
});

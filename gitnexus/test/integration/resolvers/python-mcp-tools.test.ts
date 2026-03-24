import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import {
  FIXTURES, getRelationships, getNodesByLabel,
  runPipelineFromRepo, type PipelineResult,
} from './helpers.js';

describe('Python @mcp.tool() detection', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'python-mcp-tools'),
      () => {},
    );
  }, 60000);

  it('creates Tool nodes for @mcp.tool() decorated functions', () => {
    const tools = getNodesByLabel(result, 'Tool');
    expect(tools).toContain('get_weather');
    expect(tools).toContain('search_docs');
  });

  it('creates HANDLES_TOOL edges from handler file to Tool nodes', () => {
    const edges = getRelationships(result, 'HANDLES_TOOL');
    expect(edges.length).toBeGreaterThanOrEqual(2);

    const weatherEdge = edges.find(e => e.target === 'get_weather');
    expect(weatherEdge).toBeDefined();
    expect(weatherEdge!.sourceFilePath).toContain('server.py');

    const searchEdge = edges.find(e => e.target === 'search_docs');
    expect(searchEdge).toBeDefined();
    expect(searchEdge!.sourceFilePath).toContain('server.py');
  });

  it('detects exactly 2 tools from the fixture', () => {
    const tools = getNodesByLabel(result, 'Tool');
    expect(tools).toHaveLength(2);
  });
});

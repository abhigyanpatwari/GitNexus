/**
 * Unit Tests: MCP Tool Definitions
 *
 * Tests: GITNEXUS_TOOLS from tools.ts
 * - All 20 tools are defined (read tools + write tools + group_*)
 * - Each tool has valid name, description, inputSchema
 * - Required fields are correct
 * - Optional repo parameter is present on tools that need it
 */
import { describe, it, expect } from 'vitest';
import { GITNEXUS_TOOLS } from '../../src/mcp/tools.js';

const GROUP_TOOLS = new Set([
  'group_list',
  'group_sync',
  'group_contracts',
  'group_query',
  'group_status',
]);

describe('GITNEXUS_TOOLS', () => {
  it('exports all tools (11 core + 4 write + 5 group)', () => {
    expect(GITNEXUS_TOOLS).toHaveLength(20);
  });

  it('contains all expected tool names', () => {
    const names = GITNEXUS_TOOLS.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'list_repos',
        'query',
        'cypher',
        'context',
        'detect_changes',
        'rename',
        'impact',
        'api_impact',
        'refresh_repos',
        'get_index_job',
        'analyze_repo',
        'rebuild_embeddings',
      ]),
    );
  });

  it('each tool has name, description, and inputSchema', () => {
    for (const tool of GITNEXUS_TOOLS) {
      expect(tool.name).toBeTruthy();
      expect(typeof tool.name).toBe('string');
      expect(tool.description).toBeTruthy();
      expect(typeof tool.description).toBe('string');
      expect(tool.inputSchema).toBeDefined();
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.inputSchema.properties).toBeDefined();
      expect(Array.isArray(tool.inputSchema.required)).toBe(true);
    }
  });

  it('query tool requires "query" parameter', () => {
    const queryTool = GITNEXUS_TOOLS.find((t) => t.name === 'query')!;
    expect(queryTool.inputSchema.required).toContain('query');
    expect(queryTool.inputSchema.properties.query).toBeDefined();
    expect(queryTool.inputSchema.properties.query.type).toBe('string');
  });

  it('cypher tool requires "query" parameter', () => {
    const cypherTool = GITNEXUS_TOOLS.find((t) => t.name === 'cypher')!;
    expect(cypherTool.inputSchema.required).toContain('query');
  });

  it('context tool has no required parameters', () => {
    const contextTool = GITNEXUS_TOOLS.find((t) => t.name === 'context')!;
    expect(contextTool.inputSchema.required).toEqual([]);
  });

  it('impact tool requires target and direction', () => {
    const impactTool = GITNEXUS_TOOLS.find((t) => t.name === 'impact')!;
    expect(impactTool.inputSchema.required).toContain('target');
    expect(impactTool.inputSchema.required).toContain('direction');
  });

  it('rename tool requires new_name', () => {
    const renameTool = GITNEXUS_TOOLS.find((t) => t.name === 'rename')!;
    expect(renameTool.inputSchema.required).toContain('new_name');
  });

  it('detect_changes tool has no required parameters', () => {
    const detectTool = GITNEXUS_TOOLS.find((t) => t.name === 'detect_changes')!;
    expect(detectTool.inputSchema.required).toEqual([]);
  });

  it('list_repos tool has no parameters', () => {
    const listTool = GITNEXUS_TOOLS.find((t) => t.name === 'list_repos')!;
    expect(Object.keys(listTool.inputSchema.properties)).toHaveLength(0);
    expect(listTool.inputSchema.required).toEqual([]);
  });

  it('per-repo tools have optional repo parameter for backend selection', () => {
    for (const tool of GITNEXUS_TOOLS) {
      if (tool.name === 'list_repos') continue;
      if (GROUP_TOOLS.has(tool.name)) continue;
      if (['refresh_repos', 'get_index_job', 'analyze_repo'].includes(tool.name)) continue;
      expect(tool.inputSchema.properties.repo).toBeDefined();
      expect(tool.inputSchema.properties.repo.type).toBe('string');
      expect(tool.inputSchema.required).not.toContain('repo');
    }
  });

  it('write tools expose the expected required fields', () => {
    const getJobTool = GITNEXUS_TOOLS.find((t) => t.name === 'get_index_job')!;
    expect(getJobTool.inputSchema.required).toEqual(['jobId']);

    const analyzeRepoTool = GITNEXUS_TOOLS.find((t) => t.name === 'analyze_repo')!;
    expect(analyzeRepoTool.inputSchema.properties.path).toBeDefined();
    expect(analyzeRepoTool.inputSchema.properties.url).toBeDefined();
    expect(analyzeRepoTool.inputSchema.properties.force).toBeDefined();
    expect(analyzeRepoTool.inputSchema.properties.embeddings).toBeDefined();

    const rebuildTool = GITNEXUS_TOOLS.find((t) => t.name === 'rebuild_embeddings')!;
    expect(rebuildTool.inputSchema.properties.repo).toBeDefined();
    expect(rebuildTool.inputSchema.properties.provider).toBeDefined();
    expect(rebuildTool.inputSchema.properties.baseUrl).toBeDefined();
    expect(rebuildTool.inputSchema.properties.model).toBeDefined();
    expect(rebuildTool.inputSchema.properties.apiKey).toBeDefined();
    expect(rebuildTool.inputSchema.properties.dimensions).toBeDefined();
    expect(rebuildTool.inputSchema.properties.saveConfig).toBeDefined();
  });

  it('group_contracts has optional repo filter', () => {
    const groupContracts = GITNEXUS_TOOLS.find((t) => t.name === 'group_contracts')!;
    expect(groupContracts.inputSchema.properties).toHaveProperty('repo');
    expect(groupContracts.inputSchema.required).not.toContain('repo');
  });

  it('group tools without backend repo param omit repo property', () => {
    for (const name of ['group_list', 'group_status', 'group_sync', 'group_query'] as const) {
      const tool = GITNEXUS_TOOLS.find((t) => t.name === name)!;
      expect(tool.inputSchema.properties).not.toHaveProperty('repo');
    }
  });

  it('group_query requires name and query', () => {
    const groupQuery = GITNEXUS_TOOLS.find((t) => t.name === 'group_query')!;
    expect(groupQuery.inputSchema.required).toContain('name');
    expect(groupQuery.inputSchema.required).toContain('query');
  });

  it('detect_changes scope has correct enum values', () => {
    const detectTool = GITNEXUS_TOOLS.find((t) => t.name === 'detect_changes')!;
    const scopeProp = detectTool.inputSchema.properties.scope;
    expect(scopeProp.enum).toEqual(['unstaged', 'staged', 'all', 'compare']);
  });

  it('api_impact tool has no required parameters', () => {
    const apiImpactTool = GITNEXUS_TOOLS.find((t) => t.name === 'api_impact')!;
    expect(apiImpactTool).toBeDefined();
    expect(apiImpactTool.inputSchema.required).toEqual([]);
    expect(apiImpactTool.inputSchema.properties.route).toBeDefined();
    expect(apiImpactTool.inputSchema.properties.file).toBeDefined();
    expect(apiImpactTool.inputSchema.properties.repo).toBeDefined();
  });

  it('impact relationTypes is array of strings', () => {
    const impactTool = GITNEXUS_TOOLS.find((t) => t.name === 'impact')!;
    const relProp = impactTool.inputSchema.properties.relationTypes;
    expect(relProp.type).toBe('array');
    expect(relProp.items).toEqual({ type: 'string' });
  });

  it('route_map description defers to api_impact for pre-change analysis', () => {
    const routeMapTool = GITNEXUS_TOOLS.find((t) => t.name === 'route_map')!;
    expect(routeMapTool.description).toContain('api_impact');
    expect(routeMapTool.description).toContain('pre-change analysis');
  });

  it('shape_check description defers to api_impact for pre-change analysis', () => {
    const shapeCheckTool = GITNEXUS_TOOLS.find((t) => t.name === 'shape_check')!;
    expect(shapeCheckTool.description).toContain('api_impact');
    expect(shapeCheckTool.description).toContain('pre-change analysis');
  });
});

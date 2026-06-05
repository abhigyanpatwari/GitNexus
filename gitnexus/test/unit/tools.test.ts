/**
 * Unit Tests: MCP Tool Definitions
 *
 * Tests: GITNEXUS_TOOLS from tools.ts
 * - All 10 tools are defined
 * - Each tool has valid name, description, inputSchema
 * - Required fields are correct
 * - Optional repo parameter is present on tools that need it
 * - Cross-repo 'repos' parameter on query, context, impact, cypher, impacted_endpoints
 */
import { describe, it, expect } from 'vitest';
import { GITNEXUS_TOOLS, type ToolDefinition } from '../../src/mcp/tools.js';

describe('GITNEXUS_TOOLS', () => {
  it('exports exactly 10 tools', () => {
    expect(GITNEXUS_TOOLS).toHaveLength(10);
  });

  it('contains all expected tool names', () => {
    const names = GITNEXUS_TOOLS.map(t => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'list_repos', 'query', 'cypher', 'context',
        'detect_changes', 'rename', 'impact', 'endpoints', 'document-endpoint',
        'impacted_endpoints',
      ])
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
    const queryTool = GITNEXUS_TOOLS.find(t => t.name === 'query')!;
    expect(queryTool.inputSchema.required).toContain('query');
    expect(queryTool.inputSchema.properties.query).toBeDefined();
    expect(queryTool.inputSchema.properties.query.type).toBe('string');
  });

  it('cypher tool requires "query" parameter', () => {
    const cypherTool = GITNEXUS_TOOLS.find(t => t.name === 'cypher')!;
    expect(cypherTool.inputSchema.required).toContain('query');
  });

  it('context tool has no required parameters', () => {
    const contextTool = GITNEXUS_TOOLS.find(t => t.name === 'context')!;
    expect(contextTool.inputSchema.required).toEqual([]);
  });

  it('impact tool requires target and direction', () => {
    const impactTool = GITNEXUS_TOOLS.find(t => t.name === 'impact')!;
    expect(impactTool.inputSchema.required).toContain('target');
    expect(impactTool.inputSchema.required).toContain('direction');
  });

  it('rename tool requires new_name', () => {
    const renameTool = GITNEXUS_TOOLS.find(t => t.name === 'rename')!;
    expect(renameTool.inputSchema.required).toContain('new_name');
  });

  it('detect_changes tool has no required parameters', () => {
    const detectTool = GITNEXUS_TOOLS.find(t => t.name === 'detect_changes')!;
    expect(detectTool.inputSchema.required).toEqual([]);
  });

  it('list_repos tool has no parameters', () => {
    const listTool = GITNEXUS_TOOLS.find(t => t.name === 'list_repos')!;
    expect(Object.keys(listTool.inputSchema.properties)).toHaveLength(0);
    expect(listTool.inputSchema.required).toEqual([]);
  });

  it('all tools except list_repos have optional repo parameter', () => {
    for (const tool of GITNEXUS_TOOLS) {
      if (tool.name === 'list_repos') continue;
      expect(tool.inputSchema.properties.repo).toBeDefined();
      expect(tool.inputSchema.properties.repo.type).toBe('string');
      // repo should never be required
      expect(tool.inputSchema.required).not.toContain('repo');
    }
  });

  it('detect_changes scope has correct enum values', () => {
    const detectTool = GITNEXUS_TOOLS.find(t => t.name === 'detect_changes')!;
    const scopeProp = detectTool.inputSchema.properties.scope;
    expect(scopeProp.enum).toEqual(['unstaged', 'staged', 'all', 'compare']);
  });

  it('impact relationTypes is array of strings', () => {
    const impactTool = GITNEXUS_TOOLS.find(t => t.name === 'impact')!;
    const relProp = impactTool.inputSchema.properties.relationTypes;
    expect(relProp.type).toBe('array');
    expect(relProp.items).toEqual({ type: 'string' });
  });

  it('endpoints tool has method enum and optional path', () => {
    const endpointsTool = GITNEXUS_TOOLS.find(t => t.name === 'endpoints')!;
    expect(endpointsTool).toBeDefined();
    expect(endpointsTool.inputSchema.properties.method.enum).toEqual(['GET', 'POST', 'PUT', 'DELETE', 'PATCH']);
    expect(endpointsTool.inputSchema.required).toEqual([]);
  });

  // WI-5: Cross-repo 'repos' parameter tests
  it('query tool has optional repos array parameter for cross-repo queries', () => {
    const queryTool = GITNEXUS_TOOLS.find(t => t.name === 'query')!;
    expect(queryTool.inputSchema.properties.repos).toBeDefined();
    expect(queryTool.inputSchema.properties.repos.type).toBe('array');
    expect(queryTool.inputSchema.properties.repos.items).toEqual({ type: 'string' });
    expect(queryTool.inputSchema.required).not.toContain('repos');
  });

  it('cypher tool has optional repos array parameter for cross-repo queries', () => {
    const cypherTool = GITNEXUS_TOOLS.find(t => t.name === 'cypher')!;
    expect(cypherTool.inputSchema.properties.repos).toBeDefined();
    expect(cypherTool.inputSchema.properties.repos.type).toBe('array');
    expect(cypherTool.inputSchema.properties.repos.items).toEqual({ type: 'string' });
    expect(cypherTool.inputSchema.required).not.toContain('repos');
  });

  it('context tool has optional repos array parameter for cross-repo queries', () => {
    const contextTool = GITNEXUS_TOOLS.find(t => t.name === 'context')!;
    expect(contextTool.inputSchema.properties.repos).toBeDefined();
    expect(contextTool.inputSchema.properties.repos.type).toBe('array');
    expect(contextTool.inputSchema.properties.repos.items).toEqual({ type: 'string' });
    expect(contextTool.inputSchema.required).not.toContain('repos');
  });

  it('impact tool has optional repos array parameter for cross-repo queries', () => {
    const impactTool = GITNEXUS_TOOLS.find(t => t.name === 'impact')!;
    expect(impactTool.inputSchema.properties.repos).toBeDefined();
    expect(impactTool.inputSchema.properties.repos.type).toBe('array');
    expect(impactTool.inputSchema.properties.repos.items).toEqual({ type: 'string' });
    expect(impactTool.inputSchema.required).not.toContain('repos');
  });

  it('endpoints tool has optional repos array parameter for cross-repo queries', () => {
    // #12: the endpoints tool supports cross-repo filtering via repos[]; the
    // backend already routes params.repos through callToolMultiRepo. PR #148
    // exposed the schema param so MCP clients can discover it.
    const endpointsTool = GITNEXUS_TOOLS.find(t => t.name === 'endpoints')!;
    expect(endpointsTool.inputSchema.properties.repos).toBeDefined();
    expect(endpointsTool.inputSchema.properties.repos.type).toBe('array');
    expect(endpointsTool.inputSchema.properties.repos.items).toEqual({ type: 'string' });
    expect(endpointsTool.inputSchema.required).not.toContain('repos');
  });

  it('tools without cross-repo support do not have repos parameter', () => {
    const toolsWithoutRepos = ['detect_changes', 'rename', 'document-endpoint', 'list_repos'];
    for (const toolName of toolsWithoutRepos) {
      const tool = GITNEXUS_TOOLS.find(t => t.name === toolName)!;
      expect(tool).toBeDefined();
      // These tools should NOT have repos parameter
      if (toolName !== 'list_repos') {
        expect(tool.inputSchema.properties.repos).toBeUndefined();
      }
    }
  });
});

// ─── WI-7: impacted_endpoints tool registration ───────────────────────

describe('impacted_endpoints tool registration', () => {
  const tool = GITNEXUS_TOOLS.find(t => t.name === 'impacted_endpoints')!;

  it('tool exists in GITNEXUS_TOOLS', () => {
    expect(tool).toBeDefined();
    expect(tool.name).toBe('impacted_endpoints');
  });

  it('has valid inputSchema with type object and properties', () => {
    expect(tool.inputSchema.type).toBe('object');
    expect(tool.inputSchema.properties).toBeDefined();
    expect(typeof tool.inputSchema.properties).toBe('object');
  });

  it('defines base_ref property', () => {
    expect(tool.inputSchema.properties.base_ref).toBeDefined();
    expect(tool.inputSchema.properties.base_ref.type).toBe('string');
  });

  it('repo parameter is optional (not in required array)', () => {
    expect(tool.inputSchema.properties.repo).toBeDefined();
    expect(tool.inputSchema.required).not.toContain('repo');
  });

  it('description is non-empty string', () => {
    expect(tool.description).toBeTruthy();
    expect(typeof tool.description).toBe('string');
    expect(tool.description.length).toBeGreaterThan(0);
  });

  it('repos parameter is defined for cross-repo queries', () => {
    expect(tool.inputSchema.properties.repos).toBeDefined();
    expect(tool.inputSchema.properties.repos.type).toBe('array');
    expect(tool.inputSchema.properties.repos.items).toEqual({ type: 'string' });
    expect(tool.inputSchema.required).not.toContain('repos');
  });
});

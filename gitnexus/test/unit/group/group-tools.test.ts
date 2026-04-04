// gitnexus/test/unit/group/group-tools.test.ts
import { describe, it, expect } from 'vitest';
import { GITNEXUS_TOOLS } from '../../../src/mcp/tools.js';

const GROUP_TOOL_NAMES = [
  'group_list',
  'group_sync',
  'group_contracts',
  'group_impact',
  'group_query',
  'group_status',
];

describe('Group MCP tools', () => {
  it('all 6 group tools are registered', () => {
    for (const name of GROUP_TOOL_NAMES) {
      const tool = GITNEXUS_TOOLS.find((t) => t.name === name);
      expect(tool, `tool ${name} should be registered`).toBeDefined();
      expect(tool!.description.length).toBeGreaterThan(10);
      expect(tool!.inputSchema.type).toBe('object');
    }
  });

  it('group_impact requires name, target, repo', () => {
    const tool = GITNEXUS_TOOLS.find((t) => t.name === 'group_impact')!;
    expect(tool.inputSchema.required).toContain('name');
    expect(tool.inputSchema.required).toContain('target');
    expect(tool.inputSchema.required).toContain('repo');
  });

  it('group_sync requires name', () => {
    const tool = GITNEXUS_TOOLS.find((t) => t.name === 'group_sync')!;
    expect(tool.inputSchema.required).toContain('name');
  });

  it('group_impact has crossDepth param with max 1 note in description', () => {
    const tool = GITNEXUS_TOOLS.find((t) => t.name === 'group_impact')!;
    const crossDepth = tool.inputSchema.properties.crossDepth as { description?: string };
    expect(crossDepth).toBeDefined();
    expect(crossDepth.description).toContain('capped at 1');
  });
});

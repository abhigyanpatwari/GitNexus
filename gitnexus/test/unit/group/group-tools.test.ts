// gitnexus/test/unit/group/group-tools.test.ts
import { describe, it, expect } from 'vitest';
import { GITNEXUS_TOOLS } from '../../../src/mcp/tools.js';

const GROUP_TOOL_NAMES = ['group_list', 'group_sync'];

describe('Group MCP tools', () => {
  it('group_list and group_sync are registered', () => {
    for (const name of GROUP_TOOL_NAMES) {
      const tool = GITNEXUS_TOOLS.find((t) => t.name === name);
      expect(tool, `tool ${name} should be registered`).toBeDefined();
      expect(tool!.description.length).toBeGreaterThan(10);
      expect(tool!.inputSchema.type).toBe('object');
    }
  });

  it('group_sync requires name', () => {
    const tool = GITNEXUS_TOOLS.find((t) => t.name === 'group_sync')!;
    expect(tool.inputSchema.required).toContain('name');
  });

  it('group_sync no longer advertises skipEmbeddings, and still advertises exactOnly', () => {
    // `skipEmbeddings` named a BM25/embedding cascade that was never built —
    // the handler read the parameter and every value took the same code path,
    // so the schema advertised a choice an agent could not actually make. It is
    // gone from `SyncOptions`, the CLI and here.
    //
    // `exactOnly` is asserted in the same test on purpose: it is the parameter
    // NEXT TO the deleted one, it survived, and it now does what it says (see
    // sync-exact-only.test.ts). Pinning only the absence would stay green if a
    // later edit removed the wrong one of the two.
    const tool = GITNEXUS_TOOLS.find((t) => t.name === 'group_sync')!;
    expect(tool.inputSchema.properties).not.toHaveProperty('skipEmbeddings');
    // `verbose` gates diagnostics on the server's logger, which an MCP caller
    // cannot observe. Advertising it would promise a knob whose effect is
    // invisible to the only audience that reads this schema.
    expect(tool.inputSchema.properties).not.toHaveProperty('verbose');
    expect(tool.inputSchema.properties.exactOnly).toMatchObject({ type: 'boolean' });
  });
});

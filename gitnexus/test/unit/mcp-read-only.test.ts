import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMCPServer } from '../../src/mcp/server.js';
import type { LocalBackend } from '../../src/mcp/local/local-backend.js';

const READ_ONLY_TOOLS = [
  'api_impact',
  'check',
  'context',
  'detect_changes',
  'explain',
  'grep',
  'impact',
  'list_repos',
  'pdg_query',
  'query',
  'read_file',
  'rename',
  'route_map',
  'shape_check',
  'tool_map',
  'trace',
];

function createMockBackend() {
  return {
    callTool: vi.fn().mockResolvedValue({ result: 'ok' }),
    listRepos: vi.fn().mockResolvedValue([]),
    countRepos: vi.fn().mockResolvedValue(0),
    resolveRepo: vi
      .fn()
      .mockResolvedValue({ name: 'test', repoPath: '/tmp/test', lastCommit: 'abc' }),
    getContext: vi.fn().mockReturnValue(null),
    queryClusters: vi.fn().mockResolvedValue({ clusters: [] }),
    queryProcesses: vi.fn().mockResolvedValue({ processes: [] }),
    queryClusterDetail: vi.fn().mockResolvedValue({ error: 'not found' }),
    queryProcessDetail: vi.fn().mockResolvedValue({ error: 'not found' }),
    readGroupContractsResource: vi.fn().mockResolvedValue('contracts'),
    readGroupStatusResource: vi.fn().mockResolvedValue('status'),
    disconnect: vi.fn().mockResolvedValue(undefined),
  };
}

async function connect(backend = createMockBackend()) {
  const server = createMCPServer(backend as unknown as LocalBackend);
  const client = new Client({ name: 'read-only-test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    backend,
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

function enableReadOnly(): void {
  vi.stubEnv('GITNEXUS_MCP_READ_ONLY', '1');
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('MCP read-only mode', () => {
  it('lists rename as a preview-only tool and no longer lists rename_preview', async () => {
    enableReadOnly();
    const session = await connect();
    try {
      const { tools } = await session.client.listTools();
      const names = tools.map((tool) => tool.name);
      expect(names).toContain('rename');
      expect(names).not.toContain('rename_preview');
      const rename = tools.find((tool) => tool.name === 'rename');
      expect(rename?.annotations).toEqual({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
      // dry_run survives only as a constant `true`; branch stays unadvertised.
      expect(rename?.inputSchema.properties).toMatchObject({
        dry_run: { type: 'boolean', const: true, default: true },
      });
      expect(rename?.inputSchema.properties).not.toHaveProperty('branch');
      expect(rename?.inputSchema.required).toEqual(['new_name']);
      expect(rename?.description).toMatch(/preview-only/i);
      expect(rename?.description).not.toMatch(/dry_run:false applies/);
    } finally {
      await session.close();
    }
  });

  it.each([
    ['omitted', {}],
    ['true', { dry_run: true }],
  ])('forwards a read-only rename when dry_run is %s', async (_label, extra) => {
    enableReadOnly();
    const session = await connect();
    try {
      const arguments_ = {
        symbol_uid: 'Method:src/writer.ts:Writer.close#0',
        new_name: 'closeWriter',
        ...extra,
      };
      const response = await session.client.callTool({ name: 'rename', arguments: arguments_ });
      expect(response.isError).not.toBe(true);
      expect(session.backend.callTool).toHaveBeenCalledTimes(1);
      expect(session.backend.callTool).toHaveBeenCalledWith('rename', arguments_);
      const text = (response.content[0] as { text: string }).text;
      expect(text).toContain('MCP read-only mode cannot apply it');
      expect(text).not.toContain('dry_run: false');
      expect(text).not.toContain('detect_changes');
    } finally {
      await session.close();
    }
  });

  it.each([
    ['false', false],
    ['the string "false"', 'false'],
    ['the string "true"', 'true'],
    ['zero', 0],
    ['one', 1],
    ['null', null],
    ['an object', {}],
  ])('rejects a read-only rename when dry_run is %s before dispatch', async (_label, dryRun) => {
    enableReadOnly();
    const session = await connect();
    try {
      const response = await session.client.callTool({
        name: 'rename',
        arguments: { symbol_uid: 'Function:src/a.ts:a', new_name: 'b', dry_run: dryRun },
      });
      expect(response.isError).toBe(true);
      expect((response.content[0] as { text: string }).text).toMatch(
        /dry_run.*omitted or true.*read-only mode/i,
      );
      expect(session.backend.callTool).not.toHaveBeenCalled();
    } finally {
      await session.close();
    }
  });

  it('keeps branch pins and group routing out of a read-only rename', async () => {
    enableReadOnly();
    const session = await connect();
    try {
      for (const extra of [{ branch: 'main' }, { repo: '@portfolio/service-a' }]) {
        const response = await session.client.callTool({
          name: 'rename',
          arguments: { symbol_uid: 'Function:src/a.ts:a', new_name: 'b', ...extra },
        });
        expect(response.isError).toBe(true);
      }
      expect(session.backend.callTool).not.toHaveBeenCalled();
    } finally {
      await session.close();
    }
  });

  it('rejects the removed rename_preview name before backend dispatch', async () => {
    enableReadOnly();
    const session = await connect();
    try {
      const response = await session.client.callTool({
        name: 'rename_preview',
        arguments: { new_name: 'b' },
      });
      expect(response.isError).toBe(true);
      expect((response.content[0] as { text: string }).text).toMatch(/read-only mode/i);
      expect(session.backend.callTool).not.toHaveBeenCalled();
    } finally {
      await session.close();
    }
  });

  it('advertises repo as optional when the read-only default can come from cwd', async () => {
    enableReadOnly();
    const backend = {
      ...createMockBackend(),
      countRepos: vi.fn().mockResolvedValue(2),
      cachedRepoCount: vi.fn().mockReturnValue(2),
      selectToolRepository: vi
        .fn()
        .mockResolvedValue({ name: 'alpha', repoPath: '/tmp/alpha', lastCommit: 'abc' }),
    };
    const session = await connect(backend);
    try {
      const { tools } = await session.client.listTools();
      // Read-only rename can only preview, so it follows the read-tool omission rule.
      expect(tools.find((tool) => tool.name === 'rename')?.inputSchema.required).not.toContain(
        'repo',
      );
    } finally {
      await session.close();
    }
  });

  it('discovers only proven single-repository read tools', async () => {
    enableReadOnly();
    const session = await connect();
    try {
      const response = await session.client.listTools();
      expect(response.tools.map((tool) => tool.name).sort()).toEqual(READ_ONLY_TOOLS);
      for (const tool of response.tools) {
        expect(tool.description).not.toMatch(/GROUP MODE|CROSS-REPO|@<groupName>/);
        const properties = tool.inputSchema.properties as Record<
          string,
          { description?: string } | undefined
        >;
        const repo = properties.repo;
        if (repo) expect(repo.description).not.toContain('@group');
        expect(properties.subgroup).toBeUndefined();
        expect(properties.crossDepth).toBeUndefined();
      }
    } finally {
      await session.close();
    }
  });

  it.each(['group_sync', 'group_list', 'unknown_dynamic_tool'])(
    'rejects hidden tool %s before backend dispatch',
    async (name) => {
      enableReadOnly();
      const session = await connect();
      try {
        const response = await session.client.callTool({ name, arguments: {} });
        expect(response.isError).toBe(true);
        expect(response.content[0]).toMatchObject({ type: 'text' });
        expect((response.content[0] as { text: string }).text).toMatch(/read-only mode/i);
        expect(session.backend.callTool).not.toHaveBeenCalled();
      } finally {
        await session.close();
      }
    },
  );

  it.each(['CREATE (n:Injected)', 'MATCH (n) DETACH DELETE n', 'DROP TABLE Node'])(
    'rejects raw cypher before backend dispatch: %s',
    async (statement) => {
      enableReadOnly();
      const session = await connect();
      try {
        const response = await session.client.callTool({
          name: 'cypher',
          arguments: { repo: 'test', statement },
        });
        expect(response.isError).toBe(true);
        expect((response.content[0] as { text: string }).text).toMatch(/read-only mode/i);
        expect(session.backend.callTool).not.toHaveBeenCalled();
      } finally {
        await session.close();
      }
    },
  );

  it.each(['query', 'context', 'impact', 'trace'])(
    'rejects @group routing through %s before backend dispatch',
    async (name) => {
      enableReadOnly();
      const session = await connect();
      try {
        const response = await session.client.callTool({
          name,
          arguments: { repo: '  @portfolio/service-a  ', target: 'auth', name: 'auth' },
        });
        expect(response.isError).toBe(true);
        expect((response.content[0] as { text: string }).text).toMatch(/group.*read-only mode/i);
        expect(session.backend.callTool).not.toHaveBeenCalled();
      } finally {
        await session.close();
      }
    },
  );

  it.each([
    ['impact', { target: 'auth', direction: 'upstream', crossDepth: 5 }],
    ['impact', { target: 'auth', direction: 'upstream', subgroup: 'services' }],
  ])('rejects group-only arguments before dispatch #%#: %s %o', async (name, args) => {
    enableReadOnly();
    const session = await connect();
    try {
      const response = await session.client.callTool({ name, arguments: args });
      expect(response.isError).toBe(true);
      expect((response.content[0] as { text: string }).text).toMatch(/read-only mode/i);
      expect(session.backend.callTool).not.toHaveBeenCalled();
    } finally {
      await session.close();
    }
  });

  it.each(['search', 'explore', 'overview'])('preserves legacy read alias %s', async (name) => {
    enableReadOnly();
    const session = await connect();
    try {
      const response = await session.client.callTool({ name, arguments: { repo: 'test' } });
      expect(response.isError).not.toBe(true);
      expect(session.backend.callTool).toHaveBeenCalledWith(name, { repo: 'test' });
    } finally {
      await session.close();
    }
  });

  it.each([
    'gitnexus://group/acme/status',
    'GITNEXUS://GROUP/acme/status',
    'gitnexus://user@group/acme/status',
  ])('omits group resource templates and rejects disguised group resource read %s', async (uri) => {
    enableReadOnly();
    const session = await connect();
    try {
      const templates = await session.client.listResourceTemplates();
      expect(templates.resourceTemplates.map((item) => item.uriTemplate)).not.toContain(
        'gitnexus://group/{name}/contracts',
      );
      expect(templates.resourceTemplates.map((item) => item.uriTemplate)).not.toContain(
        'gitnexus://group/{name}/status',
      );

      const resource = await session.client.readResource({ uri });
      expect(resource.contents[0]).toMatchObject({ mimeType: 'text/plain' });
      expect((resource.contents[0] as { text: string }).text).toMatch(/group.*read-only mode/i);
      expect(session.backend.readGroupStatusResource).not.toHaveBeenCalled();
    } finally {
      await session.close();
    }
  });

  it('leaves normal-mode discovery and dispatch unchanged', async () => {
    const session = await connect();
    try {
      const tools = await session.client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining(['cypher', 'rename', 'group_list', 'group_sync']),
      );
      expect(tools.tools.map((tool) => tool.name)).not.toContain('rename_preview');
      expect(tools.tools).toHaveLength(19);

      const response = await session.client.callTool({
        name: 'cypher',
        arguments: { statement: 'MATCH (n) RETURN n LIMIT 1' },
      });
      expect(response.isError).not.toBe(true);
      expect(session.backend.callTool).toHaveBeenCalledWith('cypher', {
        statement: 'MATCH (n) RETURN n LIMIT 1',
      });
    } finally {
      await session.close();
    }
  });

  it('keeps ordinary-mode rename destructive with a boolean dry_run', async () => {
    const session = await connect();
    try {
      const { tools } = await session.client.listTools();
      const rename = tools.find((tool) => tool.name === 'rename');
      expect(rename?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
      const dryRun = (rename?.inputSchema.properties as Record<string, object>).dry_run;
      expect(dryRun).toMatchObject({ type: 'boolean', default: true });
      expect(dryRun).not.toHaveProperty('const');
      expect(rename?.description).toMatch(/dry_run:false requires the plan_token/);
      expect((rename?.inputSchema.properties as Record<string, object>).plan_token).toMatchObject({
        type: 'string',
      });
    } finally {
      await session.close();
    }
  });

  it.each([
    [
      'omitted',
      {},
      'dry_run: false, plan_token: "<plan_token from this preview>", repo: "test"',
      'detect_changes',
    ],
    [
      'true',
      { dry_run: true },
      'dry_run: false, plan_token: "<plan_token from this preview>", repo: "test"',
      'detect_changes',
    ],
    [
      'false',
      { dry_run: false, plan_token: 'reviewed-preview-token' },
      'detect_changes({repo: "test"})',
      'dry_run: false',
    ],
  ])(
    'forwards ordinary-mode rename as sent and hints the right next step when dry_run is %s',
    async (_label, extra, expectedHint, forbiddenHint) => {
      const session = await connect();
      try {
        const isApply = 'dry_run' in extra && extra.dry_run === false;
        session.backend.callTool.mockResolvedValueOnce(
          isApply
            ? { status: 'success', applied: true, application_status: 'applied' }
            : { status: 'success', plan_token: 'reviewed-preview-token' },
        );
        const arguments_ = {
          symbol_uid: 'Function:src/a.ts:a',
          new_name: 'b',
          repo: 'test',
          ...extra,
        };
        if (isApply) expect(arguments_).toHaveProperty('plan_token', expect.any(String));
        const response = await session.client.callTool({ name: 'rename', arguments: arguments_ });
        expect(response.isError).not.toBe(true);
        expect(session.backend.callTool).toHaveBeenCalledWith('rename', arguments_);
        const text = (response.content[0] as { text: string }).text;
        expect(text).toContain(expectedHint);
        expect(text).not.toContain(forbiddenHint);
      } finally {
        await session.close();
      }
    },
  );

  it('requests a fresh preview when ordinary-mode apply has no plan token', async () => {
    const session = await connect();
    try {
      session.backend.callTool.mockResolvedValueOnce({
        status: 'error',
        code: 'plan_required',
        error: 'Applying a rename requires the plan_token from a reviewed preview.',
      });
      const arguments_ = {
        symbol_uid: 'Function:src/a.ts:a',
        new_name: 'b',
        repo: 'test',
        dry_run: false,
      };
      const response = await session.client.callTool({ name: 'rename', arguments: arguments_ });
      expect(session.backend.callTool).toHaveBeenCalledWith('rename', arguments_);
      const text = (response.content[0] as { text: string }).text;
      expect(text).toContain('plan_required');
      expect(text).toContain('No successful apply was confirmed');
      expect(text).toContain('request and review a fresh rename preview');
      expect(text).not.toContain('detect_changes');
    } finally {
      await session.close();
    }
  });

  it.each([
    ['omitted', {}],
    ['true', { dry_run: true }],
    ['false', { dry_run: false }],
  ])('routes ordinary-mode rename by explicit repo when dry_run is %s', async (_label, extra) => {
    const session = await connect();
    try {
      const arguments_ = {
        symbol_uid: 'Function:src/a.ts:a',
        new_name: 'b',
        repo: 'beta',
        ...extra,
      };
      await session.client.callTool({ name: 'rename', arguments: arguments_ });
      expect(session.backend.callTool).toHaveBeenCalledWith(
        'rename',
        expect.objectContaining({ repo: 'beta' }),
      );
    } finally {
      await session.close();
    }
  });

  it('scrubs hidden tools and group routes from generated resource discovery', async () => {
    enableReadOnly();
    const backend = createMockBackend();
    backend.listRepos.mockResolvedValue([
      {
        name: 'test',
        path: '/tmp/test',
        indexedAt: '2026-01-01',
        lastCommit: 'abc',
        stats: { nodes: 2, edges: 1, processes: 0 },
      },
    ]);
    backend.getContext.mockReturnValue({
      projectName: 'test',
      stats: { fileCount: 1, functionCount: 2, processCount: 0 },
    });
    const session = await connect(backend);
    try {
      for (const uri of ['gitnexus://setup', 'gitnexus://repo/test/context']) {
        const resource = await session.client.readResource({ uri });
        const text = (resource.contents[0] as { text: string }).text;
        expect(text).not.toMatch(/(?:^\s*-\s+|^\|\s*`)cypher(?::|`)/mu);
        expect(text).not.toContain('rename_preview');
        // rename stays listed, restated as the preview-only contract.
        expect(text).toMatch(
          /(?:^\s*-\s+rename: |^\| `rename` \| )Read-only semantic rename preview/mu,
        );
        expect(text).not.toMatch(/rename.*dry_run: false applies/u);
        expect(text).not.toContain('gitnexus://group/');
      }
    } finally {
      await session.close();
    }
  });

  it.each(['true', 'banana'])('fails startup for malformed read-only mode %s', (value) => {
    vi.stubEnv('GITNEXUS_MCP_READ_ONLY', value);
    expect(() => createMCPServer(createMockBackend() as unknown as LocalBackend)).toThrow(
      /GITNEXUS_MCP_READ_ONLY must be 0 or 1/i,
    );
  });
});

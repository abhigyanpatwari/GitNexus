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
  'impact',
  'list_repos',
  'pdg_query',
  'query',
  'route_map',
  'shape_check',
  'tool_map',
  'trace',
];

function createMockBackend() {
  return {
    callTool: vi.fn().mockResolvedValue({ result: 'ok' }),
    listRepos: vi.fn().mockResolvedValue([]),
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

  it.each(['rename', 'group_sync', 'group_list', 'unknown_dynamic_tool'])(
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
  ])('rejects group-only arguments before backend dispatch: %s %o', async (name, args) => {
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
        expect(text).not.toMatch(/(?:^\s*-\s+|^\|\s*`)(?:rename|cypher)/mu);
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

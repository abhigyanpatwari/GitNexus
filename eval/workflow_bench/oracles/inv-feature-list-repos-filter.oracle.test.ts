import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';

import { LocalBackend } from '../gitnexus/src/mcp/local/local-backend.js';
import { createMCPServer } from '../gitnexus/src/mcp/server.js';
import { McpRepositoryPolicy } from '../gitnexus/src/mcp/repository-policy.js';

const repositories = [
  { name: 'Alpha', path: '/repos/z-alpha' },
  { name: 'alphabet', path: '/repos/a-alphabet' },
  { name: 'Beta', path: '/repos/beta' },
];

async function withMcpClient(check: (client: Client) => Promise<void>): Promise<void> {
  const backend = Object.create(LocalBackend.prototype) as LocalBackend;
  vi.spyOn(backend, 'listRepos').mockImplementation(async () =>
    repositories.map((repo) => ({ ...repo, indexedAt: '', lastCommit: '' })),
  );
  // Schema discovery must not probe a real registry or choose a cwd default.
  vi.spyOn(backend, 'countRepos').mockResolvedValue(0);
  const server = createMCPServer(backend, { repositoryPolicy: McpRepositoryPolicy.unrestricted() });
  const client = new Client({ name: 'list-repos-oracle', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    await check(client);
  } finally {
    await client.close();
    await server.close();
  }
}

async function listRepos(client: Client, args: Record<string, unknown>) {
  const response = CallToolResultSchema.parse(
    await client.callTool({ name: 'list_repos', arguments: args }),
  );
  expect(response.isError, JSON.stringify(response)).not.toBe(true);
  const text = response.content.find((item) => item.type === 'text');
  if (!text || text.type !== 'text') throw new Error('Expected an MCP text response');
  // The server may append a next-step hint after the JSON payload.
  return JSON.parse(text.text.split('\n\n---')[0]);
}

describe('hidden oracle: list_repos name_contains', () => {
  it('filters case-insensitively before pagination and reports filtered totals', async () =>
    withMcpClient(async (client) => {
      // Exercise the requested MCP surface: a valid implementation may live in
      // the policy wrapper rather than LocalBackend.callTool (#3500).
      const first = await listRepos(client, {
        name_contains: 'ALP',
        limit: 1,
        offset: 0,
      });
      expect(first.repositories.map((repo: { name: string }) => repo.name)).toEqual(['Alpha']);
      expect(first.pagination).toMatchObject({
        total: 2,
        returned: 1,
        hasMore: true,
        nextOffset: 1,
      });

      const second = await listRepos(client, {
        name_contains: 'alp',
        limit: 1,
        offset: 1,
      });
      expect(second.repositories.map((repo: { name: string }) => repo.name)).toEqual(['alphabet']);
      expect(second.pagination).toMatchObject({ total: 2, returned: 1, hasMore: false });
      expect(second.pagination).not.toHaveProperty('nextOffset');

      const absent = await listRepos(client, { name_contains: 'missing' });
      expect(absent.repositories).toEqual([]);
      expect(absent.pagination).toMatchObject({ total: 0, returned: 0, hasMore: false });
      expect(absent.pagination).not.toHaveProperty('nextOffset');

      const unfiltered = await listRepos(client, {});
      expect(unfiltered.repositories.map((repo: { name: string }) => repo.name)).toEqual([
        'Alpha',
        'alphabet',
        'Beta',
      ]);
      expect(unfiltered.pagination).toMatchObject({ total: 3, returned: 3, hasMore: false });
    }));

  it('advertises the optional filter on the MCP tool schema', async () =>
    withMcpClient(async (client) => {
      const { tools } = await client.listTools();
      const tool = tools.find((candidate) => candidate.name === 'list_repos');
      expect(tool?.inputSchema.properties?.name_contains).toMatchObject({ type: 'string' });
      expect(tool?.inputSchema.required ?? []).not.toContain('name_contains');
    }));
});

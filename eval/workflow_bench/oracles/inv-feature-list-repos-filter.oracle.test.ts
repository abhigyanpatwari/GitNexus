import { describe, expect, it, vi } from 'vitest';

import { LocalBackend } from '../gitnexus/src/mcp/local/local-backend.js';
import { MCP_TOOLS } from '../gitnexus/src/mcp/tools.js';

const repositories = [
  { name: 'Alpha', path: '/repos/z-alpha' },
  { name: 'alphabet', path: '/repos/a-alphabet' },
  { name: 'Beta', path: '/repos/beta' },
];

describe('hidden oracle: list_repos name_contains', () => {
  it('filters case-insensitively before pagination and reports filtered totals', async () => {
    const backend = Object.create(LocalBackend.prototype) as LocalBackend & {
      listRepos: () => Promise<typeof repositories>;
    };
    backend.listRepos = vi.fn().mockResolvedValue(repositories.map((repo) => ({ ...repo })));

    const first = await backend.listReposPage({
      name_contains: 'ALP',
      limit: 1,
      offset: 0,
    } as never);
    expect(first.repositories.map((repo) => repo.name)).toEqual(['Alpha']);
    expect(first.pagination).toMatchObject({
      total: 2,
      returned: 1,
      hasMore: true,
      nextOffset: 1,
    });

    const second = await backend.listReposPage({
      name_contains: 'alp',
      limit: 1,
      offset: 1,
    } as never);
    expect(second.repositories.map((repo) => repo.name)).toEqual(['alphabet']);
    expect(second.pagination).toMatchObject({ total: 2, returned: 1, hasMore: false });
    expect(second.pagination).not.toHaveProperty('nextOffset');
  });

  it('advertises the optional filter on the MCP tool schema', () => {
    const tool = MCP_TOOLS.find((candidate) => candidate.name === 'list_repos');
    expect(tool?.inputSchema.properties).toHaveProperty('name_contains');
    expect(tool?.inputSchema.required ?? []).not.toContain('name_contains');
  });
});

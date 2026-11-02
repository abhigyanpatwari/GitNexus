import { describe, expect, it, vi } from 'vitest';

import { LocalBackend } from '../gitnexus/src/mcp/local/local-backend.js';
import { GITNEXUS_TOOLS } from '../gitnexus/src/mcp/tools.js';

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

    const first = await backend.callTool('list_repos', {
      name_contains: 'ALP',
      limit: 1,
      offset: 0,
    });
    expect(first.repositories.map((repo) => repo.name)).toEqual(['Alpha']);
    expect(first.pagination).toMatchObject({
      total: 2,
      returned: 1,
      hasMore: true,
      nextOffset: 1,
    });

    const second = await backend.callTool('list_repos', {
      name_contains: 'alp',
      limit: 1,
      offset: 1,
    });
    expect(second.repositories.map((repo) => repo.name)).toEqual(['alphabet']);
    expect(second.pagination).toMatchObject({ total: 2, returned: 1, hasMore: false });
    expect(second.pagination).not.toHaveProperty('nextOffset');

    const absent = await backend.callTool('list_repos', { name_contains: 'missing' });
    expect(absent.repositories).toEqual([]);
    expect(absent.pagination).toMatchObject({ total: 0, returned: 0, hasMore: false });
    expect(absent.pagination).not.toHaveProperty('nextOffset');

    const unfiltered = await backend.callTool('list_repos', {});
    expect(unfiltered.repositories.map((repo) => repo.name)).toEqual(['Alpha', 'alphabet', 'Beta']);
    expect(unfiltered.pagination).toMatchObject({ total: 3, returned: 3, hasMore: false });
  });

  it('advertises the optional filter on the MCP tool schema', () => {
    const tool = GITNEXUS_TOOLS.find((candidate) => candidate.name === 'list_repos');
    expect(tool?.inputSchema.properties).toHaveProperty('name_contains');
    expect(tool?.inputSchema.required ?? []).not.toContain('name_contains');
  });
});

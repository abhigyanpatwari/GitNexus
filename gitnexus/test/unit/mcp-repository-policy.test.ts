import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { LocalBackend, RepoListing } from '../../src/mcp/local/local-backend.js';
import { createMcpRepositoryPolicy } from '../../src/mcp/repository-policy.js';
import { createMCPServer } from '../../src/mcp/server.js';
import { createStreamableHttpHandler, startMcpHttpServer } from '../../src/mcp/http-transport.js';
import { mountMCPEndpoints } from '../../src/server/mcp-http.js';

const REPOS: RepoListing[] = [
  {
    name: 'Alpha',
    path: '/repos/alpha',
    indexedAt: '2026-01-01',
    lastCommit: 'a'.repeat(40),
  },
  {
    name: 'Beta',
    path: '/repos/beta',
    indexedAt: '2026-01-02',
    lastCommit: 'b'.repeat(40),
  },
  {
    name: 'Duplicate',
    path: '/repos/duplicate-one',
    indexedAt: '2026-01-03',
    lastCommit: 'c'.repeat(40),
  },
  {
    name: 'duplicate',
    path: '/repos/duplicate-two',
    indexedAt: '2026-01-04',
    lastCommit: 'd'.repeat(40),
  },
];

function createBackend(repos = REPOS) {
  return {
    listRepos: vi.fn().mockResolvedValue(repos.map((repo) => ({ ...repo }))),
    callTool: vi.fn().mockImplementation(async (name: string, args: Record<string, unknown>) => ({
      name,
      args,
    })),
    resolveRepo: vi.fn().mockImplementation(async (repo?: string) => ({
      name: repos.find((entry) => entry.path === repo)?.name ?? repo ?? repos[0]?.name,
      repoPath: repo ?? repos[0]?.path,
      lastCommit: 'a'.repeat(40),
    })),
    getContext: vi.fn().mockReturnValue(null),
    queryClusters: vi.fn().mockResolvedValue({ clusters: [] }),
    queryProcesses: vi.fn().mockResolvedValue({ processes: [] }),
    queryClusterDetail: vi.fn().mockResolvedValue({ error: 'not found' }),
    queryProcessDetail: vi.fn().mockResolvedValue({ error: 'not found' }),
    readGroupContractsResource: vi.fn().mockResolvedValue('contracts'),
    readGroupStatusResource: vi.fn().mockResolvedValue('status'),
  } as unknown as LocalBackend;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('MCP repository policy', () => {
  it('trims, resolves, and deduplicates configured repository specifiers', async () => {
    const backend = createBackend();
    const policy = await createMcpRepositoryPolicy(backend, {
      GITNEXUS_MCP_ALLOWED_REPOS: ' Alpha, /repos/beta, alpha, /repos/alpha ',
      GITNEXUS_MCP_DEFAULT_REPO: ' ALPHA ',
    });
    const scoped = policy.scopeBackend(backend);

    const repos = await scoped.listRepos();
    expect(repos.map((repo) => repo.name)).toEqual(['Alpha', 'Beta']);

    await scoped.callTool('query', { search_query: 'auth' });
    expect(backend.callTool).toHaveBeenLastCalledWith('query', {
      search_query: 'auth',
      repo: '/repos/alpha',
    });

    await scoped.callTool('context', { name: 'auth', repo: ' beta ' });
    expect(backend.callTool).toHaveBeenLastCalledWith('context', {
      name: 'auth',
      repo: '/repos/beta',
    });
  });

  it('filters list_repos before applying pagination and totals', async () => {
    const alpha = REPOS[0];
    if (!alpha) throw new Error('Alpha fixture is required');
    const backend = createBackend([
      {
        ...alpha,
        siblings: [{ name: 'Duplicate', path: '/repos/duplicate-one', lastCommit: 'c' }],
      },
      ...REPOS.slice(1),
    ]);
    const policy = await createMcpRepositoryPolicy(backend, {
      GITNEXUS_MCP_ALLOWED_REPOS: 'Beta,Alpha',
    });
    const scoped = policy.scopeBackend(backend);

    const page = (await scoped.callTool('list_repos', { limit: 1, offset: 0 })) as {
      repositories: RepoListing[];
      pagination: { total: number; returned: number; hasMore: boolean; nextOffset?: number };
    };
    expect(page.repositories.map((repo) => repo.name)).toEqual(['Alpha']);
    expect(page.repositories[0]?.siblings).toBeUndefined();
    expect(page.pagination).toMatchObject({
      total: 2,
      returned: 1,
      hasMore: true,
      nextOffset: 1,
    });
    expect(backend.callTool).not.toHaveBeenCalled();
  });

  it('uses the only allowed repository as the implicit default', async () => {
    const backend = createBackend();
    const policy = await createMcpRepositoryPolicy(backend, {
      GITNEXUS_MCP_ALLOWED_REPOS: 'Beta',
    });
    await policy.scopeBackend(backend).callTool('search', { query: 'auth' });
    expect(backend.callTool).toHaveBeenCalledWith('search', {
      query: 'auth',
      repo: '/repos/beta',
    });
  });

  it('requires an explicit repo when multiple repositories are allowed without a default', async () => {
    const backend = createBackend();
    const policy = await createMcpRepositoryPolicy(backend, {
      GITNEXUS_MCP_ALLOWED_REPOS: 'Alpha,Beta',
    });
    await expect(
      policy.scopeBackend(backend).callTool('query', { search_query: 'auth' }),
    ).rejects.toThrow(/explicit repo.*multiple repositories are allowed/i);
    expect(backend.callTool).not.toHaveBeenCalled();
  });

  it('fails startup when the default is outside the allowlist after canonical resolution', async () => {
    const backend = createBackend();
    await expect(
      createMcpRepositoryPolicy(backend, {
        GITNEXUS_MCP_ALLOWED_REPOS: 'Alpha',
        GITNEXUS_MCP_DEFAULT_REPO: 'Beta',
      }),
    ).rejects.toThrow(/default repository is not in the configured allowlist/i);
  });

  it.each([
    [{ GITNEXUS_MCP_ALLOWED_REPOS: 'Missing' }, 'invalid'],
    [{ GITNEXUS_MCP_ALLOWED_REPOS: 'Duplicate' }, 'ambiguous'],
    [{ GITNEXUS_MCP_DEFAULT_REPO: 'Duplicate' }, 'ambiguous'],
  ])('fails startup with a sanitized %s configuration error', async (env, reason) => {
    const backend = createBackend();
    let message = '';
    try {
      await createMcpRepositoryPolicy(backend, env);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(new RegExp(reason, 'i'));
    expect(message).not.toContain('/repos/');
    expect(message).not.toContain('Alpha');
    expect(message).not.toContain('Beta');
  });

  it('allows a duplicate-name repository when configured by its unique path', async () => {
    const backend = createBackend();
    const policy = await createMcpRepositoryPolicy(backend, {
      GITNEXUS_MCP_ALLOWED_REPOS: '/repos/duplicate-two',
      GITNEXUS_MCP_DEFAULT_REPO: '/repos/duplicate-two',
    });
    await policy.scopeBackend(backend).callTool('overview', {});
    expect(backend.callTool).toHaveBeenCalledWith('overview', { repo: '/repos/duplicate-two' });
  });

  it('rejects hidden and ambiguous selections without revealing registry contents', async () => {
    const backend = createBackend();
    const policy = await createMcpRepositoryPolicy(backend, {
      GITNEXUS_MCP_ALLOWED_REPOS: 'Alpha',
    });
    const scoped = policy.scopeBackend(backend);

    for (const repo of ['Beta', 'Duplicate', '/repos/duplicate-two']) {
      await expect(scoped.callTool('context', { name: 'auth', repo })).rejects.toThrow(
        /repository is not available through this MCP server/i,
      );
    }
    expect(backend.callTool).not.toHaveBeenCalled();
  });

  it('enforces the policy on resources and group methods', async () => {
    const backend = createBackend();
    const policy = await createMcpRepositoryPolicy(backend, {
      GITNEXUS_MCP_ALLOWED_REPOS: 'Alpha',
    });
    const scoped = policy.scopeBackend(backend);

    await expect(scoped.resolveRepo('Beta')).rejects.toThrow(/not available/i);
    await expect(scoped.readGroupStatusResource('portfolio')).rejects.toThrow(
      /group.*unavailable/i,
    );
    await expect(scoped.readGroupContractsResource('portfolio', {})).rejects.toThrow(
      /group.*unavailable/i,
    );
    await expect(scoped.callTool('group_list', {})).rejects.toThrow(/group.*unavailable/i);
    await expect(
      scoped.callTool('query', { repo: '@portfolio', search_query: 'auth' }),
    ).rejects.toThrow(/group.*unavailable/i);
    expect(backend.readGroupStatusResource).not.toHaveBeenCalled();
  });

  it('enforces the allowlist on repo-scoped query methods without the resource guard', async () => {
    const backend = createBackend();
    const policy = await createMcpRepositoryPolicy(backend, {
      GITNEXUS_MCP_ALLOWED_REPOS: 'Alpha',
    });
    const scoped = policy.scopeBackend(backend);

    expect(() => scoped.queryClusters('Beta')).toThrow(/not available/i);
    expect(() => scoped.queryProcesses('Beta')).toThrow(/not available/i);
    expect(() => scoped.queryClusterDetail('area', 'Beta')).toThrow(/not available/i);
    expect(() => scoped.queryProcessDetail('proc', 'Beta')).toThrow(/not available/i);

    await scoped.queryClusters();
    expect(backend.queryClusters).toHaveBeenCalledWith('/repos/alpha', undefined);
    await scoped.queryClusterDetail('area');
    expect(backend.queryClusterDetail).toHaveBeenCalledWith('area', '/repos/alpha');
  });

  it.each(['GITNEXUS://GROUP/acme/status', 'gitnexus://user@group/acme/status'])(
    'rejects disguised group resource URI %s',
    async (uri) => {
      const backend = createBackend();
      const policy = await createMcpRepositoryPolicy(backend, {
        GITNEXUS_MCP_ALLOWED_REPOS: 'Alpha',
      });
      expect(() => policy.assertResourceUri(uri)).toThrow(/group.*unavailable/i);
    },
  );

  it.each([{ GITNEXUS_MCP_ALLOWED_REPOS: '   ' }, { GITNEXUS_MCP_DEFAULT_REPO: '   ' }])(
    'fails closed for explicitly blank repository configuration',
    async (env) => {
      await expect(createMcpRepositoryPolicy(createBackend(), env)).rejects.toThrow(
        /must not be blank/i,
      );
    },
  );

  it('is transparent when no repository policy is configured', async () => {
    const backend = createBackend();
    const policy = await createMcpRepositoryPolicy(backend, {});
    await policy.scopeBackend(backend).callTool('query', { search_query: 'auth' });
    expect(backend.callTool).toHaveBeenCalledWith('query', { search_query: 'auth' });
    expect(await policy.scopeBackend(backend).listRepos()).toHaveLength(REPOS.length);
  });

  it('uses a configured default without restricting explicit dynamic selections', async () => {
    const backend = createBackend();
    const policy = await createMcpRepositoryPolicy(backend, {
      GITNEXUS_MCP_DEFAULT_REPO: 'Alpha',
    });
    const scoped = policy.scopeBackend(backend);

    await scoped.callTool('query', { search_query: 'auth' });
    expect(backend.callTool).toHaveBeenLastCalledWith('query', {
      search_query: 'auth',
      repo: '/repos/alpha',
    });

    await scoped.callTool('query', { search_query: 'auth', repo: 'newly-indexed' });
    expect(backend.callTool).toHaveBeenLastCalledWith('query', {
      search_query: 'auth',
      repo: 'newly-indexed',
    });
  });

  it('enforces one policy across MCP tools, aliases, discovery, and resources', async () => {
    const backend = createBackend();
    const policy = await createMcpRepositoryPolicy(backend, {
      GITNEXUS_MCP_ALLOWED_REPOS: 'Alpha',
      GITNEXUS_MCP_DEFAULT_REPO: 'Alpha',
    });
    const server = createMCPServer(backend, { repositoryPolicy: policy });
    const client = new Client({ name: 'repo-policy-client', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).not.toContain('group_list');
      expect(tools.tools.map((tool) => tool.name)).not.toContain('group_sync');
      for (const tool of tools.tools) {
        expect(tool.description).not.toMatch(/GROUP MODE|CROSS-REPO|@<groupName>/);
      }

      const templates = await client.listResourceTemplates();
      expect(
        templates.resourceTemplates.every((item) => !item.uriTemplate.includes('/group/')),
      ).toBe(true);

      const repos = await client.callTool({ name: 'list_repos', arguments: {} });
      const reposText = (repos.content[0] as { text: string }).text;
      expect(reposText).toContain('Alpha');
      expect(reposText).not.toContain('Beta');
      expect(reposText).not.toContain('Duplicate');

      const query = await client.callTool({
        name: 'query',
        arguments: { search_query: 'auth' },
      });
      expect(query.isError).not.toBe(true);
      expect(backend.callTool).toHaveBeenLastCalledWith('query', {
        search_query: 'auth',
        repo: '/repos/alpha',
      });

      const hiddenAlias = await client.callTool({
        name: 'search',
        arguments: { query: 'auth', repo: 'Beta' },
      });
      expect(hiddenAlias.isError).toBe(true);
      expect((hiddenAlias.content[0] as { text: string }).text).toMatch(/not available/i);

      const reposResource = await client.readResource({ uri: 'gitnexus://repos' });
      const resourceText = (reposResource.contents[0] as { text: string }).text;
      expect(resourceText).toContain('Alpha');
      expect(resourceText).not.toContain('Beta');

      const setupResource = await client.readResource({ uri: 'gitnexus://setup' });
      const setupText = (setupResource.contents[0] as { text: string }).text;
      expect(setupText).toContain('Alpha');
      expect(setupText).not.toContain('Beta');

      const hiddenResource = await client.readResource({
        uri: 'gitnexus://repo/Beta/schema',
      });
      expect((hiddenResource.contents[0] as { text: string }).text).toMatch(/not available/i);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('refuses direct server construction when configured policy was not prevalidated', () => {
    vi.stubEnv('GITNEXUS_MCP_ALLOWED_REPOS', 'Alpha');
    expect(() => createMCPServer(createBackend())).toThrow(/must be validated/i);
  });

  it('fails standalone HTTP startup before binding when registry policy is invalid', async () => {
    vi.stubEnv('GITNEXUS_MCP_ALLOWED_REPOS', 'Missing');
    await expect(
      startMcpHttpServer(createBackend(), { host: '127.0.0.1', port: 0 }),
    ).rejects.toThrow(/invalid repository selection/i);
  });

  it('fails embedded HTTP startup before registering a route when policy is invalid', async () => {
    vi.stubEnv('GITNEXUS_MCP_ALLOWED_REPOS', 'Missing');
    const app = { all: vi.fn() };

    await expect(mountMCPEndpoints(app as never, createBackend())).rejects.toThrow(
      /invalid repository selection/i,
    );
    expect(app.all).not.toHaveBeenCalled();
  });

  it('rejects a custom HTTP server factory that would bypass configured policy', () => {
    vi.stubEnv('GITNEXUS_MCP_ALLOWED_REPOS', 'Alpha');
    expect(() =>
      createStreamableHttpHandler(createBackend(), {
        createServer: () => createMCPServer(createBackend()),
      }),
    ).toThrow(/cannot bypass configured repository policy/i);
  });
});

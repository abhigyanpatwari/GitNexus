import { afterEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { LocalBackend } from '../../../src/mcp/local/local-backend.js';
import * as pool from '../../../src/core/lbug/pool-adapter.js';
import { createMcpRepositoryPolicy } from '../../../src/mcp/repository-policy.js';
import { createMCPServer } from '../../../src/mcp/server.js';
import { SYMBOL_IDENTITY_RECOVERY_SUGGESTION } from '../../../src/mcp/local/query-result-integrity.js';

type Handle = Awaited<ReturnType<LocalBackend['selectToolRepository']>>;
type QueryResult = {
  processes: { id: string }[];
  process_symbols: { id: string; process_id: string }[];
  definitions: { id: string }[];
};
const repoPath = (name: string) => path.resolve('/repos', name);
const alpha = repoPath('alpha');
const beta = repoPath('beta');

function harness() {
  const backend = new LocalBackend();
  const internals = backend as unknown as {
    query: (repo: Handle, args: Record<string, unknown>) => Promise<QueryResult>;
    withToolStaleness: (repo: Handle, result: QueryResult) => Promise<QueryResult>;
  };
  const selection = vi.spyOn(backend, 'selectToolRepository').mockImplementation(async (name) => {
    if (typeof name !== 'string' || name === 'missing') throw new Error('Unknown repository');
    const root = path.isAbsolute(name) ? name : repoPath(name.toLowerCase());
    return {
      id: root,
      name: path.basename(root),
      repoPath: root,
      storagePath: `${root}/.gitnexus`,
      lbugPath: `${root}/.gitnexus/lbug`,
      lastCommit: 'abc',
      indexedAt: '2026-01-01',
    };
  });
  const query = vi.spyOn(internals, 'query').mockResolvedValue({
    processes: [{ id: 'proc:shared' }],
    process_symbols: [{ id: 'Function:shared', process_id: 'proc:shared' }],
    definitions: [],
  });
  vi.spyOn(internals, 'withToolStaleness').mockImplementation(async (_repo, result) => ({
    ...result,
    staleness: { status: 'current' },
  }));
  const releases: ReturnType<typeof vi.fn>[] = [];
  const pin = vi.spyOn(pool, 'pinRepo').mockImplementation(() => {
    const release = vi.fn();
    releases.push(release);
    return release;
  });
  vi.spyOn(backend, 'listRepos').mockResolvedValue(
    ['alpha', 'beta'].map((name) => ({
      name,
      path: repoPath(name),
      indexedAt: '2026-01-01',
      lastCommit: 'abc',
    })),
  );
  vi.spyOn(backend, 'countRepos').mockResolvedValue(2);
  vi.spyOn(backend, 'cachedRepoCount').mockReturnValue(2);
  return { backend, selection, query, pin, releases };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('array query routing', () => {
  it.each(['query', 'search'])(
    'routes %s arrays before scalar selection and deduplicates checkout aliases',
    async (tool) => {
      const h = harness();
      const result = await h.backend.callTool(tool, {
        repo: [' Alpha ', alpha, 'beta'],
        query: 'auth',
        branch: 'release',
      });
      expect(result.repos).toEqual([alpha, beta]);
      expect(h.query).toHaveBeenCalledTimes(2);
      expect(h.selection).toHaveBeenCalledWith('Alpha', 'release');
      expect(result.process_symbols.map((row: { _repo: string }) => row._repo)).toEqual(
        result.repos,
      );
      expect(result.per_repo.every((member: { staleness: unknown }) => member.staleness)).toBe(
        true,
      );
      expect(result).not.toHaveProperty('staleness');
      expect(h.pin.mock.calls.map(([id]) => id)).toEqual([
        `${alpha}/.gitnexus/lbug`,
        `${beta}/.gitnexus/lbug`,
      ]);
      for (const release of h.releases) expect(release).toHaveBeenCalledOnce();
    },
  );

  it.each(
    [[], ['alpha', ''], ['alpha', 3], ['alpha', '@group'], Array(11).fill('alpha')].map((repo) => ({
      repo,
    })),
  )('rejects malformed selections before repository I/O: %j', async ({ repo }) => {
    const h = harness();
    await expect(
      h.backend.callTool('query', { repo, search_query: 'auth' }),
    ).resolves.toHaveProperty('error');
    expect(h.selection).not.toHaveBeenCalled();
    expect(h.query).not.toHaveBeenCalled();
    expect(h.pin).not.toHaveBeenCalled();
  });

  it.each([{ search_query: '' }, { limit: 0 }, { max_symbols: 201 }, { chain_depth: -1 }])(
    'validates shared query arguments before repository I/O: %j',
    async (args) => {
      const h = harness();
      await expect(
        h.backend.callTool('query', { repo: ['alpha'], search_query: 'auth', ...args }),
      ).resolves.toHaveProperty('error');
      expect(h.selection).not.toHaveBeenCalled();
      expect(h.pin).not.toHaveBeenCalled();
    },
  );

  it('resolves the entire list before starting any search', async () => {
    const h = harness();
    await expect(
      h.backend.callTool('query', { repo: ['alpha', 'missing'], search_query: 'auth' }),
    ).rejects.toThrow('Unknown repository');
    expect(h.query).not.toHaveBeenCalled();
    expect(h.pin).not.toHaveBeenCalled();
  });

  it.each(['context', 'impact', 'rename', 'group_sync', 'list_repos'])(
    'rejects array selections for %s',
    async (tool) => {
      const h = harness();
      await expect(
        h.backend.callTool(tool, { repo: ['alpha'], dry_run: false }),
      ).resolves.toMatchObject({ error: expect.stringMatching(/only.*query|query.*only/i) });
      expect(h.selection).not.toHaveBeenCalled();
      expect(h.pin).not.toHaveBeenCalled();
    },
  );

  it('bounds ten searches and releases every active lease after failures', async () => {
    const h = harness();
    let active = 0;
    let peak = 0;
    let peakLeases = 0;
    h.query.mockImplementation(async (repo) => {
      active++;
      peak = Math.max(peak, active);
      peakLeases = Math.max(
        peakLeases,
        h.releases.filter((release) => release.mock.calls.length === 0).length,
      );
      try {
        await new Promise((resolve) => setTimeout(resolve, 5));
        if (repo.name === 'r2') throw new Error('database unavailable');
        return { processes: [], process_symbols: [], definitions: [] };
      } finally {
        active--;
      }
    });
    const result = await h.backend.callTool('query', {
      repo: Array.from({ length: 10 }, (_, i) => `r${i}`),
      search_query: 'auth',
    });
    expect(peak).toBe(4);
    expect(peakLeases).toBe(4);
    expect(active).toBe(0);
    expect(h.query).toHaveBeenCalledTimes(10);
    expect(result.partial).toBe(true);
    expect(
      result.per_repo.filter((member: { status: string }) => member.status === 'error'),
    ).toHaveLength(1);
    expect(h.releases).toHaveLength(10);
    for (const release of h.releases) expect(release).toHaveBeenCalledOnce();
  });

  it('keeps sibling checkout identities even when they share one database', async () => {
    const h = harness();
    const select = h.selection.getMockImplementation()!;
    h.selection.mockImplementation(async (...args) => ({
      ...(await select(...args)),
      lbugPath: '/shared/store/graph',
    }));
    const result = await h.backend.callTool('query', {
      repo: ['alpha', 'beta'],
      search_query: 'auth',
    });
    expect(result.repos).toEqual([alpha, beta]);
    expect(result.process_symbols.map((row: { _repo: string }) => row._repo)).toEqual([
      alpha,
      beta,
    ]);
    expect(h.query).toHaveBeenCalledTimes(2);
    expect(h.pin.mock.calls).toEqual([['/shared/store/graph'], ['/shared/store/graph']]);
    for (const release of h.releases) expect(release).toHaveBeenCalledOnce();
  });

  it('settles every lease before reporting corrupt symbol identity', async () => {
    const h = harness();
    h.query.mockResolvedValueOnce({
      error: 'corrupt identity',
      recoverySuggestion: SYMBOL_IDENTITY_RECOVERY_SUGGESTION,
    } as unknown as QueryResult);
    const result = await h.backend.callTool('query', {
      repo: ['alpha', 'beta'],
      search_query: 'auth',
    });
    expect(result).toMatchObject({
      error: 'corrupt identity',
      recoverySuggestion: SYMBOL_IDENTITY_RECOVERY_SUGGESTION,
    });
    expect(result).not.toHaveProperty('processes');
    expect(h.query).toHaveBeenCalledTimes(2);
    for (const release of h.releases) expect(release).toHaveBeenCalledOnce();
  });

  it('retains scalar behavior and uses an aggregate for a singleton array', async () => {
    const h = harness();
    const scalar = await h.backend.callTool('query', { repo: 'alpha', search_query: 'auth' });
    expect(scalar).not.toHaveProperty('repos');
    expect(scalar).toHaveProperty('staleness');
    expect(h.pin).not.toHaveBeenCalled();
    const array = await h.backend.callTool('query', { repo: ['alpha'], search_query: 'auth' });
    expect(array.repos).toEqual([alpha]);
  });
});

describe('MCP array query policy and wire contract', () => {
  it.each([
    { tool: 'context', repo: [] },
    { tool: 'context', repo: ['@group'] },
    { tool: 'list_repos', repo: ['alpha'] },
  ])(
    'rejects repository arrays for $tool before policy selection ($repo)',
    async ({ tool, repo }) => {
      const h = harness();
      const policy = await createMcpRepositoryPolicy(h.backend, {
        GITNEXUS_MCP_ALLOWED_REPOS: 'alpha,beta',
      });
      const dispatch = vi.spyOn(h.backend, 'callTool');
      await expect(policy.scopeBackend(h.backend).callTool(tool, { repo })).rejects.toThrow(
        'Repository arrays are supported only by query (and legacy search).',
      );
      expect(dispatch).not.toHaveBeenCalled();
      expect(h.selection).not.toHaveBeenCalled();
    },
  );

  it.each(['query', 'search'])(
    'gives %s error recovery guidance without a result-row follow-up',
    async (name) => {
      const h = harness();
      const server = createMCPServer(h.backend);
      const client = new Client({ name: 'multi-repo-error-hint-test', version: '1' });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      try {
        await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
        const response = await client.callTool({
          name,
          arguments: { repo: [], search_query: 'auth' },
        });
        const text = (response.content as { text: string }[])[0]!.text;
        const [body, legacyHint] = text.split('\n\n---\n**Next:** ');
        const result = JSON.parse(body!);
        expect(result.error).toContain('query.repo');
        expect(name === 'query' ? result.next : legacyHint).toMatch(/error.*retry/i);
        expect(text).not.toContain('context(');
        expect(text).not.toContain('<row._repo>');
        expect(h.query).not.toHaveBeenCalled();
      } finally {
        await client.close();
        await server.close();
      }
    },
  );

  it.each([
    ['query', false],
    ['query', true],
    ['search', false],
    ['search', true],
  ] as const)(
    'routes %s follow-up hints to the result repository (include_content=%s)',
    async (name, includeContent) => {
      const h = harness();
      const server = createMCPServer(h.backend);
      const client = new Client({ name: 'multi-repo-hint-test', version: '1' });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      try {
        await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
        const response = await client.callTool({
          name,
          arguments: {
            search_query: 'auth',
            repo: ['alpha', 'beta'],
            include_content: includeContent,
          },
        });
        expect(response.isError).not.toBe(true);
        const text = (response.content as { text: string }[])[0]!.text;
        const [body, legacyHint] = text.split('\n\n---\n**Next:** ');
        const result = JSON.parse(body!);
        const hint = name === 'query' ? result.next : legacyHint;
        expect(result.process_symbols).toHaveLength(2);
        expect(hint).toContain('context({uid: "<id>", repo: "<row._repo>"})');
        expect(hint).not.toContain('alpha,beta');
        expect(hint.includes('content_truncated')).toBe(includeContent);
        expect(hint.includes('repo: "<row._repo>", include_content: true')).toBe(includeContent);
      } finally {
        await client.close();
        await server.close();
      }
    },
  );

  it('authorizes the whole list before dispatch and keeps explicit arrays ahead of defaults', async () => {
    const h = harness();
    const policy = await createMcpRepositoryPolicy(h.backend, {
      GITNEXUS_MCP_ALLOWED_REPOS: 'alpha,beta',
      GITNEXUS_MCP_DEFAULT_REPO: 'alpha',
    });
    const raw = vi.spyOn(h.backend, 'callTool');
    const scoped = policy.scopeBackend(h.backend);
    await expect(
      scoped.callTool('query', { repo: ['alpha', '/hidden/secret'], search_query: 'auth' }),
    ).rejects.toThrow('Repository is not available through this MCP server.');
    expect(raw).not.toHaveBeenCalled();
    expect(h.query).not.toHaveBeenCalled();
    const result = await scoped.callTool('query', { repo: ['beta'], search_query: 'auth' });
    expect(result.repos).toEqual([beta]);
    expect(raw).toHaveBeenLastCalledWith('query', { repo: [beta], search_query: 'auth' });
  });

  it.each([false, true])(
    'advertises arrays and preserves provenance through SDK filtering (readOnly=%s)',
    async (readOnly) => {
      const h = harness();
      vi.stubEnv('GITNEXUS_MCP_READ_ONLY', readOnly ? '1' : '0');
      vi.stubEnv('GITNEXUS_MCP_ALLOWED_REPOS', 'alpha,beta');
      const repositoryPolicy = await createMcpRepositoryPolicy(h.backend);
      const server = createMCPServer(h.backend, { repositoryPolicy });
      const client = new Client({ name: 'multi-repo-test', version: '1' });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      try {
        await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
        const listing = await client.listTools();
        const schema = listing.tools.find((tool) => tool.name === 'query')!.inputSchema.properties!
          .repo as Record<string, unknown>;
        expect(schema).toMatchObject({
          type: ['string', 'array'],
          items: { type: 'string', minLength: 1 },
          minItems: 1,
          maxItems: 10,
        });
        expect(schema.description).toMatch(/list|array/i);
        expect(
          listing.tools.find((tool) => tool.name === 'context')!.inputSchema.properties!.repo,
        ).toMatchObject({ type: 'string' });
        const response = await client.callTool({
          name: 'query',
          arguments: {
            search_query: 'auth',
            repo: ['alpha', 'beta'],
            response_sections: ['process_symbols'],
            include_content: true,
          },
        });
        expect(response.isError).not.toBe(true);
        const text = (response.content as { text: string }[])[0]!.text;
        const result = JSON.parse(text);
        expect(result.repos).toEqual([alpha, beta]);
        expect(result.process_symbols).toHaveLength(2);
        expect(result).not.toHaveProperty('processes');
        expect(result.per_repo).toHaveLength(2);
        expect(result.next).toContain('repo: "<row._repo>"');
        const capped = await client.callTool({
          name: 'query',
          arguments: { search_query: 'auth', repo: ['alpha', 'beta'], maxTokens: 100 },
        });
        expect((capped.content as { text: string }[])[0]!.text.length).toBeLessThan(text.length);
        const badGroup = await client.callTool({
          name: 'query',
          arguments: { search_query: 'auth', repo: ['alpha', '@group'] },
        });
        expect(badGroup.isError).toBe(true);
      } finally {
        await client.close();
        await server.close();
      }
    },
  );
});

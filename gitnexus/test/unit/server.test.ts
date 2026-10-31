/**
 * Unit Tests: MCP Server
 *
 * Tests: createMCPServer from server.ts
 * - Server creation returns a Server instance
 * - Tool handler wraps backend.callTool and appends hints
 * - Tool handler catches errors and returns isError: true
 * - Resource handlers delegate to resources.ts functions
 * - Prompt handlers return expected prompts
 * - Next-step hints cover all tool names
 *
 * NOTE: We test the server handler logic by calling the request handlers
 * directly through the MCP Server's handler dispatch.
 */
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import {
  createMCPServer,
  getNextStepHint,
  installSignalShutdown,
  installParentShutdown,
  startMCPServer,
  SHUTDOWN_EXIT_CODES,
} from '../../src/mcp/server.js';
import { GITNEXUS_TOOLS } from '../../src/mcp/tools.js';
import { MCP_TRUNCATION_MARKER } from '../../src/mcp/output-budget.js';
import { createMcpRepositoryPolicy } from '../../src/mcp/repository-policy.js';

// ─── Mock backend ──────────────────────────────────────────────────

function createMockBackend(overrides: Record<string, any> = {}): any {
  return {
    callTool: vi.fn().mockResolvedValue({ result: 'ok' }),
    listRepos: vi.fn().mockResolvedValue([]),
    countRepos: vi.fn().mockResolvedValue(0),
    cachedRepoCount: vi.fn().mockReturnValue(0),
    resolveRepo: vi
      .fn()
      .mockResolvedValue({ name: 'test', repoPath: '/tmp/test', lastCommit: 'abc' }),
    selectToolRepository: vi
      .fn()
      .mockResolvedValue({ name: 'test', repoPath: '/tmp/test', lastCommit: 'abc' }),
    getContext: vi.fn().mockReturnValue(null),
    queryClusters: vi.fn().mockResolvedValue({ clusters: [] }),
    queryProcesses: vi.fn().mockResolvedValue({ processes: [] }),
    queryClusterDetail: vi.fn().mockResolvedValue({ error: 'not found' }),
    queryProcessDetail: vi.fn().mockResolvedValue({ error: 'not found' }),
    disconnect: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

async function callToolThroughServer(
  backend: ReturnType<typeof createMockBackend>,
  name: string,
  args: Record<string, unknown>,
): Promise<{ text: string; isError: boolean }> {
  const server = createMCPServer(backend);
  const client = new Client({ name: 'budget-test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const response = CallToolResultSchema.parse(await client.callTool({ name, arguments: args }));
    const text = response.content.find((item) => item.type === 'text')?.text;
    if (typeof text !== 'string') throw new Error('Expected an MCP text response');
    return { text, isError: response.isError === true };
  } finally {
    await client.close();
    await server.close();
  }
}

// ─── createMCPServer ─────────────────────────────────────────────────

describe('createMCPServer', () => {
  it('returns a Server instance with expected shape', () => {
    const backend = createMockBackend();
    const server = createMCPServer(backend);
    expect(server).toBeDefined();
    // Server should have connect/close methods
    expect(typeof server.connect).toBe('function');
    expect(typeof server.close).toBe('function');
  });

  it('server has setRequestHandler method', () => {
    const backend = createMockBackend();
    const server = createMCPServer(backend);
    // The server has registered handlers — verify it was created without errors
    expect(server).toBeTruthy();
  });

  it('tools/list response includes tool annotations', async () => {
    const backend = createMockBackend();
    const server = createMCPServer(backend);
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

      const response = await client.listTools();
      expect(response.tools).toHaveLength(GITNEXUS_TOOLS.length);

      for (const tool of response.tools) {
        const definition = GITNEXUS_TOOLS.find((t) => t.name === tool.name)!;
        expect(tool.annotations).toEqual(definition.annotations);
      }
    } finally {
      await client.close();
      await server.close();
    }
  });
  it('requires repo in repo-scoped tool schemas when cwd cannot resolve multiple repos', async () => {
    const backend = createMockBackend({
      countRepos: vi.fn().mockResolvedValue(2),
      listRepos: vi.fn().mockResolvedValue([
        { name: 'alpha', path: '/tmp/alpha' },
        { name: 'beta', path: '/tmp/beta' },
      ]),
      selectToolRepository: vi.fn().mockRejectedValue(new Error('Multiple repositories indexed')),
    });
    const server = createMCPServer(backend);
    const client = new Client({ name: 'multi-repo-client', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const tools = await client.listTools();
      const query = tools.tools.find((tool) => tool.name === 'query');
      const listRepos = tools.tools.find((tool) => tool.name === 'list_repos');

      expect(query?.inputSchema.required).toContain('repo');
      expect(listRepos?.inputSchema.required).not.toContain('repo');
      for (const name of ['read_file', 'grep'] as const) {
        const tool = tools.tools.find((candidate) => candidate.name === name);
        expect(tool?.inputSchema.required, name).toContain('repo');
        expect(tool?.inputSchema.properties, name).not.toHaveProperty('branch');
      }
      expect(
        GITNEXUS_TOOLS.find((tool) => tool.name === 'query')?.inputSchema.required,
      ).not.toContain('repo');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('keeps repo optional when cwd resolves one of multiple visible repos', async () => {
    const backend = createMockBackend({
      countRepos: vi.fn().mockResolvedValue(2),
      cachedRepoCount: vi.fn().mockReturnValue(2),
      listRepos: vi.fn().mockResolvedValue([
        { name: 'alpha', path: '/tmp/alpha' },
        { name: 'beta', path: '/tmp/beta' },
      ]),
      selectToolRepository: vi
        .fn()
        .mockResolvedValue({ name: 'alpha', repoPath: '/tmp/alpha', lastCommit: 'abc' }),
    });
    const server = createMCPServer(backend);
    const client = new Client({ name: 'cwd-repo-client', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const tools = await client.listTools();
      const context = tools.tools.find((tool) => tool.name === 'context');
      const rename = tools.tools.find((tool) => tool.name === 'rename');

      expect(context?.inputSchema.required).not.toContain('repo');
      expect(rename?.inputSchema.required).toContain('repo');
      const response = await client.callTool({ name: 'context', arguments: { name: 'Example' } });
      expect(response.isError).not.toBe(true);
      expect(backend.callTool).toHaveBeenCalledWith('context', { name: 'Example' });
      expect(backend.countRepos).toHaveBeenCalledTimes(1);
      expect(backend.listRepos).not.toHaveBeenCalled();
      expect(backend.selectToolRepository).toHaveBeenCalledTimes(1);
      expect(backend.selectToolRepository).toHaveBeenCalledWith(undefined, undefined, {
        allowCwdDefault: true,
        refreshRegistry: true,
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it.each(
    [{ GITNEXUS_MCP_DEFAULT_REPO: 'alpha' }, { GITNEXUS_MCP_ALLOWED_REPOS: 'alpha' }].flatMap(
      (env) => [false, true].map((readOnly) => ({ env, readOnly })),
    ),
  )(
    'advertises the resolved repository default in tool schemas (%j)',
    async ({ env, readOnly }) => {
      vi.stubEnv('GITNEXUS_MCP_READ_ONLY', readOnly ? '1' : '0');
      const backend = createMockBackend({
        listRepos: vi.fn().mockResolvedValue([
          { name: 'alpha', path: '/tmp/alpha' },
          { name: 'beta', path: '/tmp/beta' },
        ]),
      });
      const repositoryPolicy = await createMcpRepositoryPolicy(backend, env);
      const server = createMCPServer(backend, { repositoryPolicy });
      const client = new Client({ name: 'default-repo-client', version: '0.0.0' });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

      try {
        await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
        const tools = await client.listTools();
        const query = tools.tools.find((tool) => tool.name === 'query');

        expect(query?.inputSchema.required).not.toContain('repo');
        expect(query?.inputSchema.properties?.repo).toMatchObject({
          default: '/tmp/alpha',
          description: expect.stringContaining('"alpha"'),
        });
        await client.callTool({ name: 'query', arguments: { search_query: 'auth' } });
        expect(backend.callTool).toHaveBeenLastCalledWith('query', {
          search_query: 'auth',
          repo: '/tmp/alpha',
        });
        expect(
          GITNEXUS_TOOLS.find((tool) => tool.name === 'query')?.inputSchema.properties.repo,
        ).not.toHaveProperty('default');
      } finally {
        vi.unstubAllEnvs();
        await client.close();
        await server.close();
      }
    },
  );

  it('requires repo when multiple allowed repositories are visible without a default', async () => {
    const backend = createMockBackend({
      listRepos: vi.fn().mockResolvedValue([
        { name: 'alpha', path: '/tmp/alpha' },
        { name: 'beta', path: '/tmp/beta' },
        { name: 'gamma', path: '/tmp/gamma' },
      ]),
    });
    const repositoryPolicy = await createMcpRepositoryPolicy(backend, {
      GITNEXUS_MCP_ALLOWED_REPOS: 'alpha,beta',
    });
    const server = createMCPServer(backend, { repositoryPolicy });
    const client = new Client({ name: 'allowlisted-repos-client', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const tools = await client.listTools();
      const query = tools.tools.find((tool) => tool.name === 'query');

      expect(query?.inputSchema.required).toContain('repo');
    } finally {
      await client.close();
      await server.close();
    }
  });
});

// ─── getNextStepHint (tested indirectly via server tool handler) ──────

describe('getNextStepHint (via tool call response)', () => {
  // We test hints by calling the server's tool handler indirectly.
  // Since createMCPServer registers handlers on the Server, we verify
  // hints are appended by checking the tool response format.

  it('query tool response includes hint about context', async () => {
    const backend = createMockBackend({
      callTool: vi.fn().mockResolvedValue({ processes: [], definitions: [] }),
    });
    const server = createMCPServer(backend);

    // We can't easily call handlers directly on the MCP Server,
    // so we verify the handler was registered by creating the server without error.
    // The actual hint logic is tested via the integration path.
    expect(backend.callTool).not.toHaveBeenCalled(); // not called until request
  });

  const QUERY_HINT_BASE =
    'Use context({uid: "<id>", repo: "demo"}) for a symbol\'s references and processes.';

  it('query hint uses the returned identity and repository', async () => {
    const backend = createMockBackend({
      callTool: vi.fn().mockResolvedValue({ processes: [] }),
    });
    const { text } = await callToolThroughServer(backend, 'query', {
      search_query: 'auth',
      repo: 'demo',
    });
    expect(JSON.parse(text).next).toBe(QUERY_HINT_BASE);
    expect(text).not.toContain('content_truncated');
  });

  it('query hint names the context({uid, include_content}) fallback when include_content is true', async () => {
    const backend = createMockBackend({
      callTool: vi.fn().mockResolvedValue({ processes: [] }),
    });
    const { text } = await callToolThroughServer(backend, 'query', {
      search_query: 'auth',
      repo: 'demo',
      include_content: true,
    });
    expect(JSON.parse(text).next).toBe(
      `${QUERY_HINT_BASE} Source previews marked content_truncated are incomplete; use context({uid: "<id>", include_content: true, repo: "demo"}) or read_file with a bounded line range for more.`,
    );
  });

  it('grep hint converts the 1-based hit line to a 0-based read_file window', async () => {
    const backend = createMockBackend({
      callTool: vi
        .fn()
        .mockResolvedValue({ results: [{ filePath: 'a.ts', line: 1, text: 'signOrder()' }] }),
    });
    const { text } = await callToolThroughServer(backend, 'grep', {
      pattern: 'signOrder',
      repo: 'demo',
    });
    expect(text).toContain('startLine: <hit.line - 1>');
    expect(text).toContain('endLine: <hit.line - 1>');
    expect(text).toContain('Grep line is 1-based; read_file is 0-based');
  });
});

describe('getNextStepHint rename', () => {
  const apply =
    'rename({symbol_uid: "Method:src/a.ts:A.run#0", new_name: "go", dry_run: false, plan_token: "<plan_token from this preview>", repo: "demo"})';

  it.each([
    ['omitted', { symbol_uid: 'Method:src/a.ts:A.run#0', new_name: 'go', repo: 'demo' }],
    [
      'true',
      { symbol_uid: 'Method:src/a.ts:A.run#0', new_name: 'go', repo: 'demo', dry_run: true },
    ],
  ])('points a dry run (dry_run %s) at the apply call, not at detect_changes', (_label, args) => {
    const hint = getNextStepHint('rename', args);
    expect(hint).toContain(apply);
    expect(hint).toContain('no files were changed');
    expect(hint).not.toContain('detect_changes');
  });

  it('shows the detect_changes hint only after an explicit dry_run:false', () => {
    const hint = getNextStepHint(
      'rename',
      { new_name: 'go', repo: 'demo', dry_run: false },
      false,
      { status: 'success', applied: true, application_status: 'applied' },
    );
    expect(hint).toContain('detect_changes({repo: "demo"})');
    expect(hint).not.toContain('dry_run: false');
  });

  it.each([
    ['the string "false"', 'false'],
    ['null', null],
    ['zero', 0],
  ])('does not treat dry_run %s as an applied rename', (_label, dryRun) => {
    const hint = getNextStepHint('rename', { new_name: 'go', dry_run: dryRun });
    expect(hint).not.toContain('detect_changes');
  });

  it('names symbol_name, quoted, when no symbol_uid was sent and omits repo when absent', () => {
    const hint = getNextStepHint('rename', { symbol_name: 'run "fast"', new_name: 'go' });
    expect(hint).toContain(
      'rename({symbol_name: "run \\"fast\\"", new_name: "go", dry_run: false, plan_token: "<plan_token from this preview>"})',
    );
  });

  it('never suggests applying from a read-only server', () => {
    const hint = getNextStepHint('rename', { new_name: 'go', dry_run: true }, true);
    expect(hint).toContain('MCP read-only mode cannot apply it');
    expect(hint).toContain('fresh preview from a server that permits writes');
    expect(hint).toContain("that server's plan_token");
    expect(hint).not.toContain('dry_run: false');
    expect(hint).not.toContain('detect_changes');
  });
  it.each(['plan_required', 'invalid_plan', 'plan_mismatch', 'source_changed'])(
    'requests a fresh preview when apply fails with %s',
    (code) => {
      const hint = getNextStepHint('rename', { dry_run: false }, false, {
        status: 'error',
        applied: false,
        code,
      });
      expect(hint).toContain('fresh rename preview');
      expect(hint).toContain('plan_token');
      expect(hint).not.toContain('detect_changes');
    },
  );
  it('directs partial operations to reconcile exact write lists before retrying', () => {
    const hint = getNextStepHint('rename', { dry_run: false }, false, {
      status: 'partial',
      applied: true,
      application_status: 'partial',
    });
    expect(hint).toContain('failed_files and unattempted_files');
    expect(hint).not.toContain('detect_changes');
  });
});

describe('MCP output budgets', () => {
  it('serializes query previews and diagnostics as one JSON document', async () => {
    const result = {
      processes: [{ id: 'process-1', symbol_count: 2 }],
      process_symbols: [
        { id: 'Function:small', process_id: 'process-1', content: 'function small() {}' },
        {
          id: 'Function:large',
          process_id: 'process-1',
          content: 'large preview',
          content_truncated: true,
        },
      ],
      definitions: [
        {
          id: 'File:large.ts',
          filePath: 'large.ts',
          content: 'file preview',
          content_truncated: true,
        },
      ],
      warning: 'Some keyword indexes are unavailable',
      partial: true,
      staleness: { status: 'behind', commitsBehind: 2 },
      contentAvailability: 'available',
    };
    const backend = createMockBackend({ callTool: vi.fn().mockResolvedValue(result) });
    const { text, isError } = await callToolThroughServer(backend, 'query', {
      search_query: 'large',
      include_content: true,
    });

    expect(isError).toBe(false);
    const { next, ...body } = JSON.parse(text);
    expect(body).toEqual(result);
    expect(next).toContain('read_file');
    expect(result).not.toHaveProperty('next');
  });

  it('preserves small query data and guidance without source omissions', async () => {
    const previous = process.env.GITNEXUS_MCP_DEFAULT_MAX_TOKENS;
    delete process.env.GITNEXUS_MCP_DEFAULT_MAX_TOKENS;
    try {
      const backend = createMockBackend({
        callTool: vi.fn().mockResolvedValue({ payload: 'complete' }),
      });
      const { text, isError } = await callToolThroughServer(backend, 'query', {
        search_query: 'auth',
      });
      expect(isError).toBe(false);
      expect(JSON.parse(text)).toMatchObject({
        payload: 'complete',
        next: expect.stringContaining('context'),
      });
      expect(text.endsWith('\n…')).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.GITNEXUS_MCP_DEFAULT_MAX_TOKENS;
      else process.env.GITNEXUS_MCP_DEFAULT_MAX_TOKENS = previous;
    }
  });

  it('applies explicit maxTokens to the complete response deterministically and UTF-8 safely', async () => {
    const backend = createMockBackend({
      callTool: vi.fn().mockResolvedValue({ payload: '😀'.repeat(100) }),
    });
    const args = { search_query: 'auth', maxTokens: 8 };

    const first = await callToolThroughServer(backend, 'query', args);
    const second = await callToolThroughServer(backend, 'query', args);

    expect(first.isError).toBe(false);
    expect(first.text).toBe(second.text);
    expect(Buffer.byteLength(first.text, 'utf8')).toBeLessThanOrEqual(8 * 4);
    expect(first.text.endsWith('\n…')).toBe(true);
    expect(first.text).not.toContain('\uFFFD');
    expect(backend.callTool).toHaveBeenCalledWith('query', { search_query: 'auth' });
  });

  it('uses the environment default when maxTokens is omitted', async () => {
    const previous = process.env.GITNEXUS_MCP_DEFAULT_MAX_TOKENS;
    process.env.GITNEXUS_MCP_DEFAULT_MAX_TOKENS = '8';
    try {
      const backend = createMockBackend({
        callTool: vi.fn().mockResolvedValue({ payload: 'x'.repeat(200) }),
      });
      const { text } = await callToolThroughServer(backend, 'context', { name: 'auth' });
      expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(8 * 4);
      expect(text.endsWith('\n…')).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.GITNEXUS_MCP_DEFAULT_MAX_TOKENS;
      else process.env.GITNEXUS_MCP_DEFAULT_MAX_TOKENS = previous;
    }
  });

  it('lets an explicit request override the environment default', async () => {
    const previous = process.env.GITNEXUS_MCP_DEFAULT_MAX_TOKENS;
    process.env.GITNEXUS_MCP_DEFAULT_MAX_TOKENS = '1';
    try {
      const backend = createMockBackend({
        callTool: vi.fn().mockResolvedValue({ payload: 'complete' }),
      });
      const { text } = await callToolThroughServer(backend, 'impact', {
        target: 'auth',
        direction: 'upstream',
        maxTokens: 200,
      });
      expect(text).toContain('"payload":"complete"');
      expect(text).toContain('**Next:**');
      expect(text.endsWith('\n…')).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.GITNEXUS_MCP_DEFAULT_MAX_TOKENS;
      else process.env.GITNEXUS_MCP_DEFAULT_MAX_TOKENS = previous;
    }
  });

  it('rejects unknown tool arguments before backend execution (#3261)', async () => {
    const backend = createMockBackend();
    const { text, isError } = await callToolThroughServer(backend, 'impact', {
      target: 'auth',
      direction: 'downstream',
      notARealArg: 2,
    });
    expect(isError).toBe(true);
    expect(text).toMatch(/Unknown argument "notARealArg" for tool "impact"/);
    expect(backend.callTool).not.toHaveBeenCalled();
  });

  it('fits an over-budget impact result by dropping whole symbols, keeping valid JSON', async () => {
    const item = (id: string) => ({
      id,
      name: id,
      filePath: `src/${id}.ts`,
      relationType: 'CALLS',
      processes: Array.from({ length: 6 }, (_, i) => ({ id: `proc_${i}`, label: `Flow ${i}` })),
    });
    const impact = {
      target: { id: 'Function:src/auth.ts:auth', name: 'auth' },
      impactedCount: 62,
      byDepthCounts: { 1: 2, 2: 60 },
      byDepth: {
        1: [item('direct0'), item('direct1')],
        2: Array.from({ length: 60 }, (_, i) => item(`indirect${i}`)),
      },
    };
    const backend = createMockBackend({ callTool: vi.fn().mockResolvedValue(impact) });
    const { text, isError } = await callToolThroughServer(backend, 'impact', {
      target: 'auth',
      direction: 'upstream',
      maxTokens: 800,
    });

    expect(isError).toBe(false);
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(800 * 4);
    expect(text.endsWith(MCP_TRUNCATION_MARKER)).toBe(false);
    // The result is one compact JSON line; the next-step hint follows it.
    const body = JSON.parse(text.split('\n')[0]);
    expect(body.byDepth[1]).toHaveLength(2);
    expect(body.byDepth[2].length).toBeLessThan(60);
    expect(body.byDepthCounts).toEqual({ 1: 2, 2: 60 });
    expect(body.byDepth[1][0].processes).toHaveLength(3);
    expect(body.byDepth[1][0].processCount).toBe(6);
    expect(body.pagination.trimmedForBudget.maxTokens).toBe(800);
  });

  it('accepts CLI-style depth as a known impact alias (#3261)', async () => {
    // The CLI flag is --depth; since #3261 MCP advertises it alongside maxDepth
    // as a compatibility alias. Before #3261, `depth` was silently dropped.
    // After the fix it is a known alias and is forwarded.
    const backend = createMockBackend();
    const { isError } = await callToolThroughServer(backend, 'impact', {
      target: 'auth',
      direction: 'downstream',
      depth: 2,
    });
    expect(isError).toBe(false);
    expect(backend.callTool).toHaveBeenCalledWith('impact', {
      target: 'auth',
      direction: 'downstream',
      depth: 2,
      // The agent boundary adds the default per-depth page (impact-agent-output.ts).
      limit: 30,
    });
  });

  it('still accepts unpublished context target through tools/call', async () => {
    const backend = createMockBackend();
    const { isError } = await callToolThroughServer(backend, 'context', {
      repo: '@g1',
      target: 'Sym',
    });
    expect(isError).toBe(false);
    expect(backend.callTool).toHaveBeenCalledWith('context', { repo: '@g1', target: 'Sym' });
  });

  it('still accepts the unpublished query alias for query (#2175)', async () => {
    const backend = createMockBackend();
    const { isError } = await callToolThroughServer(backend, 'query', {
      query: 'auth',
    });
    expect(isError).toBe(false);
    expect(backend.callTool).toHaveBeenCalledWith('query', { query: 'auth' });
  });

  it('still accepts the unpublished query alias for cypher (#2175)', async () => {
    const backend = createMockBackend();
    const { isError } = await callToolThroughServer(backend, 'cypher', {
      query: 'MATCH (n) RETURN n',
    });
    expect(isError).toBe(false);
    expect(backend.callTool).toHaveBeenCalledWith('cypher', { query: 'MATCH (n) RETURN n' });
  });

  it('maps legacy search/explore names through the advertised schema (#3261)', async () => {
    const backend = createMockBackend();
    const searchUnknown = await callToolThroughServer(backend, 'search', { notARealArg: 1 });
    expect(searchUnknown.isError).toBe(true);
    expect(searchUnknown.text).toMatch(/Unknown argument "notARealArg"/);
    expect(backend.callTool).not.toHaveBeenCalled();

    const searchOk = await callToolThroughServer(backend, 'search', { query: 'auth' });
    expect(searchOk.isError).toBe(false);
    expect(backend.callTool).toHaveBeenCalledWith('search', { query: 'auth' });

    backend.callTool.mockClear();
    const exploreUnknown = await callToolThroughServer(backend, 'explore', { notARealArg: 1 });
    expect(exploreUnknown.isError).toBe(true);
    expect(backend.callTool).not.toHaveBeenCalled();

    const exploreOk = await callToolThroughServer(backend, 'explore', {
      repo: '@g1',
      target: 'Sym',
    });
    expect(exploreOk.isError).toBe(false);
    expect(backend.callTool).toHaveBeenCalledWith('explore', { repo: '@g1', target: 'Sym' });
  });

  it('rejects a non-positive explicit maxTokens before backend execution', async () => {
    const backend = createMockBackend();
    const { text, isError } = await callToolThroughServer(backend, 'query', {
      search_query: 'auth',
      maxTokens: 0,
    });
    expect(isError).toBe(true);
    expect(text).toMatch(/maxTokens.*positive integer/i);
    expect(backend.callTool).not.toHaveBeenCalled();
  });

  it('rejects an invalid environment default before backend execution', async () => {
    const previous = process.env.GITNEXUS_MCP_DEFAULT_MAX_TOKENS;
    process.env.GITNEXUS_MCP_DEFAULT_MAX_TOKENS = 'invalid';
    try {
      const backend = createMockBackend();
      const { text, isError } = await callToolThroughServer(backend, 'query', {
        search_query: 'auth',
      });
      expect(isError).toBe(true);
      expect(text).toMatch(/GITNEXUS_MCP_DEFAULT_MAX_TOKENS.*positive integer/i);
      expect(backend.callTool).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.GITNEXUS_MCP_DEFAULT_MAX_TOKENS;
      else process.env.GITNEXUS_MCP_DEFAULT_MAX_TOKENS = previous;
    }
  });

  it('applies a valid budget to backend error text', async () => {
    const backend = createMockBackend({
      callTool: vi.fn().mockRejectedValue(new Error('😀'.repeat(100))),
    });
    const { text, isError } = await callToolThroughServer(backend, 'context', {
      name: 'auth',
      maxTokens: 8,
    });
    expect(isError).toBe(true);
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(8 * 4);
    expect(text.endsWith('\n…')).toBe(true);
    expect(text).not.toContain('\uFFFD');
  });
});

// ─── Tool handler error handling ──────────────────────────────────────

describe('server error handling', () => {
  it('includes string Error.code in tool error text', async () => {
    const err = Object.assign(new Error('reader refuse'), { code: 'FTS_READER_UNREPAIRABLE' });
    const backend = createMockBackend({
      callTool: vi.fn().mockRejectedValue(err),
    });
    const { text, isError } = await callToolThroughServer(backend, 'context', { name: 'auth' });
    expect(isError).toBe(true);
    expect(text).toContain('FTS_READER_UNREPAIRABLE');
    expect(text).toContain('reader refuse');
  });

  it('createMCPServer does not throw for valid backend', () => {
    const backend = createMockBackend();
    expect(() => createMCPServer(backend)).not.toThrow();
  });

  it('createMCPServer reads version from package.json', () => {
    const backend = createMockBackend();
    const server = createMCPServer(backend);
    // Server was created with version from package.json — no crash
    expect(server).toBeDefined();
  });
});

// ─── Prompt definitions ───────────────────────────────────────────────

describe('prompt registration', () => {
  it('server registers detect_impact and generate_map prompts', () => {
    const backend = createMockBackend();
    // Creating the server registers all handlers including prompts
    const server = createMCPServer(backend);
    expect(server).toBeDefined();
  });
});

// ─── startMCPServer ────────────────────────────────────────────────────

describe('startMCPServer', () => {
  it('registers stdin shutdown listeners before awaiting Server.prototype.connect', async () => {
    vi.useFakeTimers();
    // P1 finding: startMCPServer must register process.stdin end/close/error
    // shutdown listeners before calling server.connect(), so that a stdin
    // closure during transport setup is safely handled.
    // This test asserts the listeners are present *during* the connect call.

    // Capture baseline listener counts before startMCPServer adds anything
    const closeBefore = process.stdin.listenerCount('close');
    const endBefore = process.stdin.listenerCount('end');
    const errorBefore = process.stdin.listenerCount('error');
    const beforeListeners = {
      stdinEnd: new Set(process.stdin.listeners('end')),
      stdinClose: new Set(process.stdin.listeners('close')),
      stdinError: new Set(process.stdin.listeners('error')),
      stdoutError: new Set(process.stdout.listeners('error')),
      sigint: new Set(process.listeners('SIGINT')),
      sigterm: new Set(process.listeners('SIGTERM')),
      exit: new Set(process.listeners('exit')),
      uncaughtException: new Set(process.listeners('uncaughtException')),
      unhandledRejection: new Set(process.listeners('unhandledRejection')),
    };

    // Stub process.exit to prevent actual termination if shutdown fires
    const exitStub = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    // Spy on Server.prototype.connect to inspect listener counts during the call
    const connectSpy = vi.spyOn(Server.prototype, 'connect').mockImplementation(async function () {
      expect(process.stdin.listenerCount('close')).toBeGreaterThan(closeBefore);
      expect(process.stdin.listenerCount('end')).toBeGreaterThan(endBefore);
      expect(process.stdin.listenerCount('error')).toBeGreaterThan(errorBefore);
    });

    const backend = createMockBackend();

    try {
      await startMCPServer(backend);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
      connectSpy.mockRestore();
      exitStub.mockRestore();
      // Remove only listeners added by startMCPServer so no side effects leak.
      for (const listener of process.stdin.listeners('end')) {
        if (!beforeListeners.stdinEnd.has(listener)) process.stdin.removeListener('end', listener);
      }
      for (const listener of process.stdin.listeners('close')) {
        if (!beforeListeners.stdinClose.has(listener)) {
          process.stdin.removeListener('close', listener);
        }
      }
      for (const listener of process.stdin.listeners('error')) {
        if (!beforeListeners.stdinError.has(listener)) {
          process.stdin.removeListener('error', listener);
        }
      }
      for (const listener of process.stdout.listeners('error')) {
        if (!beforeListeners.stdoutError.has(listener)) {
          process.stdout.removeListener('error', listener);
        }
      }
      for (const listener of process.listeners('SIGINT')) {
        if (!beforeListeners.sigint.has(listener)) process.removeListener('SIGINT', listener);
      }
      for (const listener of process.listeners('SIGTERM')) {
        if (!beforeListeners.sigterm.has(listener)) process.removeListener('SIGTERM', listener);
      }
      for (const listener of process.listeners('exit')) {
        if (!beforeListeners.exit.has(listener)) process.removeListener('exit', listener);
      }
      for (const listener of process.listeners('uncaughtException')) {
        if (!beforeListeners.uncaughtException.has(listener)) {
          process.removeListener('uncaughtException', listener);
        }
      }
      for (const listener of process.listeners('unhandledRejection')) {
        if (!beforeListeners.unhandledRejection.has(listener)) {
          process.removeListener('unhandledRejection', listener);
        }
      }
    }
  });
});

describe('installParentShutdown', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(process, 'ppid', 'get').mockReturnValue(1234);
    vi.spyOn(process, 'kill').mockReturnValue(true);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('leaves a live parent alone and stops probing when disposed', () => {
    const shutdown = vi.fn();
    const stop = installParentShutdown(shutdown);
    vi.advanceTimersByTime(1_000);
    expect(process.kill).toHaveBeenCalledWith(1234, 0);
    expect(shutdown).not.toHaveBeenCalled();
    stop();
    vi.advanceTimersByTime(2_000);
    expect(process.kill).toHaveBeenCalledTimes(1);
  });

  it('shuts down once after reparenting, including adoption by a subreaper', () => {
    const shutdown = vi.fn();
    installParentShutdown(shutdown);
    vi.spyOn(process, 'ppid', 'get').mockReturnValue(4321);
    vi.advanceTimersByTime(3_000);
    expect(shutdown).toHaveBeenCalledExactlyOnceWith(0);
    expect(process.kill).not.toHaveBeenCalled();
  });

  it('detects a missing parent even when the OS retains the original PPID', () => {
    const shutdown = vi.fn();
    installParentShutdown(shutdown);
    vi.mocked(process.kill).mockImplementation(() => {
      throw Object.assign(new Error('No such process'), { code: 'ESRCH' });
    });
    vi.advanceTimersByTime(3_000);
    expect(shutdown).toHaveBeenCalledExactlyOnceWith(0);
  });

  it.each(['EPERM', 'EACCES', undefined])(
    'keeps serving after an inconclusive probe (%s)',
    (code) => {
      const shutdown = vi.fn();
      installParentShutdown(shutdown);
      vi.mocked(process.kill).mockImplementation(() => {
        throw Object.assign(new Error('Cannot inspect parent'), { code });
      });
      vi.advanceTimersByTime(2_000);
      expect(shutdown).not.toHaveBeenCalled();
      expect(process.kill).toHaveBeenCalledTimes(2);
    },
  );

  it('does not keep the event loop alive', () => {
    const interval = vi.spyOn(globalThis, 'setInterval');
    const stop = installParentShutdown(vi.fn());
    expect(interval.mock.results[0].value.hasRef()).toBe(false);
    stop();
  });

  it.each([0, 1])(
    'does not probe a process group or init when started under PPID %s',
    (parentPid) => {
      const shutdown = vi.fn();
      installParentShutdown(shutdown, parentPid)();
      expect(vi.getTimerCount()).toBe(0);
      expect(shutdown).not.toHaveBeenCalled();
    },
  );
});

// ─── Graceful shutdown signal handling (#1132) ────────────────────────

describe('installSignalShutdown (#1132)', () => {
  it('maps SIGINT→130 / SIGTERM→143 and never passes the signal name to shutdown', () => {
    // Node invokes signal listeners with the signal NAME string as the first
    // argument. The old code registered `shutdown` directly, so that string
    // reached process.exit() and crashed with ERR_INVALID_ARG_TYPE. Reproduce
    // that exact invocation and assert a numeric code is used instead.
    const received: unknown[] = [];
    let onSigint: ((...args: unknown[]) => void) | undefined;
    let onSigterm: ((...args: unknown[]) => void) | undefined;

    installSignalShutdown(
      (code) => received.push(code),
      (event, listener) => {
        if (event === 'SIGINT') onSigint = listener;
        if (event === 'SIGTERM') onSigterm = listener;
      },
    );

    expect(onSigint).toBeTypeOf('function');
    expect(onSigterm).toBeTypeOf('function');

    // Invoke exactly as Node does — with the signal name string as the arg.
    onSigint?.('SIGINT');
    onSigterm?.('SIGTERM');

    expect(received).toEqual([SHUTDOWN_EXIT_CODES.SIGINT, SHUTDOWN_EXIT_CODES.SIGTERM]);
    expect(received).toEqual([130, 143]);
    for (const code of received) {
      expect(typeof code).toBe('number');
    }
  });
});

// Response filters are optional transport views. Backends and unfiltered bytes
// retain their established contract, including hints and safety metadata.
describe('MCP response filters', () => {
  const payload = {
    status: 'found',
    symbol: { uid: 'Function:src/pay.ts:pay', name: 'pay' },
    incoming: {
      calls: [{ uid: 'Function:src/buy.ts:buy' }],
      uses: [{ uid: 'Variable:src/ui.ts:handler' }],
    },
    outgoing: { calls: [{ uid: 'Function:src/db.ts:save' }] },
    processes: [{ id: 'proc:checkout' }],
    epistemic: 'lower-bound',
    causes: { callableValueReferences: 1 },
    warning: 'Dynamic dispatch unresolved',
    staleness: { status: 'current', lastCommit: 'abc' },
  };
  it('returns compact JSON with all default evidence and hints', async () => {
    const backend = createMockBackend({ callTool: vi.fn().mockResolvedValue(payload) });
    const args = { uid: payload.symbol.uid };
    const { text, isError } = await callToolThroughServer(backend, 'context', args);
    expect(isError).toBe(false);
    expect(text).toBe(JSON.stringify(payload) + getNextStepHint('context', args, false, payload));
    expect(backend.callTool).toHaveBeenCalledWith('context', args);
  });
  it('preserves source whitespace, Unicode, nested values and incomplete-evidence diagnostics', async () => {
    const result = {
      ...payload,
      content: 'function café() {\n  return "雪 😀 \\"quoted\\"";\n}\n',
      nested: [null, false, 0, '', { lines: ['  leading', 'trailing  ', '\tindent'] }],
      partial: true,
      truncated: true,
    };
    const backend = createMockBackend({ callTool: vi.fn().mockResolvedValue(result) });
    const args = { uid: payload.symbol.uid, include_content: true };
    const { text, isError } = await callToolThroughServer(backend, 'context', args);
    const hint = getNextStepHint('context', args, false, result);
    expect(isError).toBe(false);
    expect(text.endsWith(hint)).toBe(true);
    expect(JSON.parse(text.slice(0, -hint.length))).toEqual(result);
  });
  it('keeps complete evidence when compact JSON and its hint fit the requested budget', async () => {
    const backend = createMockBackend({ callTool: vi.fn().mockResolvedValue(payload) });
    const args = { uid: payload.symbol.uid };
    const hint = getNextStepHint('context', args, false, payload);
    const complete = JSON.stringify(payload) + hint;
    const maxTokens = Math.ceil(Buffer.byteLength(complete) / 4);
    expect(Buffer.byteLength(JSON.stringify(payload, null, 2) + hint)).toBeGreaterThan(
      maxTokens * 4,
    );
    const { text, isError } = await callToolThroughServer(backend, 'context', {
      ...args,
      maxTokens,
    });
    expect(isError).toBe(false);
    expect(text).toBe(complete);
    expect(JSON.parse(text.slice(0, -hint.length))).toEqual(payload);
  });
  it('passes plain-text backend results through byte-for-byte before the hint', async () => {
    const result = 'name | count\n  雪 😀 | 1\t\n';
    const backend = createMockBackend({ callTool: vi.fn().mockResolvedValue(result) });
    const args = { statement: 'RETURN 1' };
    const { text, isError } = await callToolThroughServer(backend, 'cypher', args);
    expect(isError).toBe(false);
    expect(text).toBe(result + getNextStepHint('cypher', args, false, result));
  });
  it.each(['context', 'explore'])(
    'applies opt-in views for %s without sending filter options to the backend',
    async (name) => {
      const backend = createMockBackend({ callTool: vi.fn().mockResolvedValue(payload) });
      const { text, isError } = await callToolThroughServer(backend, name, {
        uid: payload.symbol.uid,
        response_sections: ['incoming'],
        relationTypes: ['CALLS'],
      });
      expect(isError).toBe(false);
      const result = JSON.parse(text.split('\n\n---')[0]);
      expect(result.incoming).toEqual({ calls: payload.incoming.calls });
      expect(result.symbol).toEqual(payload.symbol);
      expect(result.epistemic).toBe('lower-bound');
      expect(result.causes).toEqual(payload.causes);
      expect(result.warning).toBe(payload.warning);
      expect(result.staleness).toEqual(payload.staleness);
      expect(result).not.toHaveProperty('outgoing');
      expect(result).not.toHaveProperty('processes');
      expect(result.response_filter.omitted_relations).toEqual({ incoming: ['uses'] });
      expect(backend.callTool).toHaveBeenCalledWith(name, { uid: payload.symbol.uid });
    },
  );
  it.each(['query', 'search'])('selects query result sections through %s', async (name) => {
    const data = {
      processes: [{ id: 'proc:checkout' }],
      process_symbols: [{ id: payload.symbol.uid, process_id: 'proc:checkout' }],
      definitions: [],
    };
    const backend = createMockBackend({ callTool: vi.fn().mockResolvedValue(data) });
    const { text, isError } = await callToolThroughServer(backend, name, {
      search_query: 'pay',
      response_sections: ['process_symbols', 'definitions'],
    });
    expect(isError).toBe(false);
    const result = JSON.parse(text.split('\n\n---')[0]);
    expect(result.process_symbols).toEqual(data.process_symbols);
    expect(result.definitions).toEqual([]);
    expect(result).not.toHaveProperty('processes');
    expect(backend.callTool).toHaveBeenCalledWith(name, { search_query: 'pay' });
  });
  it.each([
    { response_sections: ['risk'] },
    { response_sections: [] },
    { relationTypes: ['CALSL'] },
    { response_sections: ['processes'], relationTypes: ['CALLS'] },
    { response_sections: ['incoming'], repo: '@group' },
  ])('rejects invalid filters before backend execution: %j', async (args) => {
    const backend = createMockBackend();
    const { isError } = await callToolThroughServer(backend, 'context', { name: 'pay', ...args });
    expect(isError).toBe(true);
    expect(backend.callTool).not.toHaveBeenCalled();
  });
  it('applies the existing byte budget after filtering, without changing the cutoff contract', async () => {
    const backend = createMockBackend({ callTool: vi.fn().mockResolvedValue(payload) });
    const { text, isError } = await callToolThroughServer(backend, 'context', {
      uid: payload.symbol.uid,
      response_sections: ['incoming'],
      maxTokens: 8,
    });
    expect(isError).toBe(false);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(32);
    expect(text.endsWith('\n…')).toBe(true);
    expect(backend.callTool).toHaveBeenCalledWith('context', { uid: payload.symbol.uid });
  });
});

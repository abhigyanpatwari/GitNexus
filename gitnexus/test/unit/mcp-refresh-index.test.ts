import type http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMCPServer } from '../../src/mcp/server.js';
import { startMcpHttpServer } from '../../src/mcp/http-transport.js';
import type { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { createMcpRepositoryPolicy } from '../../src/mcp/repository-policy.js';
import { mountMCPEndpoints } from '../../src/server/mcp-http.js';
import {
  MCP_REFRESH_DEFAULT_MAX_FILES,
  MCP_REFRESH_DEFAULT_TIMEOUT_MS,
  resolveMcpRefreshLimits,
  resolveMcpRefreshMode,
} from '../../src/mcp/refresh-policy.js';

const REPOS = [
  { name: 'Alpha', path: '/repos/alpha', indexedAt: '2026-01-01', lastCommit: 'a'.repeat(40) },
  { name: 'Beta', path: '/repos/beta', indexedAt: '2026-01-02', lastCommit: 'b'.repeat(40) },
];

function createMockBackend() {
  return {
    callTool: vi.fn().mockResolvedValue({ status: 'refreshed' }),
    listRepos: vi.fn().mockResolvedValue(REPOS.map((repo) => ({ ...repo }))),
    countRepos: vi.fn().mockResolvedValue(REPOS.length),
    cachedRepoCount: vi.fn().mockReturnValue(REPOS.length),
    resolveRepo: vi
      .fn()
      .mockResolvedValue({ name: 'test', repoPath: '/tmp/test', lastCommit: 'abc' }),
    getContext: vi.fn().mockReturnValue(null),
    disconnect: vi.fn().mockResolvedValue(undefined),
  };
}

async function connect(
  options: Parameters<typeof createMCPServer>[1] = {},
  backend = createMockBackend(),
) {
  const server = createMCPServer(backend as unknown as LocalBackend, options);
  const client = new Client({ name: 'refresh-test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    backend,
    client,
    serverTransport,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('refresh_index MCP gate (#3524)', () => {
  it('is absent and rejected by default, even when the environment asks for it', async () => {
    // `gitnexus serve` creates its MCP servers without the option, so its
    // environment alone must not be able to expose the tool.
    vi.stubEnv('GITNEXUS_MCP_ENABLE_REFRESH', '1');
    const session = await connect();
    try {
      const { tools } = await session.client.listTools();
      expect(tools.map((tool) => tool.name)).not.toContain('refresh_index');

      const response = await session.client.callTool({
        name: 'refresh_index',
        arguments: { repo: 'test' },
      });
      expect(response.isError).toBe(true);
      expect(JSON.stringify(response.content)).toContain('GITNEXUS_MCP_ENABLE_REFRESH=1');
      expect(session.backend.callTool).not.toHaveBeenCalled();
    } finally {
      await session.close();
    }
  });

  it('is listed as a non-destructive write when the local server enables it', async () => {
    const session = await connect({ refreshIndex: true });
    try {
      const { tools } = await session.client.listTools();
      const refresh = tools.find((tool) => tool.name === 'refresh_index');
      expect(refresh?.annotations).toEqual({
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
      expect(Object.keys(refresh?.inputSchema.properties ?? {}).sort()).toEqual([
        'dry_run',
        'repo',
      ]);

      session.backend.callTool.mockResolvedValueOnce({ status: 'dry_run', wouldRefresh: true });
      const response = await session.client.callTool({
        name: 'refresh_index',
        arguments: { repo: 'test', dry_run: true },
      });
      expect(response.isError).not.toBe(true);
      // A dry run changes nothing, so it gets no next step.
      expect(JSON.stringify(response.content)).not.toContain('**Next:**');
      // No progress token, so nothing beyond the arguments reaches the backend.
      expect(session.backend.callTool).toHaveBeenCalledWith('refresh_index', {
        repo: 'test',
        dry_run: true,
      });
    } finally {
      await session.close();
    }
  });

  it('rejects a branch pin before dispatch', async () => {
    const session = await connect({ refreshIndex: true });
    try {
      const response = await session.client.callTool({
        name: 'refresh_index',
        arguments: { repo: 'test', branch: 'main' },
      });
      expect(response.isError).toBe(true);
      expect(session.backend.callTool).not.toHaveBeenCalled();
    } finally {
      await session.close();
    }
  });

  it('stays hidden and rejected in read-only mode even when enabled', async () => {
    vi.stubEnv('GITNEXUS_MCP_READ_ONLY', '1');
    const session = await connect({ refreshIndex: true });
    try {
      const { tools } = await session.client.listTools();
      expect(tools.map((tool) => tool.name)).not.toContain('refresh_index');

      const response = await session.client.callTool({
        name: 'refresh_index',
        arguments: { repo: 'test', dry_run: true },
      });
      expect(response.isError).toBe(true);
      expect(JSON.stringify(response.content)).toContain('read-only mode');
      expect(session.backend.callTool).not.toHaveBeenCalled();
    } finally {
      await session.close();
    }
  });

  it('forwards strictly increasing progress and clamps it to the advertised total', async () => {
    const backend = createMockBackend();
    backend.callTool.mockImplementation(
      async (
        _method: string,
        _args: unknown,
        context?: { onProgress?: (progress: number, message: string) => Promise<void> },
      ) => {
        await context?.onProgress?.(0, 'starting');
        await context?.onProgress?.(10, 'parsing');
        await context?.onProgress?.(10, 'repeated');
        await context?.onProgress?.(5, 'decreasing');
        await context?.onProgress?.(90, 'communities');
        await context?.onProgress?.(105, 'complete');
        await context?.onProgress?.(100, 'repeated completion');
        await context?.onProgress?.(150, 'above total again');
        return { status: 'refreshed' };
      },
    );
    const session = await connect({ refreshIndex: true }, backend);
    try {
      const updates: Array<{ progress: number; total?: number; message?: string }> = [];
      const response = await session.client.callTool(
        { name: 'refresh_index', arguments: { repo: 'test' } },
        undefined,
        { onprogress: (update) => updates.push(update), resetTimeoutOnProgress: true },
      );
      expect(response.isError).not.toBe(true);
      expect(JSON.stringify(response.content)).toContain('it now reads the refreshed one');
      expect(updates).toEqual([
        { progress: 0, total: 100, message: 'starting' },
        { progress: 10, total: 100, message: 'parsing' },
        { progress: 90, total: 100, message: 'communities' },
        { progress: 100, total: 100, message: 'complete' },
      ]);
    } finally {
      await session.close();
    }
  });

  it('finishes the refresh and sends later progress when a notification send rejects', async () => {
    const backend = createMockBackend();
    backend.callTool.mockImplementation(
      async (
        _method: string,
        _args: unknown,
        context?: { onProgress?: (progress: number, message: string) => Promise<void> },
      ) => {
        await context?.onProgress?.(10, 'parsing');
        await context?.onProgress?.(90, 'communities');
        return { status: 'refreshed' };
      },
    );
    const session = await connect({ refreshIndex: true }, backend);
    const send = session.serverTransport.send.bind(session.serverTransport);
    const rejected = vi.fn();
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    const spy = vi
      .spyOn(session.serverTransport, 'send')
      .mockImplementation(async (message, options) => {
        if (
          'method' in message &&
          message.method === 'notifications/progress' &&
          message.params?.progress === 10
        ) {
          rejected();
          throw new Error('notification transport unavailable');
        }
        await send(message, options);
      });
    try {
      const updates: Array<{ progress: number; total?: number; message?: string }> = [];
      const response = await session.client.callTool(
        { name: 'refresh_index', arguments: { repo: 'test' } },
        undefined,
        { onprogress: (update) => updates.push(update) },
      );
      expect(rejected).toHaveBeenCalledOnce();
      expect(response.isError).not.toBe(true);
      expect(JSON.stringify(response.content)).toContain('refreshed');
      expect(updates).toEqual([{ progress: 90, total: 100, message: 'communities' }]);
      // The suite tolerates native teardown errors globally, so assert this
      // rejection explicitly after Node has had a turn to report it.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
      spy.mockRestore();
      await session.close();
    }
  });
});

describe('refresh_index repository policy (#3524)', () => {
  it('keeps a refresh inside the MCP repository allowlist', async () => {
    const backend = createMockBackend();
    const repositoryPolicy = await createMcpRepositoryPolicy(backend as unknown as LocalBackend, {
      GITNEXUS_MCP_ALLOWED_REPOS: 'Alpha',
    });
    const session = await connect({ refreshIndex: true, repositoryPolicy }, backend);
    try {
      const denied = await session.client.callTool({
        name: 'refresh_index',
        arguments: { repo: '/repos/beta' },
      });
      expect(denied.isError).toBe(true);
      expect(backend.callTool).not.toHaveBeenCalled();

      await session.client.callTool({ name: 'refresh_index', arguments: {} });
      expect(backend.callTool).toHaveBeenCalledWith('refresh_index', { repo: '/repos/alpha' });
    } finally {
      await session.close();
    }
  });
});

describe('refresh_index over HTTP (#3524)', () => {
  const servers: http.Server[] = [];
  afterEach(async () => {
    for (const server of servers.splice(0)) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  // The DNS-rebinding guard allows the configured port, so port 0 cannot be used here.
  async function freePort(): Promise<number> {
    const probe = net.createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const { port } = probe.address() as AddressInfo;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    return port;
  }

  async function toolNames(transport: StreamableHTTPClientTransport | SSEClientTransport) {
    const client = new Client({ name: 'refresh-http-client', version: '0.0.0' });
    await client.connect(transport);
    try {
      return (await client.listTools()).tools.map((tool) => tool.name);
    } finally {
      await client.close();
    }
  }

  it.each([
    [true, true],
    [undefined, false],
  ])('gitnexus mcp --http with refreshIndex=%s lists it: %s', async (refreshIndex, listed) => {
    const port = await freePort();
    const server = await startMcpHttpServer(createMockBackend() as unknown as LocalBackend, {
      port,
      host: '127.0.0.1',
      refreshIndex,
    });
    servers.push(server);
    const base = `http://127.0.0.1:${port}`;
    for (const transport of [
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`)),
      new SSEClientTransport(new URL(`${base}/sse`)),
    ]) {
      expect((await toolNames(transport)).includes('refresh_index')).toBe(listed);
    }
  });

  it('is never listed on the serve /api/mcp surface, even with the variable set', async () => {
    vi.stubEnv('GITNEXUS_MCP_ENABLE_REFRESH', '1');
    const app = express();
    app.use(express.json());
    const cleanup = await mountMCPEndpoints(app, createMockBackend() as unknown as LocalBackend);
    const server = await new Promise<http.Server>((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    servers.push(server);
    try {
      const port = (server.address() as AddressInfo).port;
      const names = await toolNames(
        new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/api/mcp`)),
      );
      expect(names).toContain('list_repos');
      expect(names).not.toContain('refresh_index');
    } finally {
      await cleanup();
    }
  });
});

describe('refresh policy environment', () => {
  it.each([
    [undefined, false],
    ['', false],
    ['0', false],
    ['1', true],
  ])('reads GITNEXUS_MCP_ENABLE_REFRESH=%s as %s', (value, expected) => {
    expect(resolveMcpRefreshMode({ GITNEXUS_MCP_ENABLE_REFRESH: value })).toBe(expected);
  });

  it.each(['true', 'yes', '2'])('fails startup for malformed enable value %s', (value) => {
    expect(() => resolveMcpRefreshMode({ GITNEXUS_MCP_ENABLE_REFRESH: value })).toThrow(
      /GITNEXUS_MCP_ENABLE_REFRESH must be 0 or 1/,
    );
  });

  it('defaults the size and time limits, and accepts 0 files as no limit', () => {
    expect(resolveMcpRefreshLimits({})).toEqual({
      maxFiles: MCP_REFRESH_DEFAULT_MAX_FILES,
      timeoutMs: MCP_REFRESH_DEFAULT_TIMEOUT_MS,
    });
    expect(
      resolveMcpRefreshLimits({
        GITNEXUS_MCP_REFRESH_MAX_FILES: '0',
        GITNEXUS_MCP_REFRESH_TIMEOUT_MS: '30000',
      }),
    ).toEqual({ maxFiles: 0, timeoutMs: 30_000 });
    expect(
      resolveMcpRefreshLimits({ GITNEXUS_MCP_REFRESH_TIMEOUT_MS: '2147483647' }).timeoutMs,
    ).toBe(2_147_483_647);
  });

  it.each([
    ['GITNEXUS_MCP_REFRESH_MAX_FILES', '-1'],
    ['GITNEXUS_MCP_REFRESH_MAX_FILES', '1e3'],
    ['GITNEXUS_MCP_REFRESH_TIMEOUT_MS', '0'],
    ['GITNEXUS_MCP_REFRESH_TIMEOUT_MS', 'ten'],
    // Node would fire a longer timer after 1 ms and cancel every refresh.
    ['GITNEXUS_MCP_REFRESH_TIMEOUT_MS', '2147483648'],
  ])('rejects %s=%s', (name, value) => {
    expect(() => resolveMcpRefreshLimits({ [name]: value })).toThrow(new RegExp(name));
  });
});

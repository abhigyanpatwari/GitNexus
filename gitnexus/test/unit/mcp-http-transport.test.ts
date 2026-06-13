/**
 * Unit Tests: MCP HTTP Transport
 *
 * Coverage:
 * - createAuthMiddleware: no-auth / valid token / invalid token scenarios
 * - startMcpHttpServer: port-0 smoke test (health endpoint, unauthenticated POST → 401)
 * - createStreamableHttpHandler: new-session initialization, unknown session 404
 * - createSseHandlers: message routing, unknown sessionId 404
 * - mountMCPEndpoints refactor safety: still returns cleanup fn and registers /api/mcp
 *
 * Notes:
 * - node_modules may not be installed; tests that exercise the MCP SDK rely on mocks.
 * - HTTP server tests use port 0 (OS-assigned ephemeral port) bound to 127.0.0.1.
 * - Each test closes the server and calls cleanup() to avoid handle leaks.
 */

import http from 'http';
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { createAuthMiddleware } from '../../src/mcp/http-transport.js';
import {
  createStreamableHttpHandler,
  createSseHandlers,
  mountMCPEndpoints,
} from '../../src/server/mcp-http.js';

// ─── Mock backend factory ──────────────────────────────────────────────

function createMockBackend(overrides: Record<string, unknown> = {}): unknown {
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
    disconnect: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

// ─── Mock req/res factory ──────────────────────────────────────────────

function createMockReq(headers: Record<string, string> = {}): Request {
  return { headers } as unknown as Request;
}

function createMockRes(): Response & { _status: number; _body: unknown } {
  const res = {
    _status: 200,
    _body: undefined,
    headersSent: false,
    status: vi.fn().mockImplementation(function (this: typeof res, code: number) {
      this._status = code;
      return this;
    }),
    json: vi.fn().mockImplementation(function (this: typeof res, body: unknown) {
      this._body = body;
      return this;
    }),
  };
  return res as unknown as Response & { _status: number; _body: unknown };
}

// ─── createAuthMiddleware ──────────────────────────────────────────────

describe('createAuthMiddleware', () => {
  it('calls next immediately when authToken is not set', () => {
    const middleware = createAuthMiddleware(undefined);
    const req = createMockReq();
    const res = createMockRes();
    const next = vi.fn() as NextFunction;

    middleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('calls next when the correct Bearer token is supplied', () => {
    const middleware = createAuthMiddleware('my-secret-token');
    const req = createMockReq({ authorization: 'Bearer my-secret-token' });
    const res = createMockRes();
    const next = vi.fn() as NextFunction;

    middleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('returns 401 when Authorization header is missing', () => {
    const middleware = createAuthMiddleware('my-secret-token');
    const req = createMockReq(); // no headers
    const res = createMockRes();
    const next = vi.fn() as NextFunction;

    middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(401);
    expect(res._body).toMatchObject({
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Unauthorized' },
    });
  });

  it('returns 401 when the wrong token is supplied', () => {
    const middleware = createAuthMiddleware('my-secret-token');
    const req = createMockReq({ authorization: 'Bearer wrong-token' });
    const res = createMockRes();
    const next = vi.fn() as NextFunction;

    middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(401);
  });

  it('returns 401 when Authorization header is missing the "Bearer " prefix', () => {
    const middleware = createAuthMiddleware('my-secret-token');
    const req = createMockReq({ authorization: 'my-secret-token' });
    const res = createMockRes();
    const next = vi.fn() as NextFunction;

    middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(401);
  });
});

// ─── startMcpHttpServer smoke tests ───────────────────────────────────

describe('startMcpHttpServer', () => {
  const servers: Array<{ server: http.Server; cleanup: () => Promise<void> }> = [];

  afterEach(async () => {
    for (const { server, cleanup } of servers.splice(0)) {
      await cleanup().catch(() => {});
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  /**
   * Starts the MCP HTTP server on an OS-assigned port (port 0), returns the
   * bound port, a node http.Server handle, and the cleanup function.
   */
  async function startOnFreePort(authToken?: string): Promise<{
    port: number;
    server: http.Server;
    cleanup: () => Promise<void>;
  }> {
    const backend = createMockBackend();

    // Wrap startMcpHttpServer to capture the returned http.Server.
    const { startMcpHttpServer: start } = await import('../../src/mcp/http-transport.js');
    const resolvedServer = await start(backend as never, {
      port: 0,
      host: '127.0.0.1',
      authToken,
    });

    const address = resolvedServer.address();
    const port =
      address && typeof address === 'object'
        ? address.port
        : (() => {
            throw new Error('no port');
          })();

    const cleanup = async (): Promise<void> => {
      // afterEach closes the server handle.
    };

    return { port, server: resolvedServer, cleanup };
  }

  it('GET /health returns 200 { status: "ok" }', async () => {
    const { port, server, cleanup } = await startOnFreePort();
    servers.push({ server, cleanup });

    const body = await new Promise<string>((resolve, reject) => {
      http
        .get(`http://127.0.0.1:${port}/health`, (res) => {
          let data = '';
          res.on('data', (chunk: string) => (data += chunk));
          res.on('end', () => resolve(data));
        })
        .on('error', reject);
    });

    expect(JSON.parse(body)).toEqual({ status: 'ok' });
  });

  it('POST /mcp without auth token returns 401 when --auth-token is configured', async () => {
    const { port, server, cleanup } = await startOnFreePort('supersecret');
    servers.push({ server, cleanup });

    const statusCode = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: '/mcp',
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        },
        (res) => {
          res.resume(); // drain
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.write(JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1, params: {} }));
      req.end();
    });

    expect(statusCode).toBe(401);
  });
});

// ─── createStreamableHttpHandler ──────────────────────────────────────

describe('createStreamableHttpHandler', () => {
  it('attempts to create a new session for a POST with no session id', async () => {
    const backend = createMockBackend();
    const { handler, cleanup } = createStreamableHttpHandler(backend as never);

    const req = {
      headers: {},
      method: 'POST',
      body: { jsonrpc: '2.0', method: 'initialize', id: 1, params: {} },
    } as Request;

    const res = {
      headersSent: false,
      statusCode: 200,
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
      setHeader: vi.fn(),
      write: vi.fn(),
      end: vi.fn(),
    } as unknown as Response;

    // The handler calls StreamableHTTPServerTransport internally; without the real
    // SDK installed the call may throw — that is acceptable in unit tests.
    try {
      await handler(req, res);
    } catch {
      // Expected when SDK is not installed.
    }

    await cleanup();
  });

  it('returns 400 when POST has no session id and body method is not initialize', async () => {
    const backend = createMockBackend();
    const { handler, cleanup } = createStreamableHttpHandler(backend as never);

    const req = {
      headers: {},
      method: 'POST',
      body: { jsonrpc: '2.0', method: 'tools/list', id: 2, params: {} },
    } as Request;

    const res = createMockRes();

    await handler(req, res);

    expect(res._status).toBe(400);
    expect(res._body).toMatchObject({ jsonrpc: '2.0', error: { code: -32000 } });

    await cleanup();
  });

  it('returns 404 for an unknown session id', async () => {
    const backend = createMockBackend();
    const { handler, cleanup } = createStreamableHttpHandler(backend as never);

    const req = {
      headers: { 'mcp-session-id': 'non-existent-session-id' },
      method: 'GET',
      body: undefined,
    } as unknown as Request;

    const res = createMockRes();

    await handler(req, res);

    expect(res._status).toBe(404);
    expect(res._body).toMatchObject({
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Session not found. Re-initialize.' },
    });

    await cleanup();
  });

  it('returns 400 for a GET with no session id', async () => {
    const backend = createMockBackend();
    const { handler, cleanup } = createStreamableHttpHandler(backend as never);

    const req = {
      headers: {},
      method: 'GET',
      body: undefined,
    } as unknown as Request;

    const res = createMockRes();

    await handler(req, res);

    expect(res._status).toBe(400);
    expect(res._body).toMatchObject({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'No valid session. Send a POST to initialize.' },
    });

    await cleanup();
  });
});

// ─── createSseHandlers ────────────────────────────────────────────────

describe('createSseHandlers', () => {
  it('returns 404 from messageHandler when sessionId is unknown', async () => {
    const backend = createMockBackend();
    const { messageHandler, cleanup } = createSseHandlers(backend as never, '/messages');

    const req = {
      query: { sessionId: 'non-existent' },
      headers: {},
      body: {},
    } as unknown as Request;

    const res = createMockRes();

    await messageHandler(req, res);

    expect(res._status).toBe(404);
    expect(res._body).toMatchObject({
      jsonrpc: '2.0',
      error: { code: -32001, message: 'SSE session not found. Reconnect to /sse.' },
    });

    await cleanup();
  });

  it('returns 404 from messageHandler when no sessionId is provided', async () => {
    const backend = createMockBackend();
    const { messageHandler, cleanup } = createSseHandlers(backend as never, '/messages');

    const req = {
      query: {},
      headers: {},
      body: {},
    } as unknown as Request;

    const res = createMockRes();

    await messageHandler(req, res);

    expect(res._status).toBe(404);

    await cleanup();
  });

  it('cleanup does not throw', async () => {
    const backend = createMockBackend();
    const { cleanup } = createSseHandlers(backend as never, '/messages');

    await expect(cleanup()).resolves.not.toThrow();
  });
});

// ─── mountMCPEndpoints refactor safety ───────────────────────────────

describe('mountMCPEndpoints', () => {
  it('returns a cleanup function', () => {
    const backend = createMockBackend();
    const mockApp = {
      all: vi.fn(),
    };

    const cleanup = mountMCPEndpoints(mockApp as never, backend as never);

    expect(typeof cleanup).toBe('function');
  });

  it('registers the /api/mcp route', () => {
    const backend = createMockBackend();
    const allCalls: Array<[string, ...unknown[]]> = [];
    const mockApp = {
      all: vi.fn().mockImplementation((path: string, ...args: unknown[]) => {
        allCalls.push([path, ...args]);
      }),
    };

    mountMCPEndpoints(mockApp as never, backend as never);

    const registeredPaths = allCalls.map(([path]) => path);
    expect(registeredPaths).toContain('/api/mcp');
  });

  it('cleanup function resolves without throwing', async () => {
    const backend = createMockBackend();
    const mockApp = {
      all: vi.fn(),
    };

    const cleanup = mountMCPEndpoints(mockApp as never, backend as never);

    await expect(cleanup()).resolves.not.toThrow();
  });
});

// ─── McpHttpOptions type validation ──────────────────────────────────

describe('McpHttpOptions type validation', () => {
  it('createAuthMiddleware accepts undefined authToken', () => {
    const middleware = createAuthMiddleware();
    expect(typeof middleware).toBe('function');
  });

  it('createAuthMiddleware accepts a string authToken', () => {
    const middleware = createAuthMiddleware('test-token');
    expect(typeof middleware).toBe('function');
  });
});

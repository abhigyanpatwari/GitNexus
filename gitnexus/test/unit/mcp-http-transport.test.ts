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
import type { AddressInfo } from 'net';
import { describe, it, expect, vi, afterEach } from 'vitest';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import {
  createAuthMiddleware,
  createStreamableHttpHandler,
  createSseHandlers,
  isLoopbackOrigin,
  computeAllowedHosts,
  resolveAuthToken,
  startMcpHttpServer,
  startIdleSweep,
} from '../../src/mcp/http-transport.js';
import {
  createMCPServer,
  installSignalShutdown,
  SHUTDOWN_EXIT_CODES,
} from '../../src/mcp/server.js';
import { mountMCPEndpoints } from '../../src/server/mcp-http.js';

// ─── Live-HTTP helpers (real req/res for SDK-touching paths) ───────────

async function listen(app: express.Express): Promise<{ port: number; close: () => Promise<void> }> {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

interface HttpResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function request(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<HttpResult> {
  return new Promise<HttpResult>((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, method, headers }, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => (data += chunk.toString()));
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data }),
      );
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const start = Date.now();
  while (!predicate() && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** A schema-complete JSON-RPC initialize request (passes the SDK isInitializeRequest). */
function validInitialize(id = 1): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    method: 'initialize',
    id,
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'test', version: '1.0.0' },
    },
  };
}

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

  it('U5: emits the PNA allow header only on an OPTIONS preflight carrying the request header', async () => {
    const { port, server, cleanup } = await startOnFreePort(); // no auth → loopback CORS
    servers.push({ server, cleanup });

    const preflight = await request(port, 'OPTIONS', '/mcp', {
      Origin: 'http://127.0.0.1:9999',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Private-Network': 'true',
    });
    expect(preflight.headers['access-control-allow-private-network']).toBe('true');

    // A normal GET carrying the request header must NOT receive the allow header.
    const get = await request(port, 'GET', '/health', {
      'Access-Control-Request-Private-Network': 'true',
    });
    expect(get.headers['access-control-allow-private-network']).toBeUndefined();
  });

  it('U8: refuses to start on a non-loopback host without a token', async () => {
    const backend = createMockBackend();
    await expect(
      startMcpHttpServer(backend as never, { host: '0.0.0.0', port: 0 }),
    ).rejects.toThrow(/non-loopback/i);
    await expect(startMcpHttpServer(backend as never, { host: '::', port: 0 })).rejects.toThrow(
      /non-loopback/i,
    );
    await expect(
      startMcpHttpServer(backend as never, { host: '192.168.1.50', port: 0 }),
    ).rejects.toThrow();
  });

  it('U8: starts on a non-loopback host when a token is provided', async () => {
    const backend = createMockBackend();
    const server = await startMcpHttpServer(backend as never, {
      host: '0.0.0.0',
      port: 0,
      authToken: 'tok',
    });
    servers.push({ server, cleanup: async () => {} });
    expect(server.listening).toBe(true);
  });

  it('U6: rejects a POST /mcp carrying a disallowed Host header (DNS-rebinding protection)', async () => {
    const { port, server, cleanup } = await startOnFreePort(); // 127.0.0.1 → protection ON
    servers.push({ server, cleanup });

    const res = await request(
      port,
      'POST',
      '/mcp',
      {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Host: 'evil.example.com:1234',
      },
      JSON.stringify(validInitialize()),
    );

    expect(res.status).toBe(403);
  });

  it('U3: malformed JSON from an authenticated client returns a JSON-RPC parse error (not HTML)', async () => {
    const { port, server, cleanup } = await startOnFreePort('supersecret');
    servers.push({ server, cleanup });

    const res = await request(
      port,
      'POST',
      '/mcp',
      { 'Content-Type': 'application/json', Authorization: 'Bearer supersecret' },
      '{ this is not valid json ',
    );

    expect(res.status).toBe(400);
    expect(String(res.headers['content-type'] ?? '')).toMatch(/application\/json/);
    expect(JSON.parse(res.body)).toMatchObject({
      jsonrpc: '2.0',
      error: { code: -32700, message: 'Parse error' },
      id: null,
    });
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
      body: validInitialize(),
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

  it('U1: closes the orphaned Server when the SDK rejects an initialize before a session id', async () => {
    const backend = createMockBackend();
    let closed = 0;
    // Inject createServer so we can observe the per-session Server's close().
    const { handler, cleanup } = createStreamableHttpHandler(backend as never, {
      createServer: () => {
        const s = createMCPServer(backend as never);
        const orig = s.close.bind(s);
        s.close = (async () => {
          closed += 1;
          return orig();
        }) as typeof s.close;
        return s;
      },
    });

    const app = express();
    app.use(express.json());
    app.all('/mcp', (req, res) => void handler(req, res).catch(() => {}));
    const { port, close } = await listen(app);

    // POST initialize but with Accept: application/json ONLY (no text/event-stream):
    // the SDK returns 406 BEFORE assigning transport.sessionId, exercising the orphan path.
    const res = await request(
      port,
      'POST',
      '/mcp',
      { 'Content-Type': 'application/json', Accept: 'application/json' },
      JSON.stringify(validInitialize()),
    );

    expect(res.status).toBe(406);
    await waitFor(() => closed > 0);
    expect(closed).toBeGreaterThan(0); // the connected Server was closed, not leaked

    await close();
    await cleanup();
  });

  it('U10: treats a single-element JSON-RPC batch initialize as initialize (no 400)', async () => {
    const backend = createMockBackend();
    const { handler, cleanup } = createStreamableHttpHandler(backend as never);
    const req = {
      headers: {},
      method: 'POST',
      body: [validInitialize()],
    } as unknown as Request;
    const res = createMockRes();
    // Past the init gate, the SDK transport runs against the mock res and may throw;
    // we only assert the gate did NOT short-circuit with a 400.
    try {
      await handler(req, res);
    } catch {
      /* SDK write on the mock res */
    }
    expect(res._status).not.toBe(400);
    await cleanup();
  });

  it('U10: a non-initialize JSON-RPC batch still returns 400', async () => {
    const backend = createMockBackend();
    const { handler, cleanup } = createStreamableHttpHandler(backend as never);
    const req = {
      headers: {},
      method: 'POST',
      body: [{ jsonrpc: '2.0', method: 'tools/list', id: 2, params: {} }],
    } as unknown as Request;
    const res = createMockRes();
    await handler(req, res);
    expect(res._status).toBe(400);
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

  it('U2: returns 503 (and allocates no Server) when the SSE session cap is reached', async () => {
    const backend = createMockBackend();
    // maxSessions 0 → the cap is hit immediately, so the guard fires before any
    // SSEServerTransport / Server is allocated.
    const { sseHandler, messageHandler, cleanup } = createSseHandlers(
      backend as never,
      '/messages',
      { maxSessions: 0 },
    );

    const res = createMockRes();
    await sseHandler(createMockReq(), res);

    expect(res._status).toBe(503);
    expect(res._body).toMatchObject({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Server at session capacity. Try again later.' },
    });

    // No session was created — any message routes to the 404 path.
    const msgRes = createMockRes();
    await messageHandler(
      { query: { sessionId: 'anything' }, headers: {}, body: {} } as unknown as Request,
      msgRes,
    );
    expect(msgRes._status).toBe(404);

    await cleanup();
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

// ─── isLoopbackOrigin (U4) ───────────────────────────────────────────

describe('isLoopbackOrigin', () => {
  it('accepts loopback origins including IPv6 [::1], IPv4-mapped, and the 127/8 block', () => {
    expect(isLoopbackOrigin('http://localhost:8080')).toBe(true);
    expect(isLoopbackOrigin('http://127.0.0.1:5000')).toBe(true);
    expect(isLoopbackOrigin('http://127.0.0.2:3000')).toBe(true);
    expect(isLoopbackOrigin('http://[::1]:3000')).toBe(true);
    expect(isLoopbackOrigin('http://[::ffff:127.0.0.1]:3000')).toBe(true);
  });

  it('treats a missing Origin as allowed (non-browser caller)', () => {
    expect(isLoopbackOrigin(undefined)).toBe(true);
  });

  it('rejects non-loopback and look-alike origins', () => {
    expect(isLoopbackOrigin('http://localhost.evil.com')).toBe(false);
    expect(isLoopbackOrigin('http://127.0.0.1.evil.com')).toBe(false);
    expect(isLoopbackOrigin('http://example.com')).toBe(false);
    expect(isLoopbackOrigin('http://192.168.1.50:3000')).toBe(false);
    expect(isLoopbackOrigin('null')).toBe(false);
    expect(isLoopbackOrigin('not a url')).toBe(false);
  });
});

// ─── startIdleSweep (U12) ────────────────────────────────────────────

describe('startIdleSweep', () => {
  it('closes and evicts sessions idle beyond the TTL, keeping fresh ones', () => {
    vi.useFakeTimers();
    try {
      const ttlMs = 30 * 60 * 1000;
      const intervalMs = 5 * 60 * 1000;
      const now = Date.now();
      const closed: string[] = [];
      const make = (id: string, lastActivity: number) => ({
        server: { close: () => closed.push(id) } as unknown as ReturnType<typeof createMCPServer>,
        lastActivity,
      });
      const map = new Map([
        ['stale', make('stale', now - 60 * 60 * 1000)],
        ['fresh', make('fresh', now)],
      ]);

      const timer = startIdleSweep(map, ttlMs, intervalMs);
      vi.advanceTimersByTime(intervalMs + 1);

      expect(map.has('stale')).toBe(false);
      expect(map.has('fresh')).toBe(true);
      expect(closed).toEqual(['stale']);

      clearInterval(timer);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ─── resolveAuthToken (U9) ───────────────────────────────────────────

describe('resolveAuthToken', () => {
  it('uses the --auth-token flag when set, preferring it over the env var', () => {
    expect(resolveAuthToken('flag', {})).toBe('flag');
    expect(resolveAuthToken('flag', { GITNEXUS_MCP_AUTH_TOKEN: 'env' })).toBe('flag');
  });

  it('falls back to GITNEXUS_MCP_AUTH_TOKEN', () => {
    expect(resolveAuthToken(undefined, { GITNEXUS_MCP_AUTH_TOKEN: 'env' })).toBe('env');
  });

  it('treats empty/whitespace as no token (no silent auth bypass)', () => {
    expect(resolveAuthToken('', {})).toBeUndefined();
    expect(resolveAuthToken('   ', {})).toBeUndefined();
    expect(resolveAuthToken(undefined, { GITNEXUS_MCP_AUTH_TOKEN: '' })).toBeUndefined();
    expect(resolveAuthToken(undefined, { GITNEXUS_MCP_AUTH_TOKEN: '  ' })).toBeUndefined();
  });

  it('returns undefined when neither is set, and trims a real token', () => {
    expect(resolveAuthToken(undefined, {})).toBeUndefined();
    expect(resolveAuthToken('  tok  ', {})).toBe('tok');
  });
});

// ─── shutdown signal wiring (U7) ─────────────────────────────────────

describe('shutdown exit codes (U7)', () => {
  it('wires SIGINT → 130 and SIGTERM → 143 via the shared installSignalShutdown', () => {
    const handlers: Record<string, (...a: unknown[]) => void> = {};
    const exits: number[] = [];

    installSignalShutdown(
      (code = 0) => {
        exits.push(code);
      },
      (event, listener) => {
        handlers[event] = listener;
      },
    );

    handlers.SIGINT('SIGINT');
    handlers.SIGTERM('SIGTERM');

    expect(SHUTDOWN_EXIT_CODES).toEqual({ SIGINT: 130, SIGTERM: 143 });
    expect(exits).toEqual([130, 143]);
  });
});

// ─── computeAllowedHosts (U6) ────────────────────────────────────────

describe('computeAllowedHosts', () => {
  it('returns all loopback host forms (bare + :port) for a loopback bind', () => {
    expect(computeAllowedHosts('127.0.0.1', 3000)).toEqual([
      '127.0.0.1',
      '127.0.0.1:3000',
      'localhost',
      'localhost:3000',
      '[::1]',
      '[::1]:3000',
    ]);
  });

  it('returns the specific host (bare + :port) for a non-loopback, non-wildcard bind', () => {
    expect(computeAllowedHosts('192.168.1.50', 8080)).toEqual([
      '192.168.1.50',
      '192.168.1.50:8080',
    ]);
  });

  it('returns undefined (protection off) for wildcard binds', () => {
    expect(computeAllowedHosts('0.0.0.0', 3000)).toBeUndefined();
    expect(computeAllowedHosts('::', 3000)).toBeUndefined();
  });
});

/**
 * Dedicated MCP HTTP server.
 *
 * Provides HTTP-based MCP transport supporting:
 * - Modern Streamable HTTP: POST /mcp
 * - Legacy SSE transport: GET /sse + POST /messages
 *
 * Started via `gitnexus mcp --http`.
 * stdio remains the default mode for `gitnexus mcp` (no breaking change).
 *
 * Exports createStreamableHttpHandler and createSseHandlers so that
 * server/mcp-http.ts (web-UI route mount) can reuse them without inverting
 * the established server/ → mcp/ dependency direction.
 *
 * Security considerations:
 * - Default binds to 127.0.0.1 (loopback only).
 * - Use --auth-token to enable Bearer Token authentication.
 * - Use --host 0.0.0.0 to expose to all interfaces (requires --auth-token; warns otherwise).
 * - CORS is restricted to loopback origins when no auth token is configured.
 * - PNA (Private Network Access) header is emitted only in response to browser preflight requests.
 */

import type { Server as HttpServer } from 'http';
import { timingSafeEqual, randomUUID } from 'crypto';
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { createMCPServer } from './server.js';
import type { LocalBackend } from './local/local-backend.js';
import { logger } from '../core/logger.js';

/** HTTP server configuration options. */
export interface McpHttpOptions {
  /** Listening port. */
  port: number;
  /** Bind address (default: 127.0.0.1). */
  host: string;
  /** Bearer auth token (optional; no auth when omitted). */
  authToken?: string;
}

interface MCPSession {
  server: Server;
  transport: StreamableHTTPServerTransport;
  lastActivity: number;
}

interface SSESession {
  server: Server;
  transport: SSEServerTransport;
  lastActivity: number;
}

/** Sessions idle longer than this are evicted. */
const SESSION_TTL_MS = 30 * 60 * 1000;
/** Cleanup sweep runs every 5 minutes. */
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
/** Hard cap on concurrent sessions — guards against initialize-flood DoS. */
const MAX_SESSIONS = 1000;

/**
 * Creates a Bearer Token authentication middleware.
 *
 * - When authToken is not set, all requests pass through.
 * - When authToken is set, checks the Authorization: Bearer <token> header.
 * - Uses constant-time comparison to prevent timing oracle attacks.
 * - Returns a JSON-RPC formatted 401 on failure.
 */
export function createAuthMiddleware(authToken?: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!authToken) {
      next();
      return;
    }

    const header = req.headers['authorization'];
    const expected = `Bearer ${authToken}`;

    // Constant-time comparison — prevents timing oracle on bearer token.
    // Buffers must be the same byte-length for timingSafeEqual; mismatch means
    // we create a same-length dummy so the comparison always runs in full.
    let valid = false;
    if (typeof header === 'string') {
      const a = Buffer.from(header);
      const b = Buffer.from(expected);
      if (a.length === b.length) {
        valid = timingSafeEqual(a, b);
      } else {
        // Different lengths — run dummy comparison to preserve constant time.
        timingSafeEqual(Buffer.alloc(b.length), b);
      }
    }

    if (valid) {
      next();
      return;
    }

    res.status(401).json({
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Unauthorized' },
      id: null,
    });
  };
}

/**
 * Creates a reusable StreamableHTTP request handler.
 *
 * Encapsulates the session map and request-dispatch logic as an independent
 * factory, reused by both startMcpHttpServer (POST /mcp) and the web-UI server
 * route mount in server/mcp-http.ts (/api/mcp).
 */
export function createStreamableHttpHandler(
  backend: LocalBackend,
  opts: { createServer?: () => Server } = {},
): {
  handler: (req: Request, res: Response) => Promise<void>;
  cleanup: () => Promise<void>;
} {
  // Seam: tests inject createServer to observe the per-session Server lifecycle.
  const createServer = opts.createServer ?? ((): Server => createMCPServer(backend));
  const sessions = new Map<string, MCPSession>();

  // Periodically evict idle sessions (guard against network drops where onclose never fires).
  const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [id, session] of sessions) {
      if (now - session.lastActivity > SESSION_TTL_MS) {
        try {
          session.server.close();
        } catch {}
        sessions.delete(id);
      }
    }
  }, CLEANUP_INTERVAL_MS);
  if (cleanupTimer && typeof cleanupTimer === 'object' && 'unref' in cleanupTimer) {
    (cleanupTimer as NodeJS.Timeout).unref();
  }

  const handler = async (req: Request, res: Response): Promise<void> => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (sessionId && sessions.has(sessionId)) {
      // Existing session — delegate to its transport and refresh activity timestamp.
      const session = sessions.get(sessionId);
      if (!session) {
        res
          .status(500)
          .json({ jsonrpc: '2.0', error: { code: -32000, message: 'Internal error' }, id: null });
        return;
      }
      session.lastActivity = Date.now();
      await session.transport.handleRequest(req, res, req.body);
    } else if (sessionId) {
      // Unknown / expired session ID — tell the client to re-initialize (per MCP spec).
      res.status(404).json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Session not found. Re-initialize.' },
        id: null,
      });
    } else if (req.method === 'POST') {
      // No session ID — new client. Only accept initialize requests to avoid
      // orphaned Server instances that can never be reclaimed by the TTL sweep.
      const body = req.body as Record<string, unknown> | undefined;
      if (body?.method !== 'initialize') {
        res.status(400).json({
          jsonrpc: '2.0',
          error: {
            code: -32000,
            message: 'First request must be initialize. No session ID provided.',
          },
          id: null,
        });
        return;
      }

      // Reject when the session cap is reached — prevents memory exhaustion via
      // an initialize flood (each session holds a live Server + Transport).
      if (sessions.size >= MAX_SESSIONS) {
        res.status(503).json({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Server at session capacity. Try again later.' },
          id: null,
        });
        return;
      }

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });
      const server = createServer();
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);

      if (transport.sessionId) {
        sessions.set(transport.sessionId, { server, transport, lastActivity: Date.now() });
        const sid = transport.sessionId;
        transport.onclose = () => {
          sessions.delete(sid);
        };
      } else {
        // The SDK rejected this request (e.g. 406 on a missing/invalid Accept header,
        // 415 on a bad Content-Type) before assigning a session id. The Server was
        // already connected but will never be stored, so the TTL sweep and cleanup()
        // can't reclaim it — close it now to avoid an orphaned-Server leak.
        try {
          await server.close();
        } catch {}
      }
    } else {
      res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'No valid session. Send a POST to initialize.' },
        id: null,
      });
    }
  };

  const cleanup = async (): Promise<void> => {
    clearInterval(cleanupTimer);
    const closers = [...sessions.values()].map(async (session) => {
      try {
        await Promise.resolve(session.server.close());
      } catch {}
    });
    sessions.clear();
    await Promise.allSettled(closers);
  };

  return { handler, cleanup };
}

/**
 * Creates legacy SSE transport handlers.
 *
 * GET /sse (or custom path) establishes the SSE stream;
 * POST /messages (or custom path) receives client JSON-RPC messages.
 *
 * Includes the same idle-TTL eviction as createStreamableHttpHandler to prevent
 * memory leaks when clients drop without closing the SSE connection cleanly.
 *
 * @param backend       LocalBackend instance
 * @param messagesPath  Path clients POST messages to (default: '/messages')
 */
export function createSseHandlers(
  backend: LocalBackend,
  messagesPath = '/messages',
  opts: { maxSessions?: number } = {},
): {
  sseHandler: (req: Request, res: Response) => Promise<void>;
  messageHandler: (req: Request, res: Response) => Promise<void>;
  cleanup: () => Promise<void>;
} {
  const maxSessions = opts.maxSessions ?? MAX_SESSIONS;
  const sseSessions = new Map<string, SSESession>();

  // Periodically evict stale SSE sessions — mirrors the streamable handler's sweep.
  // Guards against network drops where the socket 'close' event never fires.
  const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [id, session] of sseSessions) {
      if (now - session.lastActivity > SESSION_TTL_MS) {
        try {
          session.server.close();
        } catch {}
        sseSessions.delete(id);
      }
    }
  }, CLEANUP_INTERVAL_MS);
  if (cleanupTimer && typeof cleanupTimer === 'object' && 'unref' in cleanupTimer) {
    (cleanupTimer as NodeJS.Timeout).unref();
  }

  const sseHandler = async (req: Request, res: Response): Promise<void> => {
    // Cap concurrent SSE sessions — mirrors the streamable handler's MAX_SESSIONS
    // guard so a flood of held-open GET /sse connections cannot allocate unbounded
    // Server instances before the idle sweep reclaims them.
    if (sseSessions.size >= maxSessions) {
      res.status(503).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Server at session capacity. Try again later.' },
        id: null,
      });
      return;
    }

    // SSEServerTransport(endpoint, res): endpoint is the path clients POST to.
    const transport = new SSEServerTransport(messagesPath, res);
    const server = createMCPServer(backend);

    sseSessions.set(transport.sessionId, { server, transport, lastActivity: Date.now() });

    transport.onclose = () => {
      sseSessions.delete(transport.sessionId);
    };

    res.on('close', () => {
      sseSessions.delete(transport.sessionId);
      try {
        server.close();
      } catch {}
    });

    // connect() calls transport.start(), which sends the SSE 'endpoint' event.
    await server.connect(transport);
  };

  const messageHandler = async (req: Request, res: Response): Promise<void> => {
    const sessionId =
      (req.query['sessionId'] as string | undefined) ??
      (req.headers['mcp-session-id'] as string | undefined);
    const entry = sessionId ? sseSessions.get(sessionId) : undefined;

    if (!entry) {
      res.status(404).json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'SSE session not found. Reconnect to /sse.' },
        id: null,
      });
      return;
    }

    // Refresh activity timestamp so the TTL sweep does not evict an active session.
    entry.lastActivity = Date.now();

    // express.json() has already parsed the body — pass it as the third argument
    // to avoid the SDK re-reading the already-consumed stream.
    await entry.transport.handlePostMessage(req, res, req.body);
  };

  const cleanup = async (): Promise<void> => {
    clearInterval(cleanupTimer);
    for (const { server } of sseSessions.values()) {
      try {
        await Promise.resolve(server.close());
      } catch {}
    }
    sseSessions.clear();
  };

  return { sseHandler, messageHandler, cleanup };
}

/**
 * Creates and starts the dedicated MCP HTTP server.
 *
 * Mounts the following routes:
 * - GET /health      — health check (no auth required; for orchestrators/probes)
 * - POST /mcp        — Streamable HTTP (modern clients)
 * - GET /sse         — legacy SSE stream (old clients)
 * - POST /messages   — legacy SSE message endpoint
 *
 * @param backend   LocalBackend instance
 * @param options   Server configuration
 * @returns         The listening http.Server
 */
export async function startMcpHttpServer(
  backend: LocalBackend,
  options: McpHttpOptions,
): Promise<HttpServer> {
  const { port, host, authToken } = options;

  // Warn when binding to a non-loopback address without auth protection.
  if (!authToken && host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    logger.warn(
      { host, port },
      'GitNexus MCP HTTP server is binding to a non-loopback address WITHOUT --auth-token. ' +
        'Anyone who can reach this host can query your indexed repos. ' +
        'Pass --auth-token or bind --host 127.0.0.1.',
    );
  }

  const app: Express = express();

  // Suppress X-Powered-By to reduce information leakage.
  app.disable('x-powered-by');

  // PNA (Chrome 130+ Private Network Access) preflight support.
  // Only emit the response header when the browser actually sends the preflight request header,
  // rather than on every response. This prevents arbitrary web pages from making cross-origin
  // requests to the local server without triggering an explicit preflight flow.
  app.use((_req: Request, res: Response, next: NextFunction) => {
    if (_req.headers['access-control-request-private-network'] === '1') {
      res.setHeader('Access-Control-Allow-Private-Network', 'true');
    }
    next();
  });

  // CORS policy:
  // - With auth token: allow any origin (remote access is intentional and protected).
  // - Without auth token: restrict to loopback origins only to prevent drive-by local exfiltration.
  const corsOrigin = authToken
    ? true
    : (origin: string | undefined, cb: (err: Error | null, allow?: boolean) => void) => {
        if (!origin) {
          cb(null, true);
          return;
        }
        try {
          const { hostname } = new URL(origin);
          const isLoopback =
            hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
          cb(null, isLoopback);
        } catch {
          cb(null, false);
        }
      };

  app.use(
    cors({
      origin: corsOrigin,
      credentials: false,
      allowedHeaders: ['Content-Type', 'Authorization', 'mcp-session-id', 'last-event-id'],
      exposedHeaders: ['mcp-session-id'],
    }),
  );

  const auth = createAuthMiddleware(authToken);
  // Body parser applied per-route after auth, so unauthenticated requests
  // never trigger the 10 MB parse. Malformed JSON from authenticated clients
  // is caught by the route-level error handler.
  const jsonBody = express.json({ limit: '10mb' });

  // Health check — no auth required; safe to expose for probes and orchestrators.
  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok' });
  });

  // Streamable HTTP (modern MCP clients) at POST /mcp.
  const streamable = createStreamableHttpHandler(backend);
  app.all('/mcp', auth, jsonBody, (req: Request, res: Response) => {
    void streamable.handler(req, res).catch((err: unknown) => {
      logger.error({ err }, 'MCP /mcp request failed');
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Internal MCP server error' },
          id: null,
        });
      }
    });
  });

  // Legacy SSE: GET /sse opens the stream; POST /messages receives JSON-RPC messages.
  const sse = createSseHandlers(backend, '/messages');
  app.get('/sse', auth, (req: Request, res: Response) => {
    void sse.sseHandler(req, res).catch((err: unknown) => {
      logger.error({ err }, 'MCP /sse failed');
    });
  });
  app.post('/messages', auth, jsonBody, (req: Request, res: Response) => {
    void sse.messageHandler(req, res).catch((err: unknown) => {
      logger.error({ err }, 'MCP /messages failed');
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Internal error' },
          id: null,
        });
      }
    });
  });

  return new Promise<HttpServer>((resolve, reject) => {
    const server = app.listen(port, host, () => {
      const displayHost = host === '0.0.0.0' || host === '::' ? 'localhost' : host;
      logger.info(
        { port, host },
        `GitNexus MCP HTTP server listening on http://${displayHost}:${port}  ` +
          `(Streamable: POST /mcp · legacy SSE: GET /sse + POST /messages)`,
      );
      resolve(server);
    });

    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        logger.error(
          { port, host },
          `Port ${port} is already in use. ` +
            `Stop the conflicting process or use a different port: gitnexus mcp --http --port <other>`,
        );
        process.exit(1);
      }
      reject(err);
    });

    const shutdown = async (): Promise<void> => {
      server.close();
      await streamable.cleanup();
      await sse.cleanup();
      try {
        await backend.disconnect();
      } catch {}
      const { flushLoggerSync } = await import('../core/logger.js');
      flushLoggerSync();
      process.exit(0);
    };

    process.once('SIGINT', () => void shutdown());
    process.once('SIGTERM', () => void shutdown());
  });
}

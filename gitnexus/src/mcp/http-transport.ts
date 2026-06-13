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
 * Security considerations:
 * - Default binds to 127.0.0.1 (loopback only).
 * - Use --auth-token to enable Bearer Token authentication.
 * - Use --host 0.0.0.0 to expose to all interfaces (requires --auth-token; warns otherwise).
 * - CORS is restricted to loopback origins when no auth token is configured.
 * - PNA (Private Network Access) header is emitted only in response to browser preflight requests.
 */

import type { Server as HttpServer } from 'http';
import { timingSafeEqual } from 'crypto';
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import { createStreamableHttpHandler, createSseHandlers } from '../server/mcp-http.js';
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
  // Reuses session management logic from server/mcp-http.ts.
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

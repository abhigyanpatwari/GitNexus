/**
 * MCP over HTTP
 *
 * Mounts GitNexus MCP server onto Express using the StreamableHTTP transport.
 * Each connected client gets its own stateful session; LocalBackend is shared
 * across all sessions (thread-safe — each repo lazily loads its LadybugDB).
 *
 * Sessions are evicted on explicit close or after SESSION_TTL_MS of inactivity
 * (guards against network drops where onclose never fires).
 *
 * Exported factory functions are reused by the dedicated HTTP-only server in
 * http-transport.ts:
 * - createStreamableHttpHandler(backend): wraps StreamableHTTPServerTransport session logic
 * - createSseHandlers(backend, messagesPath): wraps legacy SSEServerTransport session logic
 */

import type { Express, Request, Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { createMCPServer } from '../mcp/server.js';
import type { LocalBackend } from '../mcp/local/local-backend.js';
import { randomUUID } from 'crypto';
import { logger } from '../core/logger.js';

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
 * Creates a reusable StreamableHTTP request handler.
 *
 * Encapsulates the session map and handleMcpRequest logic as an independent factory,
 * callable from both mountMCPEndpoints (/api/mcp route) and the dedicated
 * HTTP-only server (http-transport.ts).
 */
export function createStreamableHttpHandler(backend: LocalBackend): {
  handler: (req: Request, res: Response) => Promise<void>;
  cleanup: () => Promise<void>;
} {
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
      const server = createMCPServer(backend);
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);

      if (transport.sessionId) {
        sessions.set(transport.sessionId, { server, transport, lastActivity: Date.now() });
        const sid = transport.sessionId;
        transport.onclose = () => {
          sessions.delete(sid);
        };
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
): {
  sseHandler: (req: Request, res: Response) => Promise<void>;
  messageHandler: (req: Request, res: Response) => Promise<void>;
  cleanup: () => Promise<void>;
} {
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

export function mountMCPEndpoints(app: Express, backend: LocalBackend): () => Promise<void> {
  const { handler, cleanup } = createStreamableHttpHandler(backend);

  app.all('/api/mcp', (req: Request, res: Response) => {
    void handler(req, res).catch((err: unknown) => {
      logger.error({ err }, 'MCP HTTP request failed:');
      if (res.headersSent) return;
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Internal MCP server error' },
        id: null,
      });
    });
  });

  logger.info('MCP HTTP endpoints mounted at /api/mcp');
  return cleanup;
}

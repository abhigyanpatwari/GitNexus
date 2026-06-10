/**
 * MCP over HTTP
 *
 * 将 GitNexus MCP 服务器挂载到 Express，使用 StreamableHTTP 传输协议。
 * 每个连接的客户端都有自己的有状态会话；LocalBackend 在所有会话间共享
 * （线程安全 — 每个仓库懒加载 LadybugDB）。
 *
 * 会话在显式关闭或 SESSION_TTL_MS 空闲后被清理
 * （防止网络断开后 onclose 从未触发的情况）。
 *
 * 新导出的工厂函数可被 http-transport.ts 中的专用 MCP-only 服务器复用：
 * - createStreamableHttpHandler(backend): 封装 StreamableHTTPServerTransport 会话逻辑
 * - createSseHandlers(backend, messagesPath): 封装遗留 SSEServerTransport 会话逻辑
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
}

/** 会话空闲 30 分钟后被驱逐 */
const SESSION_TTL_MS = 30 * 60 * 1000;
/** 清理扫描每 5 分钟运行一次 */
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

/**
 * 创建可复用的 StreamableHTTP 请求处理器。
 *
 * 将现有的会话映射和 handleMcpRequest 逻辑封装为独立工厂，
 * 既可被 mountMCPEndpoints（/api/mcp 路由）调用，
 * 也可被专用 HTTP-only 服务器（http-transport.ts）调用。
 */
export function createStreamableHttpHandler(backend: LocalBackend): {
  handler: (req: Request, res: Response) => Promise<void>;
  cleanup: () => Promise<void>;
} {
  const sessions = new Map<string, MCPSession>();

  // 定期清理空闲会话（防止网络断开导致 onclose 未触发）
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
      // 已有会话 — 委托给其传输
      const session = sessions.get(sessionId)!;
      session.lastActivity = Date.now();
      await session.transport.handleRequest(req, res, req.body);
    } else if (sessionId) {
      // 未知/过期的会话 ID — 告知客户端重新初始化（符合 MCP 规范）
      res.status(404).json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Session not found. Re-initialize.' },
        id: null,
      });
    } else if (req.method === 'POST') {
      // 无会话 ID — 新客户端初始化
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });
      const server = createMCPServer(backend);
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);

      if (transport.sessionId) {
        sessions.set(transport.sessionId, { server, transport, lastActivity: Date.now() });
        transport.onclose = () => {
          sessions.delete(transport.sessionId!);
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
 * 创建遗留 SSE 传输处理器。
 *
 * GET /sse（或自定义路径）建立 SSE 流；
 * POST /messages（或自定义路径）接收客户端发来的 JSON-RPC 消息。
 *
 * @param backend       LocalBackend 实例
 * @param messagesPath  客户端 POST 消息的路径（默认 '/messages'）
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

  const sseHandler = async (req: Request, res: Response): Promise<void> => {
    // SSEServerTransport(endpoint, res): endpoint 是客户端将用来 POST 的路径
    const transport = new SSEServerTransport(messagesPath, res);
    const server = createMCPServer(backend);

    sseSessions.set(transport.sessionId, { server, transport });

    transport.onclose = () => {
      sseSessions.delete(transport.sessionId);
    };

    res.on('close', () => {
      sseSessions.delete(transport.sessionId);
      try {
        server.close();
      } catch {}
    });

    // connect() 调用 transport.start()，它发送 SSE 'endpoint' 事件
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

    // express.json() 已解析请求体 — 将其作为第 3 个参数传入，避免 SDK 重读已耗尽的流
    await entry.transport.handlePostMessage(req, res, req.body);
  };

  const cleanup = async (): Promise<void> => {
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

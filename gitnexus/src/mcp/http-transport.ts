/**
 * 专用 MCP HTTP 服务器
 *
 * 提供基于 HTTP 的 MCP 传输，支持：
 * - 现代 Streamable HTTP：POST /mcp
 * - 遗留 SSE 传输：GET /sse + POST /messages
 *
 * 通过 `gitnexus mcp --http` 启动。
 * stdio 仍是 `gitnexus mcp` 的默认模式（无破坏性变更）。
 *
 * 安全注意事项：
 * - 默认绑定 0.0.0.0（所有接口），如不提供 --auth-token 会输出警告
 * - 使用 --auth-token 启用 Bearer Token 鉴权
 * - 使用 --host 127.0.0.1 限制为本地回环访问
 */

import type { Server as HttpServer } from 'http';
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import { createStreamableHttpHandler, createSseHandlers } from '../server/mcp-http.js';
import type { LocalBackend } from './local/local-backend.js';
import { logger } from '../core/logger.js';

/** HTTP 服务器配置选项 */
export interface McpHttpOptions {
  /** 监听端口 */
  port: number;
  /** 绑定地址（默认 0.0.0.0） */
  host: string;
  /** Bearer 鉴权 Token（可选；不设置则无鉴权） */
  authToken?: string;
}

/**
 * 创建 Bearer Token 鉴权中间件。
 *
 * - 如果未设置 authToken，直接放行所有请求
 * - 如果设置了 authToken，检查 Authorization: Bearer <token> 头
 * - 鉴权失败返回 JSON-RPC 格式的 401 响应
 *
 * @param authToken 期望的 Bearer Token（可选）
 */
export function createAuthMiddleware(authToken?: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    // 未启用鉴权，直接放行
    if (!authToken) {
      next();
      return;
    }

    const header = req.headers['authorization'];
    const expected = `Bearer ${authToken}`;

    // 字符串比较（长度不同则快速失败）
    if (typeof header === 'string' && header === expected) {
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
 * 创建并启动专用 MCP HTTP 服务器。
 *
 * 挂载以下路由：
 * - GET /health  — 健康检查（无需鉴权）
 * - POST /mcp    — Streamable HTTP（现代客户端）
 * - GET /sse     — 遗留 SSE 流（旧客户端）
 * - POST /messages — 遗留 SSE 消息接收
 *
 * @param backend   LocalBackend 实例
 * @param options   服务器配置
 * @returns         已监听的 http.Server
 */
export async function startMcpHttpServer(
  backend: LocalBackend,
  options: McpHttpOptions,
): Promise<HttpServer> {
  const { port, host, authToken } = options;

  // 非回环地址 + 无鉴权 → 输出安全警告
  if (!authToken && host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    logger.warn(
      { host, port },
      'GitNexus MCP HTTP server is binding to a non-loopback address WITHOUT --auth-token. ' +
        'Anyone who can reach this host can query your indexed repos. ' +
        'Pass --auth-token or bind --host 127.0.0.1.',
    );
  }

  const app: Express = express();

  // 禁用 X-Powered-By 头（减少信息泄露）
  app.disable('x-powered-by');

  // Chrome 130+ Private Network Access 预检支持
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
    next();
  });

  // CORS：专用 MCP-only 服务器为远程访问设计，允许所有来源
  app.use(
    cors({
      origin: true,
      credentials: false,
      allowedHeaders: ['Content-Type', 'Authorization', 'mcp-session-id', 'last-event-id'],
      exposedHeaders: ['mcp-session-id'],
    }),
  );

  // 解析 JSON 请求体（最大 10MB）
  app.use(express.json({ limit: '10mb' }));

  const auth = createAuthMiddleware(authToken);

  // 健康检查路由（无需鉴权，供编排工具探测）
  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok' });
  });

  // Streamable HTTP（现代客户端）at POST /mcp
  // 复用 server/mcp-http.ts 中经过验证的会话处理逻辑
  const streamable = createStreamableHttpHandler(backend);
  app.all('/mcp', auth, (req: Request, res: Response) => {
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

  // 遗留 SSE：GET /sse 建立流，POST /messages 接收 JSON-RPC 消息
  const sse = createSseHandlers(backend, '/messages');
  app.get('/sse', auth, (req: Request, res: Response) => {
    void sse.sseHandler(req, res).catch((err: unknown) => {
      logger.error({ err }, 'MCP /sse failed');
    });
  });
  app.post('/messages', auth, (req: Request, res: Response) => {
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
      // 0.0.0.0 / :: 时显示 localhost 更友好
      const displayHost = host === '0.0.0.0' || host === '::' ? 'localhost' : host;
      logger.info(
        { port, host },
        `GitNexus MCP HTTP server listening on http://${displayHost}:${port}  ` +
          `(Streamable: POST /mcp · legacy SSE: GET /sse + POST /messages)`,
      );
      resolve(server);
    });

    server.on('error', reject);

    // 优雅关闭处理
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

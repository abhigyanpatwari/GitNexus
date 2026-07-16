/**
 * MCP over HTTP — route mount helper for the web-UI server.
 *
 * Mounts the GitNexus MCP endpoint (/api/mcp) onto an existing Express
 * application. Session management lives in mcp/http-transport.ts, preserving
 * the established server/ → mcp/ dependency direction.
 *
 * Used by server/api.ts to wire up the full web server.
 */

import type { Express, Request, Response } from 'express';
import { createStreamableHttpHandler } from '../mcp/http-transport.js';
import type { LocalBackend } from '../mcp/local/local-backend.js';
import { createMcpRepositoryPolicy } from '../mcp/repository-policy.js';
import { logger } from '../core/logger.js';

export async function mountMCPEndpoints(
  app: Express,
  backend: LocalBackend,
): Promise<() => Promise<void>> {
  const repositoryPolicy = await createMcpRepositoryPolicy(backend);
  const { handler, cleanup } = createStreamableHttpHandler(backend, { repositoryPolicy });

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

import express from 'express';
import { mountMCPEndpoints } from './mcp-http';
import { mountSSEProgress } from './sse-progress';

export const registerWebUI = (app: express.Express, staticDir: string | null): void => {
  if (!staticDir) return;
  app.get('/', (_req, res) => res.sendFile('index.html', { root: staticDir }));
};

export async function createServer(jobs: unknown) {
  const app = express();
  app.get('/api/info', (_req, res) => res.json({ ok: true }));
  const cleanupMcp = await mountMCPEndpoints(app, {});
  mountSSEProgress(app, '/api/analyze/:jobId/progress', jobs);
  mountSSEProgress(app, '/api/embed/:jobId/progress', jobs);
  registerWebUI(app, 'web');
  return { app, cleanupMcp };
}

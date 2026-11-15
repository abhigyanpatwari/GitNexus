import type { Express } from 'express';

export async function mountMCPEndpoints(app: Express, backend: unknown): Promise<() => void> {
  app.all('/api/mcp', (_req, res) => res.end(String(backend)));
  return () => {};
}

import type { Express } from 'express';

// Never called: a parameter receiver proves nothing without a call site.
export function registerUnused(app: Express) {
  app.get('/api/never-mounted', (_req, res) => res.end());
}

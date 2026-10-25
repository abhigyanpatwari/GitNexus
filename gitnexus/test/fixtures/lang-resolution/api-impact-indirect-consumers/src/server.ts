import express from 'express';

export function createServer() {
  const app = express();
  app.get('/api/repos', (_req, res) => {
    res.json({ repos: [], total: 0 });
  });
  return app;
}

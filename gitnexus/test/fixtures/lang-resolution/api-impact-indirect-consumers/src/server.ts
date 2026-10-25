import express from 'express';

export function createServer() {
  const app = express();
  app.get('/api/repos', (_req, res) => {
    res.json({ repos: [], total: 0 });
  });
  app.get('/api/file', (req, res) => {
    res.json({ content: '', path: String(req.query.path) });
  });
  app.get('/api/stats', (_req, res) => {
    res.json({ files: 0, symbols: 0 });
  });
  return app;
}

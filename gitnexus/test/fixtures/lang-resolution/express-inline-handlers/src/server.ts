import express from 'express';

function loadRepos() {
  return readIndex();
}
function readIndex() {
  return [];
}
function loadFile(path: string) {
  return readDisk(path);
}
function readDisk(path: string) {
  return path;
}

export function createServer() {
  const app = express();
  app.get('/api/repos', (_req, res) => {
    res.json({ repos: loadRepos(), total: 1 });
  });
  app.get('/api/file', async (req, res) => {
    res.json({ content: loadFile(String(req.query.path)), path: 'x' });
  });
  return app;
}

import express from 'express';

const app = express();

app.get('/api/repos', (_req, res) => res.json({ repos: [] }));
app.get('/api/file', (_req, res) => res.json({ content: '' }));
app.post('/api/query', (_req, res) => res.json({ result: [] }));
app.get('/api/direct', (_req, res) => res.json({ ok: true }));
app.get('/health', (_req, res) => res.json({ ok: true }));
app.get('/settings', (_req, res) => res.json({ theme: 'dark' }));
app.get('/api/processes', (_req, res) => res.json({ processes: [] }));
app.post('/api/analyze/upload', (_req, res) => res.json({ jobId: '1' }));
app.get('/api/analyze/:jobId', (_req, res) => res.json({ status: 'done' }));
app.get('/api/kinds/foo', (_req, res) => res.json({ kind: 'foo' }));
app.get('/api/kinds/bar', (_req, res) => res.json({ kind: 'bar' }));

app.listen(4747);

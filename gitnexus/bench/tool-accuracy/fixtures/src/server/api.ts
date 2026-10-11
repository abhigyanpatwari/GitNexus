import express from 'express';
import { mountProgress } from './progress';
const app = express();
export function handleInfo(req: any, res: any): void {
  res.json({ version: 'test' });
}
app.get('/api/info', handleInfo);
app.get('/api/repos', handleInfo);
app.get('/api/direct', handleInfo);
app.all('/api/mcp', handleInfo);
mountProgress(app, '/api/progress');

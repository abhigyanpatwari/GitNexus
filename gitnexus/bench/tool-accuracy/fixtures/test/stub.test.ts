import express from 'express';
const app = express();
app.get('/api/info', (req: any, res: any) => res.json({ stub: true }));
const counts = new Map<string, number>();
counts.get('/lookup-only');

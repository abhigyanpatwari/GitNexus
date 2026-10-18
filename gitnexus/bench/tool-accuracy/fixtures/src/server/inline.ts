import express from 'express';
import { blameSummary } from '../security';
const app = express();
app.get('/api/inline', (req: any, res: any) => {
  const ref = req.query.ref as string;
  res.json({ result: blameSummary(ref) });
});

import { Router } from 'express';
const router = Router();

router.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

export default router;

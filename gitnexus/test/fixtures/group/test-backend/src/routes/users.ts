import { Router } from 'express';
const router = Router();

router.get('/api/users', async (req, res) => {
  res.json([{ id: 1, name: 'Alice' }]);
});

router.post('/api/users', async (req, res) => {
  res.json({ id: 2, ...req.body });
});

router.get('/api/users/:id', async (req, res) => {
  res.json({ id: req.params.id, name: 'Alice' });
});

export default router;

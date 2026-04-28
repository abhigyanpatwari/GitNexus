import express from 'express';
const router = express.Router();

router.post('/api/orders', (req, res) => {
  res.json({ orderId: '123' });
});

export default router;

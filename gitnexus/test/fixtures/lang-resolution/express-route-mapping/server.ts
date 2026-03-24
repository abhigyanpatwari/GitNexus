import express from 'express';
const app = express();

app.get('/api/users', (req, res) => {
  res.json({ users: [] });
});

app.post('/api/users', (req, res) => {
  res.json({ id: 1, created: true });
});

app.put('/api/users/:id', (req, res) => {
  res.json({ updated: true });
});

app.delete('/api/users/:id', (req, res) => {
  res.json({ deleted: true });
});

const router = express.Router();
router.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

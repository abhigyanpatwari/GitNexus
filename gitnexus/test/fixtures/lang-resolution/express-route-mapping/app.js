const app = require('express')();

app.get('/api/items', (req, res) => {
  res.json({ items: [] });
});

app.post('/api/items', (req, res) => {
  res.json({ created: true });
});

app.post('/api/items/create', (req, res) => {
  res.json({ id: 1, created: true });
});

app.put('/api/items/update', (req, res) => {
  res.json({ updated: true });
});

app.patch('/api/items/patch', (req, res) => {
  res.json({ patched: true });
});

app.delete('/api/items/delete', (req, res) => {
  res.json({ deleted: true });
});

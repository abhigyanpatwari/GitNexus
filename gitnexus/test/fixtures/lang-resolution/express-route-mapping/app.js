const app = require('express')();

app.get('/api/items', (req, res) => {
  res.json({ items: [] });
});

app.post('/api/items', (req, res) => {
  res.json({ created: true });
});

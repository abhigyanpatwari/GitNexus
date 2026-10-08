function realInfo() { return 'info'; }
function realQuery() { return 'query'; }
function mcp() { return 'mcp'; }

app.get('/api/info', realInfo);
app.post('/api/query', realQuery);
app.all('/api/mcp', mcp);
app.route('/api/chained').get(realInfo);

const counts = new Map();
counts.get('/ghost');
counts.get('/ghost-block-comment' /* cached key */);
counts.get(
  '/ghost-line-comment', // cached key
);

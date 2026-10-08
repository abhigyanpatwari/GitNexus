function realInfo() { return 'info'; }
function realQuery() { return 'query'; }
function mcp() { return 'mcp'; }

app.get('/api/info', realInfo);
app.post('/api/query', realQuery);
app.all('/api/mcp', mcp);
app.route('/api/chained').get(realInfo);
app.route('/api/chained-post').post(realQuery);
app.route('/api/chained-multi').get(realInfo).post(realQuery);
app.route('/api/chained-all').all(mcp);
app.route('/ghost-builder');
app.route('/ghost-builder-empty').get();
app.route('/ghost-builder-block-comment').post(/* handler pending */);
app.route('/ghost-builder-line-comment').all(
  // handler pending
);

const counts = new Map();
counts.get('/ghost');
counts.get('/ghost-block-comment' /* cached key */);
counts.get(
  '/ghost-line-comment', // cached key
);

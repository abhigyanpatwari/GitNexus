function fakeInfo() {
  return 'fake info';
}
function fakeQuery() {
  return 'fake query';
}

app.get('/api/info', fakeInfo);
app.post('/api/query', fakeQuery);
app.post('/test-only', fakeQuery);

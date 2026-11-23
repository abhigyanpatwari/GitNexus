import http from 'node:http';
const listen = http.Server.prototype.listen;
http.Server.prototype.listen = function (...args) {
  this.once('listening', () => process.send?.({ port: this.address().port }));
  return listen.apply(this, args);
};
const { createServer } = await import('../../dist/server/api.js');
await createServer(0);
process.on('message', (message) => {
  if (message === 'shutdown') process.emit('SIGTERM');
});

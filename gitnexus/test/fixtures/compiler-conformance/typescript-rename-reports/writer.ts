export class Writer {
  close() {}
}
export class Other {
  close() {}
}
export function run() {
  const writer = new Writer();
  const other = new Other();
  const hooks: Other = { close() { writer.close(); } }; writer.close(); other.close();
  // close should remain in this comment.
  const title = 'close';
  return { hooks, title };
}

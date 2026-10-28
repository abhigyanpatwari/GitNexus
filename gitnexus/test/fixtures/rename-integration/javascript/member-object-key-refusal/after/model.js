export class Writer {
  close() { return 1; }
}
export function run() {
  const writer = new Writer();
  const backup = { close() { return 2; } };
  return writer.close();
}

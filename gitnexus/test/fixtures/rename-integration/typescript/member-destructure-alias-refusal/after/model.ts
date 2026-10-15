export class Writer {
  close() { return 1; }
}
export function run() {
  const writer = new Writer();
  const { close: closeWriter } = writer;
  return writer.close();
}

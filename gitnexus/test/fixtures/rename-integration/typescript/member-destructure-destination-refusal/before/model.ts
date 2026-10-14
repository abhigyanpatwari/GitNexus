export class Writer {
  close() { return 1; }
}
export function run() {
  const writer = new Writer();
  const { finish: finishWriter } = writer;
  return writer.close();
}

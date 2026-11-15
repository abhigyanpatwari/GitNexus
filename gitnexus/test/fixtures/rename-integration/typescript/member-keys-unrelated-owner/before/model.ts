export class Writer {
  close() { return 1; }
}
export class Other {
  close() { return 2; }
}
export function run() {
  const writer = new Writer();
  const other = new Other();
  const { close: closeOther } = other;
  const method: Other = { close() { return 3; } };
  const property: Other = { close: () => 4 };
  return writer.close();
}

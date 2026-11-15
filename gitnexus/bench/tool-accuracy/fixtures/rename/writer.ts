export class Writer {
  close(): void {}
}
export class Other {
  close(): void {}
}
export function useWriter(): void {
  const writer = new Writer();
  writer.close();
}
// close is a comment, not a reference.
export const title = 'close';

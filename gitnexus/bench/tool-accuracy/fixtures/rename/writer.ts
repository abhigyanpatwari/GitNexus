export class Writer {
  close(): void {}
}
export class Other {
  close(): void {}
}
export function useWriter(writer: Writer): void {
  writer.close();
}
// close is a comment, not a reference.
export const title = 'close';

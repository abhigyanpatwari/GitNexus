export class Writer {
  closeWriter(): number { return 1; }
}
export function flush(this: Writer): number { return this.closeWriter(); }

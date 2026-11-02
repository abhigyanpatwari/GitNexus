export class DeferredWriter {
  flush(): void {}
}
export function flushDeferred(writer: DeferredWriter): void {
  writer.flush();
}

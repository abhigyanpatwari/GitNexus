export class Writer {
  closeWriter() { return 1; }
}
Writer.prototype.flush = function () { return this.closeWriter(); };

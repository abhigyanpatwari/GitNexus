export class Writer { close() { return 1; } }
class SpecializedWriter extends Writer {}
export function run() {
  const writer = new SpecializedWriter();
  const key = 'close';
  return writer[key]();
}

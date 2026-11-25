export interface Writer<T> {
  write(value: T): void;
}

export abstract class Base<V> implements Writer<V> {
  abstract write(value: V): void;
}

export class TextWriter extends Base<string> {
  override write(value: string): void {}
}

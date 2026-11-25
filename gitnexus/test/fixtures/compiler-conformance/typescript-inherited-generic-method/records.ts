export interface Writer<T> {
  write(value: T): void;
}

export abstract class Base<V> implements Writer<V> {
  abstract write(value: V): void;
}

export class TextWriter extends Base<string> {
  override write(value: string): void {}
}

export class PairWriter<Key = string, Value = Key> {
  put(key: Key, value: Value): void {}
}
export class StringWriter extends PairWriter {
  override put(key: string, value: string): void {}
}
export class NumberWriter extends PairWriter<number> {
  override put(key: number, value: number): void {}
}

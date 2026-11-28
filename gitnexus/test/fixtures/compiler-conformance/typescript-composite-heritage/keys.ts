export interface Left { shared: number; left: number; }
export interface Right { shared: number; right: number; }
export class KeyReader<T> {
  read(key: keyof T): void {}
}
export class EitherReader extends KeyReader<Left | Right> {
  override read(key: keyof (Left | Right)): void {}
}
export class BothReader extends KeyReader<Left & Right> {
  override read(key: keyof (Left & Right)): void {}
}
export interface Box<T> { value: T; }
export class NestedReader extends KeyReader<Box<Left | Right>> {
  override read(key: keyof Box<Left | Right>): void {}
}
export class CallbackReader extends KeyReader<() => void> {
  override read(key: keyof (() => void)): void {}
}

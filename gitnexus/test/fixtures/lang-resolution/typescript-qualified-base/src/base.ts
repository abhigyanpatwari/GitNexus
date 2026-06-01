export class Base {
  base(): void {}
}

export class Box<T> {
  get(): T {
    return undefined as unknown as T;
  }
}

export interface IFoo<T> {
  foo(t: T): void;
}

export interface IBar {
  bar(): void;
}

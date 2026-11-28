export type Fn = <T>(input: T) => T;
export type Pair = [<T>(left: T) => T, <T>(right: T) => T];
export type Factory = new <T>(value: T) => T;
export interface Contract {
  <T>(value: T): T;
  new <U>(value: U): U;
}
export const identity = <Value>(value: Value): Value => value;

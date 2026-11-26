export interface Writer<T> {
  write(value: T | number): void;
}
export class Base<T> {
  write(value: T | number): void {}
  shadow<T>(value: T | number): void {}
}
export class Derived extends Base<string> implements Writer<string> {
  override write(value: string | number): void {}
  override shadow<T>(value: T | number): void {}
}
export class Collection<T> {
  append(value: T[]): void {}
}
export class Middle<Item> extends Collection<Item[]> {}
export class Leaf extends Middle<string> {
  override append(value: string[][]): void {}
}
export class Callbacks extends Collection<() => void> {
  override append(value: (() => void)[]): void {}
}
export class Defaults<T = string, U = T[]> {
  collect(value: U): void {}
}
export class Bare extends Defaults {
  override collect(value: string[]): void {}
}
export class Explicit extends Defaults<number> {
  override collect(value: number[]): void {}
}

// The closing angle of the bound can sit directly beside the default assignment.
export class Compact<T extends Collection<string>=Collection<string>> {}

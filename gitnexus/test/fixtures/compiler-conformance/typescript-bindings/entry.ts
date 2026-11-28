import { Base as Parent, Other, type Reader } from './contracts.js';

export class Derived extends Parent implements Reader {
  override read(): string {
    return super.read();
  }
}

export function readDerived(source: Derived): string {
  return source.read();
}

export function readOther(source: Other): string {
  return source.read();
}

import { getB } from './b';
export class A {
  doA(): void {}
}
export function processA() {
  const b = getB();
  b.doB();
}

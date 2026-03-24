import { A } from './a';
export class B {
  doB(): void {}
}
export function getB(): B {
  return new B();
}

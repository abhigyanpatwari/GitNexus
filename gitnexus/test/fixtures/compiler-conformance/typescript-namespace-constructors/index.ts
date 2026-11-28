namespace A {
  export class X {}
  export function makeA() { return new X(); }
}
namespace B {
  export class X {}
  export function makeB() { return new X(); }
}
export function both() {
  new A.X();
  new B.X();
}

export class A { value = 1; }
export class B { value = 2; }
export class Base {
  child = new A();
  read() { return this.child.value; }
}
export class Derived extends Base { child = new B(); }
export function run() { const instance = new Derived(); return instance.read(); }

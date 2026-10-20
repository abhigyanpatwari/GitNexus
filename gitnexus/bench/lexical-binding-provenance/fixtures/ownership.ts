export class Base {
  m() {
    return 'base';
  }
}
export class Foo extends Base {
  override m() {
    return 'foo';
  }
}
export function declaredOwner(a: Base) {
  function writeAndRead() {
    a = new Foo();
    a.m();
  }
  writeAndRead();
  a.m();
}
export function inferredOwner() {
  let a = new Base();
  function writeAndRead() {
    a = new Foo();
    a.m();
  }
  writeAndRead();
  a.m();
}
export function directConstructor() {
  const a = new Foo();
  a.m();
}

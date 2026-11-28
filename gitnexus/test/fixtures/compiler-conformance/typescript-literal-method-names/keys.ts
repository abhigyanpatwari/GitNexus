export class Base {
  [0x10]() {}
  'read-value'() {}
}

export class Derived extends Base {
  override [1.6e1]() {}
  override ['read\u002dvalue']() {}
}

export function run(value: Derived) {
  value[16]();
  value['read-value']();
}

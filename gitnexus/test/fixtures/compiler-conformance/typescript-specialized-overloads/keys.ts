class Base {
  [-1]() {}
  ['']() {}
}

export class Derived extends Base {
  override [-0x1]() {}
  override ['']() {}
}

export function useKeys(value: Derived) {
  value[-1]();
  value['']();
}

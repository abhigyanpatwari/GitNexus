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

export class LiteralKeys {
  [key: string]: Function;
  ['a.b'](key: 'x'): 'x';
  ['a.b'](key: 'y'): 'y';
  ['a.b'](key: 'x' | 'y') {
    return key;
  }
  b() {}
  [`r\u0075n`]() {}
  [('nested')]() {
    return this.b();
  }
  ['a.${part}']() {}
  ['(part)']() {}
}

export function callDotted(value: LiteralKeys) {
  return value['a.b']('y');
}

export function callSuffix(value: LiteralKeys) {
  value.b();
}

export function callLocalSuffix() {
  function b() {}
  return b();
}

export function callTemplate(value: LiteralKeys) {
  value[`run`]();
}

export function callGrouped(value: LiteralKeys) {
  value[((/* name */ 'run'))]();
}

declare const dictionary: LiteralKeys;

export function callKnownSpellings() {
  dictionary[`a.\${part}`]();
  dictionary['(part)']();
}

export function callDynamic(part: string) {
  dictionary[(part)]();
  dictionary[`a.${part}`]();
}

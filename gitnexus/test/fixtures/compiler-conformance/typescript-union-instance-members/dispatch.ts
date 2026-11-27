class Base {
  render() { return 1; }
}

class Child extends Base {
  static render() { return 2; }
}

class Both {
  static render() { return 3; }
  render() { return 4; }
}

class Other {
  render() { return 5; }
}

class StaticOnly {
  static render() { return 6; }
}

export function inherited(value: Child | Other) { return value.render(); }
export function mixed(value: Other | Both) { return value.render(); }
export function rejected(value: Other | StaticOnly) {
  return value.render();
}

interface WordOverloads {
  render<T extends string>(value: T): T;
  render<T extends number>(value: T): T;
}

interface OtherOverloads {
  render<T extends boolean>(value: T): T;
  render<T extends bigint>(value: T): T;
}

export function incompatible(value: WordOverloads | OtherOverloads) {
  return value.render("absent");
}

export function directStatic() { return Both.render(); }

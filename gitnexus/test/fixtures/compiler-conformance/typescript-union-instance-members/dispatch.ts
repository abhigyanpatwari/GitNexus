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

class StaticField extends Base {
  static render = 1;
}
class DeepField extends StaticField {}
class InstanceField {
  render = 0;
}

export function unionStaticField(value: StaticField | Other) { return value.render(); }
export function inheritedStaticField(value: DeepField | Other) { return value.render(); }
export function directStaticField(value: StaticField) { return value.render(); }
export function instanceFieldBlocks(value: Other | InstanceField) { return value.render(); }

class StaticBase {
  static draw() { return 1; }
}
class InstanceShadow extends StaticBase {
  draw = 2;
}
export function staticDispatch() { return InstanceShadow.draw(); }

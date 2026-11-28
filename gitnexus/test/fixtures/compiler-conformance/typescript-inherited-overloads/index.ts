export class Parent {
  choose(value: string | number): void;
  choose(value: string): void;
  choose(value: string | number) {}
}
export class Child extends Parent {
  run(value: string) {
    super.choose(value);
    this.choose(value);
  }
}
export function invoke(receiver: Parent, value: string) {
  receiver.choose(value);
}
export class Own extends Parent {
  override choose(value: string | number) {}
}
export class Holder {
  receiver: Parent = new Parent();
}
export function parent(): Parent { return new Parent(); }
export function shapes(own: Own, holder: Holder, value: string) {
  own.choose(value);
  holder.receiver.choose(value);
  parent().choose(value);
}

class StaticField extends Parent {
  static choose = 1;
}
export function inheritedThroughField(child: StaticField, value: string) { child.choose(value); }

class Exact { exact() {} }
class Broad { broad() {} }
class InstanceReader {
  read(value: "key"): Exact;
  read(value: string): Broad;
  read(value: string): Exact | Broad { throw value; }
}
class StaticReader extends InstanceReader {
  static read(value: "key"): Broad;
  static read(value: string): Exact;
  static read(value: string): Broad | Exact { throw value; }
}
class ChildReader extends StaticReader {
  override read(value: "key"): Exact;
  override read(value: string): Broad;
  override read(value: string): Exact | Broad { throw value; }
}
export function inheritedInstance(reader: StaticReader, value: string) {
  const exact = reader.read("key");
  exact.exact();
  const broad = reader.read(value);
  broad.broad();
}
export function inheritedStatic(value: string) {
  ChildReader.read("key");
  ChildReader.read(value);
}

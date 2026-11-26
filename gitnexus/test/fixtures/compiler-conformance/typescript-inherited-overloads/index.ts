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

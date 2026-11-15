export interface Renderer {
  paint(): string;
}
export class Base implements Renderer {
  paint(): string { return "render"; }
}
export class Child extends Base {
  override paint(): string { return super.paint(); }
}
export class Other {
  render(): string { return "other"; }
}
export const value: Renderer = new Child();
export function invoke() {
  return value.paint();
}

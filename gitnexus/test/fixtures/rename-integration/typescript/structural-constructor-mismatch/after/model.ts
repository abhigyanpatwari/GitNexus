export interface Renderer {
  render(): string;
}
export class Base implements Renderer {
  render(): string { return "render"; }
}
export class Child extends Base {
  override render(): string { return super.render(); }
}
export class Other {
  render(): string { return "other"; }
}
const value: Renderer = new Other();
export function invoke() {
  return value.render();
}

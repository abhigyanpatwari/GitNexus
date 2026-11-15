interface Renderer {
  paint(): string;
}
class Base implements Renderer {
  paint(): string { return "render"; }
}
class Child extends Base {
  override paint(): string { return super.paint(); }
}
class Other {
  render(): string { return "other"; }
}
function invoke() {
  const value: Renderer = new Child();
  const base = new Base();
  const child = new Child();
  const other = new Other();
  return value.paint() + base.paint() + child.paint() + other.render();
}
// render is an API name.

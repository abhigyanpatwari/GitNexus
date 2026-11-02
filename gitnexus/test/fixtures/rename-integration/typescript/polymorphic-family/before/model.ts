interface Renderer {
  render(): string;
}
class Base implements Renderer {
  render(): string { return "render"; }
}
class Child extends Base {
  override render(): string { return super.render(); }
}
class Other {
  render(): string { return "other"; }
}
function invoke() {
  const value: Renderer = new Child();
  const base = new Base();
  const child = new Child();
  const other = new Other();
  return value.render() + base.render() + child.render() + other.render();
}
// render is an API name.

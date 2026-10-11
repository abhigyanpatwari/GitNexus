class Base {
  render() { return "render"; }
}
class Child extends Base {
  render() { return super.render(); }
}
class Other {
  render() { return "other"; }
}
const base = new Base();
const child = new Child();
const other = new Other();
base.render();
child.render();
other.render();
// render is documentation.

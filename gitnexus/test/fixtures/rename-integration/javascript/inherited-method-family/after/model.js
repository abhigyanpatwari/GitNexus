class Base {
  paint() { return "render"; }
}
class Child extends Base {
  paint() { return super.paint(); }
}
class Other {
  render() { return "other"; }
}
const base = new Base();
const child = new Child();
const other = new Other();
base.paint();
child.paint();
other.render();
// render is documentation.

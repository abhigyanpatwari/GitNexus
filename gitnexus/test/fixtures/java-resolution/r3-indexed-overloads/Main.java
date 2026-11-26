
class User { void save() {} }
class Other { void save() {} }
class Base {
  User[] over() { return null; }
  Other[] over(int value) { return null; }
}
class Sub extends Base {
  void viaSuper() { super.over()[0].save(); }
  void viaThis() { this.over(1)[0].save(); }
}
class Holder {
  Other[] make() { return null; }
  User[] make(int value) { return null; }
  User[][] grid() { return null; }
  Other[][] grid(int value) { return null; }
  User[] pick(Integer value) { return null; }
  Other[] pick(String value) { return null; }
}
class Free {
  User[] all() { return null; }
  Other[] all(int value) { return null; }
  void none() { all()[0].save(); }
}
class Use {
  void typedNoArg(Holder h) { h.make()[0].save(); }
  void typedInt(Holder h) { h.make(1)[0].save(); }
  void twoDims(Holder h) { h.grid()[0][1].save(); }
  void tooFewDims(Holder h) { h.grid()[0].save(); }
  void ambiguousNull(Holder h) { h.pick(null)[0].save(); }
  void unknownArgument(Holder h, Missing m) { h.pick(m.value())[0].save(); }
}

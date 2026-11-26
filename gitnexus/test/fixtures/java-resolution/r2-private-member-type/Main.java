
class Outer {
  private static class Hidden { void save() {} }
  static class Shown { void save() {} }
  void inside(Outer.Hidden h) { h.save(); }
  static class Nested { void nested(Outer.Hidden h) { h.save(); } }
}
class Other {
  void outside(Outer.Hidden h) { h.save(); }
  void shown(Outer.Shown h) { h.save(); }
}
class Decoy { void save() {} }

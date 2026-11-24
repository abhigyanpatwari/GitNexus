package h;
class Child extends g.Base {
  Nested field;
  void plain(Nested n) { n.save(); }
  void local() { Nested n = null; n.save(); }
  void viaField() { field.save(); }
  void array(Nested[] values) { values[0].save(); }
  class Inner { void deep(Nested n) { n.save(); } }
  void take(Nested n) {}
  void take(h.Nested n) {}
  void pass(Nested n) { take(n); }
}
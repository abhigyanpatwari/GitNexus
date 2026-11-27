package h;
class Own extends g.Base {
  static class Nested { void save() {} }
  void own(Nested n) { n.save(); }
}
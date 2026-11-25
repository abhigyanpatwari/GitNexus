package k;
class Nested { void save() {} }
class SameFile extends g.Base {
  void plain(Nested n) { n.save(); }
  void take(g.Base.Nested n) {}
  void take(k.Nested n) {}
  void pass(Nested n) { take(n); }
}
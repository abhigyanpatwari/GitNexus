package pq;
class PkgChild extends pp.PkgBase {
  void plain(Nested n) { n.save(); }
  void take(Nested n) {}
  void take(String s) {}
  void pass(Nested n) { take(n); }
}
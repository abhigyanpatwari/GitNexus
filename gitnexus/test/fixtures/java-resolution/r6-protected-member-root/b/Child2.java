package b;
class Child2 extends a.Base2 {
  void run(Box.Item i) { i.save(); }
  void local() { Box.Item i = null; i.save(); }
  class Deep { void deep(Box.Item i) { i.save(); } }
  void take(Box.Item i) {}
  void take(String s) {}
  void pass(Box.Item i) { take(i); }
}
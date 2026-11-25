package hd;
class C extends B {
  void simple(Builder b) { b.go(); }
  void qualified(Builder.Part p) { p.go(); }
}
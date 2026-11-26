package hd;
class D extends A {
  void simple(Builder b) { b.go(); }
  void qualified(Builder.Part p) { p.go(); }
}
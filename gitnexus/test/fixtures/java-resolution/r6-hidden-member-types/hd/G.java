package hd;
class G implements K1, K2 {
  void simple(Builder b) { b.go(); }
  void qualified(Builder.Part p) { p.go(); }
}
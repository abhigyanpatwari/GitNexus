// CF3 review (#1919): a Dart class getter/setter is a class-member declaration
// (its name lives under method_signature), NOT a function-local — it must keep
// its HAS_PROPERTY owner edge from the class.
class Box {
  int normalField = 1;

  int get answer => 42;

  set answer(int v) {
    normalField = v;
  }
}

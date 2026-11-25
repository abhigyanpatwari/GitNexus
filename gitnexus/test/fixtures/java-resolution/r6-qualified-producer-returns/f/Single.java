package f;
class SingleBase { static class Outer { static class Inner { void save() {} } } }
class Single extends SingleBase {
  Outer.Inner[] make() { return null; }
  void run() { make()[0].save(); }
}
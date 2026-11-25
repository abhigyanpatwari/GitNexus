package f;
class BaseA { static class Outer { static class Inner { void save() {} } } }
class Ambiguous extends BaseA implements BaseB {
  Outer.Inner[] make() { return null; }
  void run() { make()[0].save(); }
}
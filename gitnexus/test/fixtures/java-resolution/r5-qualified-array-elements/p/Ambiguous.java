package p;
class BaseA { static class Outer { static class Inner { void save() {} } } }
class Ambiguous extends BaseA implements BaseB {
  void run(Outer.Inner[] values) { values[0].save(); }
  void runPlain(Outer.Inner value) { value.save(); }
}
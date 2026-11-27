package p;
class Target {
  void take(Äußer.Ünïcödé value) {}
  void take(Äußer.ötigÜnïcödé value) {}
  void take(Outer.Inner value) {}
  void take(String value) {}
}
class CombiningTarget {
  void take(Café value) {}
  void take(Outer.Inner value) {}
  void take(String value) {}
}
class Picker {
  void local(Target t) { Äußer.@Nötig Ünïcödé v = null; t.take(v); }
  void parameter(Target t, Äußer.@Nötig Ünïcödé v) { t.take(v); }
  void asciiLocal(Target t) { Outer.@Ann Inner v = null; t.take(v); }
  void combining(CombiningTarget t) { Café v = null; t.take(v); }
  void besideCombining(CombiningTarget t) { Outer.Inner v = null; t.take(v); }
}
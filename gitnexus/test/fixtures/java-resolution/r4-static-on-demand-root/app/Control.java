package app;
class Control {
  void param(Inner.User x) { x.save(); }
  void local() { Inner.User x = null; x.save(); }
}
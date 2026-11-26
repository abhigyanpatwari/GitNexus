package app;
class Outer extends Base {
  void direct(models.User u) { u.save(); }
  class Plain2 { void nearPlain(models.User u) { u.save(); } }
  class Inner extends lib.Lib { void nearExt(models.User u) { u.save(); } }
}
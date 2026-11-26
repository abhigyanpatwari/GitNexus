class Aliases {
  void nestedCopy(Factory f, boolean c) {
    var u = f.make();
    if (c) { var w = u; w.save(); }
  }
  void deeplyNestedCopy(Factory f, boolean c) {
    var u = f.make();
    if (c) { while (c) { var w = u; { var x = w; x.save(); } } }
  }
  void lambdaCopy(Factory f) {
    var u = f.make();
    Runnable r = () -> { var w = u; w.save(); };
  }
  void reassignedBeforeCopy(Factory f, OtherFactory g, boolean c) {
    var u = f.make();
    if (c) { u = g.make(); var w = u; w.save(); }
  }
  void reassignedLaterInLoop(Factory f, boolean c) {
    var u = f.make();
    while (c) { var w = u; w.save(); u = null; }
  }
  void anonymousFieldShadow(Factory f) {
    var u = f.make();
    new Object() {
      Other u;
      void m() { var w = u; w.save(); }
    };
  }
  void outerRedeclaration(Factory f, OtherFactory g, boolean c) {
    var u = f.make();
    if (c) { var w = u; w.save(); }
    var w = g.make();
    w.store();
  }
}
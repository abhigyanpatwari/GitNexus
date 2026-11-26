package app;
import lib.Imported;
class Unknown extends missing.Parent {
  void samePackage(Root.Item x) { x.save(); }
  void imported(Imported.Item x) { x.save(); }
  void pick(Root.Item x) {}
  void pick(Imported.Item x) {}
  void pass(Root.Item x) { pick(x); }
}
class ThroughUnknown extends Unknown { void indirect(Root.Item x) { x.save(); } }
class Complete {
  void imported(Imported.Item x) { x.save(); }
  void nested() {
    class Local { void local(Imported.Item x) { x.save(); } }
    new Root() { void anonymous(Imported.Item x) { x.save(); } };
    class Unseen extends missing.Parent { void unknown(Imported.Item x) { x.save(); } }
  }
}
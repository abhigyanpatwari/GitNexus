class User { void save() {} void audit() {} }
  class Other { void save() {} }
  class App {
    User x; User y;
    void accept(Object callback) {}
    void own() {}
    void sibling() {
      accept((User x) -> x.save());
      accept((Other x) -> { x.save(); });
    }
    void unknown() { accept(x -> x.audit()); }
    void unknownList() { accept((x, y) -> x.audit()); }
    void nested() { accept((User outer) -> { accept(y -> y.audit()); outer.save(); }); }
    void lexicalThis() { accept(x -> this.own()); }
    void afterLambda() { accept((Other x) -> x.save()); x.audit(); }
  }

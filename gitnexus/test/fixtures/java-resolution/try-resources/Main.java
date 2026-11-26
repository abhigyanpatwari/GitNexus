class Resource implements AutoCloseable {
  public void close() {}
  void inside() {} void caught() {} void finalized() {} void after() {} void save() {}
  Resource next() { return new Resource(); }
}
class Field {
  void inside() {} void caught() {} void finalized() {} void after() {} void save() {}
  Resource next() { return new Resource(); }
}
class App {
  Field r;
  Resource open() { return new Resource(); }
  void boundaries() {
    try (Resource r = open()) { r.inside(); }
    catch (Exception e) { r.caught(); }
    finally { r.finalized(); }
    r.after();
  }
  void constructed() { try (var r = new Resource()) { r.save(); } }
  void selectedCall() { try (var r = open()) { r.save(); } }
  void successive() { try (Resource r = open(); var q = r.next()) { q.save(); } }
  void existing(Resource r) { try (r) { r.save(); } r.after(); }
  void invalidSelfRead() { try (Resource r = r.next()) { } }
}

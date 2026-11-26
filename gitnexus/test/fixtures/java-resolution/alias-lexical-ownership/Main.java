
class User { void save() {} public String toString() { return "user"; } }
class Repo { void save() {} public String toString() { return "repo"; } }
class Unknown {}
class Address { void save() {} }
class OtherAddress { void save() {} }
class Holder { User user; }
class Customer {
  Address address;
  Unknown unresolved;
  OtherAddress address() { return new OtherAddress(); }
  OtherAddress unresolved() { return new OtherAddress(); }
}
class Factory { Repo make() { return new Repo(); } }
class OtherFactory { User make() { return new User(); } }
class App {
  Repo x;
  Repo field;
  void seedOtherMethod() { User x = new User(); }
  void parameterAlias(Repo x) { var copy = x; copy.save(); }
  void unknownParameterAlias(Unknown x) { var copy = x; copy.save(); }
  void fieldAlias(Customer user) {
    OtherAddress address = new OtherAddress();
    var copy = user.address;
    copy.save();
  }
  void fieldVersusMethodAlias(Customer user) { var copy = user.address; copy.save(); }
  void unknownFieldVersusMethodAlias(Customer user) { var copy = user.unresolved; copy.save(); }
  void thisFieldAlias() { var copy = this.field; copy.save(); }
  void nestedFieldAlias(Holder holder) { var copy = holder.user; copy.save(); }
  void beforeLocalDeclaration() {
    var copy = x;
    User x = new User();
    copy.save();
  }
  void afterLocalDeclaration() {
    User x = new User();
    var copy = x;
    copy.save();
  }
  void adjacentAlias(boolean ready, User source) {
    if (ready) {}var x = source;
    x.save();
  }
  void adjacentTyped(boolean ready, User source) {
    if (ready) {}User x = source;
    x.save();
  }
  void adjacentConstructor(boolean ready) {
    if (ready) {}var x = new User();
    x.save();
  }
  void adjacentAnonymous(boolean ready) {
    if (ready) {}var x = new User() { @Override void save() {} };
    x.save();
  }
  void factoryAlias(Factory factory) { var value = factory.make(); var copy = value; copy.save(); }
  void loopFactoryAlias(Factory factory) {
    for (var value = factory.make(); value != null;) { var copy = value; copy.save(); break; }
  }
  void afterLoopFactoryAlias(Factory factory, User valueAfter) {
    for (var value = factory.make(); value != null;) { break; }
    var value = valueAfter; var copy = value; copy.save();
  }
  void competingFactoryAlias(OtherFactory factory) { var value = factory.make(); var copy = value; copy.save(); }
  void unknownLocalAlias() { Unknown x = new Unknown(); var copy = x; copy.save(); }
  void declaredTypeAfterAssignment(Factory factory) {
    Object value = new User();
    var copy = value;
    value = factory.make();
    copy.toString();
  }
}

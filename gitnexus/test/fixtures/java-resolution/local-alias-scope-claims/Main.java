
class User { void save() {} void userOnly() {} }
class Repo { void save() {} void repoOnly() {} }
class Unknown {}
class App {
  Repo x;
  void beforeLocal() { var copy = x; User x = new User(); copy.save(); }
  void afterLocal() { User x = new User(); var copy = x; copy.save(); }
  void afterNested() { { User x = new User(); } var copy = x; copy.save(); }
  void beforeNested() { var copy = x; { User x = new User(); } copy.save(); }
  void withinNested() { { User x = new User(); var copy = x; copy.save(); } }
  void siblingBlocks() {
    { User x = new User(); var copy = x; copy.userOnly(); }
    { Repo x = new Repo(); var copy = x; copy.repoOnly(); }
  }
  void afterFor() { for (User x = new User(); condition; ) { x.userOnly(); } var copy = x; copy.save(); }
  void unknownShadow() { Unknown x = null; var copy = x; copy.save(); }
  void invalidSelfRead() { var x = x; x.save(); }
}

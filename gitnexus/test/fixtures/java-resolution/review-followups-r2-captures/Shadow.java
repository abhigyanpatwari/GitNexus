package p;
class Shadow {
  Repo repo;
  void localClassFieldAfterCopy(boolean ready) {
    var x = repo.other();
    if (ready) { var y = x; y.save(); }
    class L { Other x; void f() { x = null; } }
  }
  void localClassFieldBeforeCopy() {
    var x = repo.other();
    class L { Repo x; void f() { x = null; } }
    var y = x;
    y.save();
  }
  void anonymousClassField() {
    var x = repo.other();
    Runnable r = new Runnable() { Repo x; public void run() { x = null; } };
    var y = x;
    y.save();
  }
  void localTypeNamedLikeProducerType() {
    var x = repo.other();
    class Other { void save() {} }
    var y = x;
    y.save();
  }
  void realWrite(boolean ready) {
    var x = repo.other();
    if (ready) { var y = x; y.save(); }
    x = repo.user();
  }
}

class User { void save() {} }
class Other { void save() {} }
abstract class Holder { Other[] inherited() { return null; } abstract void run(); }
abstract class Task { abstract void run(); }
class Sub {
  User[] own() { return null; }
  User[] inherited() { return null; }
  void viaInherited() {
    new Holder() {
      void run() { this.inherited()[0].save(); }
    };
  }
  void viaNested() {
    new Runnable() {
      public void run() {
        new Task() {
          Other[] own() { return null; }
          void run() { this.own()[0].save(); }
        };
      }
    };
  }
}

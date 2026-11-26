
import lib.LibraryTask;
class User { void save() {} }
class Other { void save() {} }
class Factory { User make() { return null; } }
abstract class Task { abstract void m(); }
abstract class Sink { abstract void m(Other value); }
abstract class FieldTask { Other value; abstract void m(); }
abstract class DeepTask extends FieldTask {}
abstract class PrivateTask { private Other value; }
class App {
  Factory factory;
  void captured() {
    var value = factory.make();
    new Task() { void m() { var copy = value; copy.save(); } };
  }
  void inLocalClass() {
    var value = factory.make();
    class Local { void m() { var copy = value; copy.save(); } }
  }
  void inheritedField() {
    var value = factory.make();
    new FieldTask() { void m() { var copy = value; copy.save(); } };
  }
  void deepInheritedField() {
    var value = factory.make();
    new DeepTask() { void m() { var copy = value; copy.save(); } };
  }
  void externalSupertype() {
    var value = factory.make();
    new LibraryTask() { public void run() { var copy = value; copy.save(); } };
  }
  void ownField() {
    var value = factory.make();
    new Task() { Other value; void m() { var copy = value; copy.save(); } };
  }
  void parameter() {
    var value = factory.make();
    new Sink() { void m(Other value) { var copy = value; copy.save(); } };
  }
  void writtenAfter() {
    var value = factory.make();
    new Task() { void m() { var copy = value; copy.save(); } };
    value = null;
  }
  void unknownFactory(lib.LibraryFactory external) {
    var value = external.make();
    new FieldTask() { void m() { var copy = value; copy.save(); } };
  }
  void externalFieldTask() {
    var value = factory.make();
    new lib.FieldTask() { public void m() { var copy = value; copy.save(); } };
  }
  void packageField() {
    var value = factory.make();
    class PackageLocal extends lib.PackageTask { void m() { var copy = value; copy.save(); } }
  }
  void privateField() {
    var value = factory.make();
    new PrivateTask() { void m() { var copy = value; copy.save(); } };
  }
}

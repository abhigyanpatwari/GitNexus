package h;
class LocalClass extends g.Base {
  void run() {
    class Nested { void save() {} }
    Nested n = new Nested();
    n.save();
  }
}
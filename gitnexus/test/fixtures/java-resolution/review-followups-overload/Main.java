
class User { void save() {} }
class Other { void save() {} }
interface Marker { Other[] items(); }
class Base {
  User[] items() { return null; }
  private Other[] hidden() { return null; }
  User[] over() { return null; }
  Other[] over(int value) { return null; }
  User[] pick(Integer value) { return null; }
  Other[] pick(String value) { return null; }
}
class Sub extends Base {
  User[] own() { return null; }
  void viaSuper() { super.items()[0].save(); }
  void viaThis() { this.own()[0].save(); }
  void privateSuper() { super.hidden()[0].save(); }
  void overloadedSuper() { super.over()[0].save(); }
  void ambiguousSuper() { super.pick(null)[0].save(); }
  void anonymous() {
    new Runnable() {
      Other[] own() { return null; }
      public void run() { this.own()[0].save(); }
    };
  }
}
class Lone implements Marker {
  public Other[] items() { return null; }
  void viaObjectSuper() { super.items()[0].save(); }
}

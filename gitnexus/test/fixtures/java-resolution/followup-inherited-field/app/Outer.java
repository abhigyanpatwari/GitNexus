package app;
import java.util.List;
class Base2 { List<Other> items; }
interface HasItems {}
class Outer {
  List<User> items;
  class In extends Base2 {
    void run() { items.forEach(v -> v.save()); }
    void loop() { for (var v : items) v.save(); }
  }
  class Impl implements HasItems {
    void run() { items.forEach(v -> v.save()); }
  }
  class Plain {
    void run() { items.forEach(v -> v.save()); }
  }
  void anon() {
    new Base2() { void run() { items.forEach(v -> v.save()); } };
  }
}
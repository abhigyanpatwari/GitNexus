package app;
import java.util.List;
class Generic<T> { List<T> items; }
class Hidden { private List<Other> items; }
interface Consts { List<Other> items = null; }
interface LocalContract { Other item = null; }
class LocalBridge extends PackageBase {}
class Outer {
  User item;
  List<User> items;
  class DirectContract extends HidingBase implements Contract {
    void bare() { item.save(); }
    void elements() { items.forEach(v -> v.save()); }
  }
  class ThroughHidingBase extends HidingBase {
    void bare() { item.save(); }
    void elements() { items.forEach(v -> v.save()); }
  }
  class LocalField implements LocalContract { void bare() { item.save(); } }
  class ForeignField implements outside.ForeignContract { void bare() { item.save(); } }
  class Ambiguous implements Alternative, Contract {
    void bare() { item.save(); }
    void elements() { items.forEach(v -> v.save()); }
  }
  class Direct extends PackageBase {
    void run() { items.forEach(v -> v.save()); }
  }
  class SamePackage extends LocalBridge implements outside.Marker {
    void run() { items.forEach(v -> v.save()); }
  }
  class AcrossPackages extends outside.Bridge {
    void run() { items.forEach(v -> v.save()); }
  }
  class External extends java.util.ArrayList<String> {
    void run() { items.forEach(v -> v.save()); }
  }
  class Untyped extends Generic<Other> {
    void run() { items.forEach(v -> v.save()); }
  }
  class Private extends Hidden {
    void run() { items.forEach(v -> v.save()); }
  }
  class Constant implements Consts {
    void run() { items.forEach(v -> v.save()); }
  }
  interface Own {
    List<Other> items = null;
    default void run() { items.forEach(v -> v.save()); }
  }
}
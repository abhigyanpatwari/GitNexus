package p;
public class Routes {
  prefix.User field;
  prefix.User make() { return null; }
  void viaField() { field.save(); }
  void viaThis() { this.field.save(); }
  void viaLocal() { prefix.User local = make(); local.save(); }
}
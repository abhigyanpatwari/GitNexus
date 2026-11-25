package app;
public class Child extends Base {
  void run(models.User u) { u.save(); }
  class Nested {
    void run(models.User u) { u.save(); }
  }
}

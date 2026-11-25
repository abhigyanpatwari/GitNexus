package app;
import models.User;
class App {
  void good(models.User u) { u.save(); }
  static class Nested {
    static class models { static class User { void save() {} } }
    void unrelated(models.User u) { u.save(); }
  }
}


class User { void save() {} }
class Other { void save() {} }
class App {
  User[] getUsers() { return null; }
  User trailingReturn()[] { return null; }
  void bare() { getUsers()[0].save(); }
  void trailing() { trailingReturn()[0].save(); }
  void explicit(Service service) { service.getUsers()[0].save(); }
}
class Ambiguous {
  User[] getUsers() { return null; }
  Other[] getUsers(int value) { return null; }
  User[] pick(Integer value) { return null; }
  Other[] pick(String value) { return null; }
  void overloaded() { getUsers()[0].save(); }
  void tied() { this.pick(null)[0].save(); }
}
class Service { Other[] getUsers() { return null; } }

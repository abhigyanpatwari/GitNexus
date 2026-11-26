import decoy.User;
class Outer {
  void callback() {
    class User { void save() {} }
    java.util.List<User> users = null;
    users.forEach(x -> x.save());
  }
  void loop() {
    class User { void save() {} }
    java.util.List<User> users = null;
    for (var x : users) x.save();
  }
}

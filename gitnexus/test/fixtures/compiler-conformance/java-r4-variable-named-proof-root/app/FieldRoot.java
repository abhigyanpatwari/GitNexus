package app;
import models.User;
class FieldRoot {
  String java;
  void run(java.util.List<User> users) { for (var u : users) u.save(); }
}

package app;
class Both {
  String models;
  static class models { static class User { void save() {} } }
  void run(models.User u) { u.save(); }
}

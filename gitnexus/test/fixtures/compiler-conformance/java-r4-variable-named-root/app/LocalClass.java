package app;
class LocalClass {
  void shadow() {
    class models { class User { void save() {} } }
    models.User u = null;
    u.save();
  }
}

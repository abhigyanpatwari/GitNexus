class User {
  String name = '';

  bool save() {
    return true;
  }
}

User getUser(String name) {
  return User();
}

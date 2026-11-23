package app;
class Field {
  String models;
  void viaParam(models.User u) { u.save(); }
  void viaLocal() { models.User u = null; u.save(); }
}

package app;
import other.User;
@java.lang.annotation.Target(java.lang.annotation.ElementType.TYPE_USE) @interface Mark {}
class App {
  models.User field;
  models.User getUser() { return field; }
  void parameter(models.User user) { user.save(); }
  void local() { models.User user = null; user.save(); }
  void field() { this.field.save(); }
  void returned() { getUser().save(); }
  void constructor() { var user = new models.User(); user.save(); }
  void genericConstructor() { var user = new models.User<>(); user.save(); }
  void annotatedConstructor() { var user = new models.@Mark User<>(); user.save(); }
  void alias(models.User user) { var copy = user; copy.save(); }
  void annotated(models.@Mark User user) { user.save(); }
  void annotatedArray(models.User @Mark [] users) { users[0].save(); }
  void qualifiedArray(models.User[] users) { users[0].save(); }
  void unresolved() { missing.User user = null; user.save(); }
}

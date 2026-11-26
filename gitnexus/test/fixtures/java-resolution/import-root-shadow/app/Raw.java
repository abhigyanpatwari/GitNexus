package app;
import models.User;
public class Raw {
  java.util.List<User> items;
  void viaLambda() { items.forEach(u -> u.save()); }
  void viaLoop() { for (var u : items) u.save(); }
}

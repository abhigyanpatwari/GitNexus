package app;
import java.util.*;
import models.User;
public class OnDemand {
  List<User> items;
  void viaLambda() { items.forEach(u -> u.save()); }
  void viaLoop() { for (var u : items) u.save(); }
}

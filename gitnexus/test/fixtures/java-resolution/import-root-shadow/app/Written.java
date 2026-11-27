package app;
import java.util.*;
public class Written {
  List<models.User> items;
  void viaLambda() { items.forEach(u -> u.save()); }
  void viaLoop() { for (var u : items) u.save(); }
}

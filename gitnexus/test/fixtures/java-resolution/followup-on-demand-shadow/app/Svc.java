package app;
import java.util.*;
class Svc {
  void shadowed(List<User> xs) { for (var u : xs) u.save(); }
  void shadowedLambda(List<User> xs) { xs.forEach(u -> u.save()); }
  void unshadowed(ArrayList<User> xs) { for (var u : xs) u.save(); }
}
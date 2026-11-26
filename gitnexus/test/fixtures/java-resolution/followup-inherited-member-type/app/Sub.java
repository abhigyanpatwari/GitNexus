package app;
import java.util.List;
import lib.Base;
class Sub extends Base {
  List<User> xs;
  void run() { xs.forEach(u -> u.save()); }
  void loop() { for (var u : xs) u.save(); }
}
class Plain {
  List<User> xs;
  void run() { xs.forEach(u -> u.save()); }
}
package app;
import java.util.*;
import lib.Base;
class Sub2 extends Base {
  List<User> xs;
  void run() { xs.forEach(u -> u.save()); }
}
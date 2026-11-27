package app;
import lib.Box;
class Boxed {
  Box<User> xs;
  void run() { xs.forEach(u -> u.save()); }
  void missing() { xs.each(u -> u.save()); }
}
package app;
import java.util.List;
class Sw {
  List<Other> users;
  void inside(int k) {
    switch (k) { case 1: List<User> users = null; users.forEach(u -> u.save()); }
  }
  void after(int k) {
    switch (k) { case 1: List<User> users = null; }
    users.forEach(u -> u.save());
  }
}
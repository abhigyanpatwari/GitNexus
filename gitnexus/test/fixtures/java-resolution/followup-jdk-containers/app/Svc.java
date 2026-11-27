package app;
import java.util.*;
class Svc {
  HashMap<String, User> users;
  Map<String, Other> others;
  void list(List<User> xs) { for (var u : xs) u.save(); }
  void arrayList(ArrayList<User> xs) { for (var u : xs) u.save(); }
  void linkedList(LinkedList<User> xs) { xs.forEach(u -> u.save()); }
  void set(Set<User> xs) { for (var u : xs) u.save(); }
  void hashMapValues() { for (var u : users.values()) u.save(); }
  void mapValues() { for (var o : others.values()) o.save(); }
  void deque(Deque<Other> xs) { for (var o : xs) o.save(); }
  void iterable(Iterable<User> xs) { for (var u : xs) u.save(); }
}
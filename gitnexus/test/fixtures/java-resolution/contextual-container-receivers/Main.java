import java.util.List;
import java.util.Map;
import java.util.stream.Stream;
class User { void save() {} void audit() {} }
class Key { void save() {} }
class App {
  User x;
  void list(List<User> users) { users.forEach(x -> x.save()); }
  void stream(Stream<User> users) { users.forEachOrdered(x -> x.save()); }
  void map(Map<Key, User> users) { users.forEach((key, value) -> { key.save(); value.save(); }); }
  void array(User[] users) { for (var user : users) { user.save(); } }
  void iterable(List<User> users) { for (var user : users) user.save(); }
  void mapValues(Map<Key, User> users) { for (var user : users.values()) user.save(); }
  void mapKeys(Map<Key, User> users) { for (var key : users.keySet()) key.save(); }
  void typedLoop(List<Key> users) { for (Key x : users) x.save(); x.audit(); }
  void raw(List users) { users.forEach(x -> x.save()); }
  void wildcard(List<? extends User> users) { users.forEach(x -> x.save()); }
  <T> void generic(List<T> users) { users.forEach(x -> x.save()); }
  void changing(Stream<User> users) { users.map(x -> x).forEach(x -> x.save()); }
  void unrelated(List<User> users) { users.arbitrary(x -> x.save()); }
  void containerAlias(List<User> users) { var copy = users; copy.save(); }
}

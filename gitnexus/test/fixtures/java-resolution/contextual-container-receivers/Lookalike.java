class List<T> { void forEach(Object callback) {} }
class Map<K,V> { Object values() { return null; } }
class FakeUser { void save() {} }
class Lookalike {
  FakeUser x;
  void custom(List<FakeUser> users) { users.forEach(x -> x.save()); }
  void customMap(Map<String,FakeUser> users) { for (var x : users.values()) x.save(); }
}

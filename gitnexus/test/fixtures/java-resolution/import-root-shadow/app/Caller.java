package app;
public class Caller {
  Repo repo;
  void viaReturn() { var xs = repo.all(); for (var u : xs) u.save(); }
  void viaValues() { var m = repo.byName(); for (var u : m.values()) u.save(); }
  void bothKeys() { var b = repo.both(); for (var k : b.keySet()) k.save(); }
  void bothValues() { var b = repo.both(); for (var v : b.values()) v.save(); }
}

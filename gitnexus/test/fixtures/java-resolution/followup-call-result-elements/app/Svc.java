package app;
import java.util.List;
import other.Item;
public class Svc {
  private Repo repo;
  private Catalog catalog;
  private Generic generic;
  private Overloads overloads;
  List<User> all() { return null; }
  void sameClass() { var xs = all(); for (var x : xs) x.save(); }
  void crossFile() { var xs = repo.findAll(); for (var x : xs) x.save(); }
  void mapValues() { var m = repo.byId(); for (var u : m.values()) u.save(); }
  void mapKeys() { var m = repo.byUser(); for (var k : m.keySet()) k.save(); }
  void copied() { var xs = repo.findAll(); var ys = xs; for (var y : ys) y.save(); }
  void producerImport() { var xs = catalog.items(); for (var x : xs) x.save(); }
  void typeParameter() { var xs = generic.shadowed(); for (var x : xs) x.save(); }
  void methodTypeVariable() { var xs = generic.<User>generic(); for (var x : xs) x.save(); }
  void exactOverload() { var xs = overloads.load("a"); for (var x : xs) x.save(); }
  void unknownOverload(external.Key key) {
    var xs = overloads.load(key.value());
    for (var x : xs) x.save();
  }
}
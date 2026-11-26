package app;
class Sub extends Base {
  void lambda() { items.forEach(v -> v.save()); }
  void loop() { for (var v : items) v.save(); }
  void values() { for (var v : byId.values()) v.save(); }
  void mapForEach() { byId.forEach((k, v) -> v.save()); }
  void array() { for (var v : array) v.save(); }
}
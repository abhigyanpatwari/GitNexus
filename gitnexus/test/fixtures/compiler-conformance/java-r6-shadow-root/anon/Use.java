package anon;
class Use {
  void run(Box<Item> values) {
    new Base() { void go() { values.forEach(value -> value.save()); } };
  }
}

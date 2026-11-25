package jdk;
import java.util.List;
class Use {
  void imported(List<Item> values) { values.forEach(value -> value.save()); }
  void raw(java.util.List<Item> values) { values.forEach(value -> value.save()); }
}

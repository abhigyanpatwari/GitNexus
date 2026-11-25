package p; import java.util.List;
public class App {
  void run(java.util.List<User> values) { values.forEach(value -> value.save()); }
  void alias(java.util.List<User> values) { values.forEach(value -> { var copy = value; copy.save(); }); }
  void nested(java.util.List<List<User>> values) { values.forEach(value -> value.forEach(inner -> inner.save())); }
  void iterate(java.util.List<User> values) { for (var value : values) value.save(); }
  void mapValues(java.util.Map<String,User> values) { for (var value : values.values()) value.save(); }
  void mapCallback(java.util.Map<String,User> values) { values.forEach((key, value) -> value.save()); }
  void imported(List<User> values) { values.forEach(value -> value.save()); }
}

package shadow;
class ShadowProbe {
  ShadowItem value;
  void raw(java.util.List<ShadowItem> values) { values.forEach(value -> value.save()); }
  void callback(java.util.Set<ShadowItem> values) { values.forEach(value -> value.save()); }
}

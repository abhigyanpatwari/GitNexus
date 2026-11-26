package shadow;
class Arrays { static Object asList(long value) { return null; } }
class Long {}
class Shadow {
  void select(java.util.Collection<java.lang.Long> value) {} void select(java.lang.Long value) {}
  void fakeFactory() { select(Arrays.asList(1L)); }
  void scalar(java.lang.Long value) {} void scalar(Long value) {}
  void shadowedBox(Long value) { scalar(value); }
  void generic(java.lang.Long value) {} void generic(Object value) {}
  <Long> void typeParameter(Long value) { generic(value); }
}
class FactoryField {
  Object Arrays;
  void select(java.util.Collection<java.lang.Long> value) {} void select(java.lang.Long value) {}
  void fieldFactory() { select(Arrays.asList(1L)); }
}
class Incomplete extends external.Base {
  void select(java.lang.String value) {} void select(java.lang.Long value) {}
  void inheritedUnknown() { select("x"); }
}
class ObjectOverload {
  void wait(Integer value) {}
  void implicitObject() throws InterruptedException { wait(1); }
}
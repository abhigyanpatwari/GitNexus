
import java.util.*;
class Base { public void inherited(long value) {} public void declared(Object value) {} }
class Derived extends Base {
  public void inherited(Integer value) {}
  public void declared(String value) {}
}
class Intermediate extends Base {}
class Leaf extends Intermediate { public void inherited(Integer value) {} }
class Nest {
  private void nest(Integer value) {} private void nest(long value) {}
  class Inner { void nestedPrivate(Nest outer) { outer.nest(1); } }
}
class StaticInvocation {
  static void staticChoice(Object value) {} void staticChoice(String value) {}
  static void staticUnqualified() { staticChoice("x"); }
  static void staticQualified() { StaticInvocation.staticChoice("x"); }
}
class AccessFilter {
  private void accessFiltered(String value) {} public void accessFiltered(Object value) {}
}
class BaseShadow { String value; }
class OuterShadow { Long value; class InnerShadow extends BaseShadow {
  void shadowPick(String value) {} void shadowPick(Long value) {}
  void inheritedByThis() { shadowPick(this.value); }
  void inheritedImplicit() { shadowPick(value); }
} }
class ForScope { Long item;
  String[] loopSource(String value) { return null; } String[] loopSource(Long value) { return null; }
  void loopBody(String value) {} void loopBody(Long value) {}
  void enhancedForScope() { for (String item : loopSource(item)) { loopBody(item); } }
}
interface API { void dispatch(long value); void dispatch(Integer value); }
interface Generic<T> { void genericDispatch(T value); }
class StringGeneric implements Generic<String> {
  public void genericDispatch(String value) {} public void genericDispatch(Integer value) {}
}
class IntegerGeneric implements Generic<Integer> { public void genericDispatch(Integer value) {} }
interface Left { void preferred(String value); }
interface Right { void preferred(String value); }
abstract class Both implements Left, Right { void preferred(Object value) {} }
class Implementation implements API {
  public void dispatch(long value) {} public void dispatch(Integer value) {}
}
class A { void run() {} A next() { return this; } }
class B { void run() {} B next() { return this; } }
class SubA extends A { void run() {} }
interface Maker { A create(long value); B create(Integer value); }
class MakerImpl implements Maker { public SubA create(long value) { return new SubA(); } public B create(Integer value) { return new B(); } }
class Cases {
  void phase(Integer value) {} void phase(long value) {}
  void boxed(long value) {} void boxed(Number value) {}
  void variable(String... values) {} void variable(Object value) {}
  void nullable(String value) {} void nullable(Integer value) {}
  void crossed(String a, Object b) {} void crossed(Object a, String b) {}
  void opaque(String value) {} void opaque(Long value) {}
  void forbidden(Long value) {}
  void array(Object value) {} void array(String[] value) {}
  void dimensions(Object[] value) {} void dimensions(Object value) {}
  void concrete(Collection<Number> value) {} void concrete(Object value) {}
  void poly(Collection<Number> value) {} void poly(Object value) {}
  void polyAmbiguous(List<Number> value) {} void polyAmbiguous(Collection<Integer> value) {}
  void primitiveArray(List<Long> value) {} void primitiveArray(Object value) {}
  B make(Integer value) { return new B(); } A make(long value) { return new A(); }
  A uncertain(String value) { return new A(); } B uncertain(Long value) { return new B(); }
  void dimension(String value) {} void dimension(Object value) {}
  void widening() { phase(1); }
  void refBeforeUnbox(Integer value) { boxed(value); }
  void fixedBeforeVarargs() { variable("x"); }
  void nullAmbiguous() { nullable(null); }
  void crossedAmbiguous() { crossed("a", "b"); }
  Object external() { return null; }
  void unknownArgument() { opaque(external()); }
  void knownInapplicable() { forbidden(1); }
  void arraySpecific(String[] value) { array(value); }
  void primitiveDimensions(int[][] value) { dimensions(value); }
  void invariant(List<Long> value) { concrete(value); }
  void targetTyped(Long value) { poly(Arrays.asList(value)); }
  void targetTypedSingleton(Long value) { poly(Collections.singletonList(value)); }
  void polyTie() { polyAmbiguous(Arrays.asList(1)); }
  void primitiveFactory(long[] values) { primitiveArray(Arrays.asList(values)); }
  void inheritedPhase(Derived value) { value.inherited(1); }
  void emptyIntermediate(Leaf value) { value.inherited(1); }
  void declaredReceiver() { Base value = new Derived(); value.declared("x"); }
  void virtualDispatch(API value) { value.dispatch(1); }
  void chain() { make(1).run(); }
  void assignedChain() { var value = make(1); value.run(); }
  void nestedChain() { make(1).next().run(); }
  void unknownAssignment() { var value = uncertain(external()); value.run(); }
  void ambiguousAssignment() { var value = uncertain(null); value.run(); }
  void interfaceReturn(Maker maker) { maker.create(1).run(); }
  void trailingDimension(String value[]) { dimension(value); }
  void equivalentPreferred(Both value) { value.preferred("x"); }
  void genericCall(Generic<String> value) { value.genericDispatch("x"); }
  void inaccessibleAlternate(AccessFilter value) { value.accessFiltered(external()); }
  void accessibleKnown(AccessFilter value) { value.accessFiltered("x"); }
  void accessibleObject(AccessFilter value, Object argument) { value.accessFiltered(argument); }
  <T> void genericAny(Generic<T> value, T item) { value.genericDispatch(item); }
}
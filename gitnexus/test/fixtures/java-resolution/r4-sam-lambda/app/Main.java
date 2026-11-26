package app;
import cb.ItemCallback;
class Other { void save() {} void audit() {} }
interface OtherCallback { void accept(Other value); }
interface PairCallback { void accept(Item first, Other second); }
interface TwoMethods { void accept(Item value); void other(Item value); }
interface WithMembers {
  void accept(Item value);
  default void helper(Other value) {}
  static void util(Other value) {}
  boolean equals(Object other);
  String toString();
}
interface Base { void accept(Item value); }
interface Derived extends Base { default void more() {} }
interface External extends java.util.function.Consumer<Item> {}
interface Generic<T> { void accept(T value); }
class Typed {
  Other x;
  void accept(ItemCallback callback) {}
  void pair(PairCallback callback) {}
  void members(WithMembers callback) {}
  void derived(Derived callback) {}
  void generic(Generic<Item> callback) {}
  void bench() { accept(x -> x.audit()); }
  void groupedList(java.util.List<Item> values) { values.forEach(( /* item */ (x -> x.audit()))); }
  void pairs() { pair((x, second) -> { x.audit(); second.save(); }); }
  void localVar() { accept((var x) -> x.audit()); }
  void withMembers() { members(x -> x.audit()); }
  void inherited() { derived(x -> x.audit()); }
  void substituted() { generic(x -> x.audit()); }
  void nested() { accept(outer -> { accept(x -> x.audit()); outer.save(); }); }
  void fieldRead() { x.audit(); }
}
class Refused {
  Item x;
  void accept(ItemCallback callback) {}
  void two(TwoMethods callback) {}
  void external(External callback) {}
  void unknown(missing.Callback callback) {}
  void object(Object callback) {}
  void raw(Generic callback) {}
  void wildcard(Generic<? extends Item> callback) {}
  void nonFunctional() { two(x -> x.audit()); }
  void externalInterface() { external(x -> x.audit()); }
  void unknownType() { unknown(x -> x.audit()); }
  void objectTarget() { object(x -> x.audit()); }
  void arityMismatch() { accept((x, y) -> x.audit()); }
  void rawTarget() { raw(x -> x.audit()); }
  void wildcardTarget() { wildcard(x -> x.audit()); }
  void fieldRead() { x.audit(); }
}
class Overloads {
  Item x;
  void accept(ItemCallback callback) {}
  void accept(PairCallback callback) {}
  void accept(OtherCallback first, OtherCallback second) {}
  void bySamArity() { accept(x -> x.audit()); }
  void byGroupedSamArity() { accept(( /* callback */ (x -> x.audit()))); }
  void byCallArity() { accept(x -> x.audit(), y -> y.save()); }
  void groupedSecond() { accept(x -> x.audit(), /* second */ ((y -> y.save()))); }
}
class Receivers {
  void call(Overloads overloads) { overloads.accept(x -> x.audit()); }
}
class Ambiguous {
  Item x;
  void run(ItemCallback callback) {}
  void run(OtherCallback callback) {}
  void call() { run(x -> x.audit()); }
  void grouped() { run(((x -> x.audit()))); }
}
class StaticContext {
  Item x;
  void accept(ItemCallback callback) {}
  void accept(PairCallback callback) {}
  static void call() { accept(x -> x.audit()); }
}

import { describe, expect, it } from 'vitest';
import { getRelationships, useFixture, type RelEdge } from './resolvers/helpers.js';

const targets = (edges: readonly RelEdge[], caller: string, member: string): string[] =>
  edges
    .filter((edge) => edge.rel.sourceId === caller && edge.target === member)
    .map((edge) => edge.rel.targetId)
    .sort();

// JLS 15.27.3 / 9.9: an implicitly typed lambda parameter takes the type of the
// matching parameter of its target's function type. The target is the
// parameter type of the method javac selects for the enclosing call.
describe('Java implicitly typed lambda parameters from a workspace functional interface', () => {
  const result = useFixture('java-r4-sam-lambda', {
    'cb/model/Item.java': `package cb.model;
public class Item { public void save() {} public void audit() {} }
`,
    'cb/ItemCallback.java': `package cb;
import cb.model.Item;
public interface ItemCallback { void accept(Item value); }
`,
    'app/Item.java': `package app;
public class Item { public void save() {} public void audit() {} }
`,
    'app/Main.java': `package app;
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
  void byCallArity() { accept(x -> x.audit(), y -> y.save()); }
}
class Receivers {
  void call(Overloads overloads) { overloads.accept(x -> x.audit()); }
}
class Ambiguous {
  Item x;
  void run(ItemCallback callback) {}
  void run(OtherCallback callback) {}
  void call() { run(x -> x.audit()); }
}
class StaticContext {
  Item x;
  void accept(ItemCallback callback) {}
  void accept(PairCallback callback) {}
  static void call() { accept(x -> x.audit()); }
}
`,
  });

  const workspaceItemAudit = 'Method:cb/model/Item.java:Item.audit#0';
  const localItemAudit = 'Method:app/Item.java:Item.audit#0';
  const otherAudit = 'Method:app/Main.java:Other.audit#0';

  it('types the bench shape from the interface, read in the interface file', () => {
    const edges = getRelationships(result(), 'CALLS');
    expect(targets(edges, 'Method:app/Main.java:Typed.bench#0', 'audit')).toEqual([
      workspaceItemAudit,
    ]);
  });

  it.each([
    ['Method:app/Main.java:Typed.localVar#0'],
    ['Method:app/Main.java:Typed.nested#0'],
    ['Method:app/Main.java:Overloads.bySamArity#0'],
    ['Method:app/Main.java:Receivers.call#1'],
  ])('binds the single abstract method parameter in %s', (caller) => {
    expect(targets(getRelationships(result(), 'CALLS'), caller, 'audit')).toEqual([
      workspaceItemAudit,
    ]);
  });

  it.each([
    ['Method:app/Main.java:Typed.withMembers#0'],
    ['Method:app/Main.java:Typed.inherited#0'],
    ['Method:app/Main.java:Typed.substituted#0'],
  ])('binds a same-package Item through %s', (caller) => {
    expect(targets(getRelationships(result(), 'CALLS'), caller, 'audit')).toEqual([localItemAudit]);
  });

  it('binds each parameter of a two-parameter function type', () => {
    const edges = getRelationships(result(), 'CALLS');
    const caller = 'Method:app/Main.java:Typed.pairs#0';
    expect(targets(edges, caller, 'audit')).toEqual([localItemAudit]);
    expect(targets(edges, caller, 'save')).toEqual(['Method:app/Main.java:Other.save#0']);
  });

  it('keeps an outer lambda parameter typed for its own body', () => {
    expect(
      targets(getRelationships(result(), 'CALLS'), 'Method:app/Main.java:Typed.nested#0', 'save'),
    ).toEqual(['Method:cb/model/Item.java:Item.save#0']);
  });

  it('selects the one overload whose functional interface matches the lambda arity', () => {
    const edges = getRelationships(result(), 'CALLS');
    expect(targets(edges, 'Method:app/Main.java:Overloads.bySamArity#0', 'accept')).toEqual([
      'Method:app/Main.java:Overloads.accept#1~ItemCallback',
    ]);
    expect(targets(edges, 'Method:app/Main.java:Overloads.byCallArity#0', 'accept')).toEqual([
      'Method:app/Main.java:Overloads.accept#2',
    ]);
    expect(targets(edges, 'Method:app/Main.java:Overloads.byCallArity#0', 'audit')).toEqual([
      otherAudit,
    ]);
    expect(targets(edges, 'Method:app/Main.java:Overloads.byCallArity#0', 'save')).toEqual([
      'Method:app/Main.java:Other.save#0',
    ]);
  });

  it.each([
    ['Method:app/Main.java:Refused.nonFunctional#0'],
    ['Method:app/Main.java:Refused.externalInterface#0'],
    ['Method:app/Main.java:Refused.unknownType#0'],
    ['Method:app/Main.java:Refused.objectTarget#0'],
    ['Method:app/Main.java:Refused.arityMismatch#0'],
    ['Method:app/Main.java:Refused.rawTarget#0'],
    ['Method:app/Main.java:Refused.wildcardTarget#0'],
    ['Method:app/Main.java:Ambiguous.call#0'],
    ['Method:app/Main.java:StaticContext.call#0'],
  ])('leaves the parameter unbound, never the outer field, in %s', (caller) => {
    expect(result().graph.getNode(caller)).toBeDefined();
    expect(targets(getRelationships(result(), 'CALLS'), caller, 'audit')).toEqual([]);
  });

  it.each([
    ['Method:app/Main.java:Typed.fieldRead#0', otherAudit],
    ['Method:app/Main.java:Refused.fieldRead#0', localItemAudit],
  ])('leaves the same-named field typed as declared in %s', (caller, target) => {
    expect(targets(getRelationships(result(), 'CALLS'), caller, 'audit')).toEqual([target]);
  });

  it.each([
    ['Method:app/Main.java:Ambiguous.call#0', 'run'],
    ['Method:app/Main.java:StaticContext.call#0', 'accept'],
  ])('does not select an overload for %s', (caller, member) => {
    expect(targets(getRelationships(result(), 'CALLS'), caller, member)).toEqual([]);
  });
});

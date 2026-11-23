import { describe, expect, it } from 'vitest';
import { getRelationships, useFixture, type RelEdge } from '../integration/resolvers/helpers.js';

// Java array receivers, array elements and array-returning producers: owner
// identity, qualified element types, annotations, and this/super producers.

describe('Java array receiver identity', () => {
  const result = useFixture('java-array-receivers', {
    'Main.java': `
class User {
  void save() {}
  public User clone() { return this; }
  public String toString() { return "user"; }
  void getClass() {}
}
class Other { void save() {} }
class List<T> { void save() {} }
class App {
  User[] field;
  User[] getUsers() { return field; }
  User trailingReturn()[] { return field; }
  void parameter(User[] users) { users[0].save(); }
  void trailingParameter(User users[]) { users[0].save(); }
  void varargs(User... users) { users[0].save(); }
  void local() { User[] users = null; users[0].save(); }
  void trailingLocal() { User users[] = null; users[0].save(); }
  void mixedScalar() { User first = null, second[] = null; first.save(); }
  void mixedArray() { User first = null, second[] = null; second[0].save(); }
  void mixedDimensions() { User[] first = null, second[] = null; first[0].save(); }
  void fieldElement() { this.field[0].save(); }
  void methodElement() { getUsers()[0].save(); }
  void trailingMethodElement() { trailingReturn()[0].save(); }
  void unindexed(User[] users) { users.save(); }
  void partial(User[][] users) { users[0].save(); }
  void mixedPartial() { User[] first = null, second[] = null; second[0].save(); }
  void listIndex(List<User> users) { users[0].save(); }
  void cloneArray(User[] users) { users.clone(); }
  void stringifyArray(User[] users) { users.toString(); }
  void classArray(User[] users) { users.getClass(); }
  void iterateArray(User[] users) { for (var user : users) user.save(); }
  void iterateList(java.util.List<User> users) { for (var user : users) user.save(); }
}
`,
  });
  const targets = (caller: string, member = 'save') =>
    getRelationships(result(), 'CALLS')
      .filter((edge) => edge.source === caller && edge.target === member)
      .map((edge) => edge.rel.targetId)
      .sort();

  it.each([
    'parameter',
    'trailingParameter',
    'varargs',
    'local',
    'trailingLocal',
    'mixedScalar',
    'mixedArray',
    'mixedDimensions',
    'fieldElement',
    'methodElement',
    'trailingMethodElement',
    'iterateArray',
    'iterateList',
  ])('%s resolves only the element owner', (caller) => {
    expect(targets(caller)).toEqual(['Method:Main.java:User.save#0']);
  });

  it.each(['unindexed', 'partial', 'mixedPartial', 'listIndex'])(
    '%s refuses element ownership without a complete array index',
    (caller) => {
      expect(targets(caller)).toEqual([]);
    },
  );

  it.each([
    ['cloneArray', 'clone'],
    ['stringifyArray', 'toString'],
    ['classArray', 'getClass'],
  ])('%s never resolves an Object method to the element class', (caller, member) => {
    expect(targets(caller, member)).toEqual([]);
  });
});

describe('Java array method return owner identity', () => {
  const result = useFixture('java-array-method-return-identity', {
    'Main.java': `
class User { void save() {} }
class Other { void save() {} }
class App {
  User[] getUsers() { return null; }
  User trailingReturn()[] { return null; }
  void bare() { getUsers()[0].save(); }
  void trailing() { trailingReturn()[0].save(); }
  void explicit(Service service) { service.getUsers()[0].save(); }
}
class Ambiguous {
  User[] getUsers() { return null; }
  Other[] getUsers(int value) { return null; }
  User[] pick(Integer value) { return null; }
  Other[] pick(String value) { return null; }
  void overloaded() { getUsers()[0].save(); }
  void tied() { this.pick(null)[0].save(); }
}
class Service { Other[] getUsers() { return null; } }
`,
  });

  it.each([
    ['App.bare#0', 'User'],
    ['App.trailing#0', 'User'],
    ['App.explicit#1', 'Other'],
  ])('preserves the exact return owner for %s', (caller, owner) => {
    const targets = getRelationships(result(), 'CALLS')
      .filter(
        (edge) => edge.rel.sourceId === `Method:Main.java:${caller}` && edge.target === 'save',
      )
      .map((edge) => edge.rel.targetId)
      .sort();
    expect(targets).toEqual([`Method:Main.java:${owner}.save#0`]);
  });

  // javac selects the zero-argument `getUsers()` (User[]) although the two
  // `getUsers` declarations disagree on the return type, so the receiver is
  // typed from that selected overload. A `null` argument applies to both
  // `pick` overloads and neither is more specific: no return type is chosen.
  it.each<[string, string[]]>([
    ['Ambiguous.overloaded#0', ['Method:Main.java:User.save#0']],
    ['Ambiguous.tied#0', []],
  ])('types %s only from the selected overload', (caller, expected) => {
    expect(result().graph.getNode(`Method:Main.java:${caller}`)).toBeDefined();
    const targets = getRelationships(result(), 'CALLS')
      .filter(
        (edge) => edge.rel.sourceId === `Method:Main.java:${caller}` && edge.target === 'save',
      )
      .map((edge) => edge.rel.targetId);
    expect(targets).toEqual(expected);
  });
});

describe('Java array and factory alias adversarial controls', () => {
  const result = useFixture('java-array-alias-adversarial', {
    'Main.java': `
class Element {
  void save() {}
  public Element clone() { return this; }
  Element[] get() { return null; }
}
class Other { void save() {} }
class T { void save() {} }
class Base { void save() {} }
class Generic<T extends Base> {
  void bounded(T[] values) { values[0].save(); }
}
class Source { Element make() { return new Element(); } }
class User { void save() {} }
class Decoy { void save() {} }
class Service { User[] getUsers() { return null; } }
class DecoyService { Decoy[] getUsers() { return null; } }
class ArraySource {
  Element[] onlyArgument(int selector) { return null; }
  private Element[] hidden() { return null; }
  Element[] varargs(int... selectors) { return null; }
}
class App {
  Element[] onlyArgument(int selector) { return null; }
  void inapplicableNoArg() { onlyArgument()[0].save(); }
  void inapplicableExplicit(ArraySource source) { source.onlyArgument()[0].save(); }
  void inaccessibleExplicit(ArraySource source) { source.hidden()[0].save(); }
  void applicableExplicit(ArraySource source) { source.onlyArgument(1)[0].save(); }
  void varargsExplicit(ArraySource source) { source.varargs()[0].save(); }
  void cloneChain(Element[] values) { values.clone().save(); }
  void partialCloneChain(Element[][] values) { values[0].clone().save(); }
  void elementCloneChain(Element[] values) { values[0].clone().save(); }
  void elementProducer(Service[] services) { services[0].getUsers()[0].save(); }
  void decoyElementProducer(DecoyService[] services) { services[0].getUsers()[0].save(); }
  void arrayProducerReceiver(Service[][] services) { services[0].getUsers()[0].save(); }
  void parenthesizedArray(Element[] values) { ((values))[0].save(); }
  void copyArray(Element[] values) { var copy = values; copy[0].save(); }
  void copyArrayNegative(Element[] values) { var copy = values; copy.save(); }
  void factoryCopySnapshot(Source source, Source replacement) {
    var value = source.make();
    var copy = value;
    value = replacement.make();
    copy.save();
  }
}
`,
    'a/Element.java': 'package a; public class Element { public void save() {} }',
    'b/Element.java': 'package b; public class Element { public void save() {} }',
    'Qualified.java': `import b.Element;
class Qualified {
  void positive(a.Element[] values) { values[0].save(); }
  void negative(a.Element[] values) { values.save(); }
}`,
  });
  const targets = (owner: string, caller: string) =>
    getRelationships(result(), 'CALLS')
      .filter(
        (edge) =>
          edge.rel.sourceId.startsWith(`Method:${owner}.${caller}#`) && edge.target === 'save',
      )
      .map((edge) => edge.rel.targetId)
      .sort();

  // `values[0]` of an `Element[][]` is an `Element[]`, whose clone() is an
  // array again; `services[0]` of a `Service[][]` is an array with no members.
  it.each([
    'cloneChain',
    'partialCloneChain',
    'arrayProducerReceiver',
    'copyArrayNegative',
    'inapplicableExplicit',
    'inaccessibleExplicit',
  ])('%s never borrows an element owner', (caller) => {
    expect(targets('Main.java:App', caller)).toEqual([]);
  });
  it.each([
    'parenthesizedArray',
    'copyArray',
    'factoryCopySnapshot',
    'applicableExplicit',
    'varargsExplicit',
  ])('%s preserves the exact selected owner', (caller) => {
    expect(targets('Main.java:App', caller)).toEqual(['Method:Main.java:Element.save#0']);
  });
  // An array element is typed as the operand's component type, one dimension
  // per index, so a producer invoked on it is selected on its real owner.
  it.each([
    ['elementCloneChain', 'Method:Main.java:Element.save#0'],
    ['elementProducer', 'Method:Main.java:User.save#0'],
    ['decoyElementProducer', 'Method:Main.java:Decoy.save#0'],
  ])('%s calls exactly %s through an array-element producer receiver', (caller, target) => {
    expect(targets('Main.java:App', caller)).toEqual([target]);
  });
  it('never routes an array-element producer to a same-named producer on another owner', () => {
    expect(targets('Main.java:App', 'elementProducer')).not.toContain(
      'Method:Main.java:Decoy.save#0',
    );
    expect(targets('Main.java:App', 'decoyElementProducer')).not.toContain(
      'Method:Main.java:User.save#0',
    );
  });
  it('never redirects a written qualified array element to an imported same-name owner', () => {
    expect(targets('Qualified.java:Qualified', 'positive')).not.toContain(
      'Method:b/Element.java:Element.save#0',
    );
    expect(targets('Qualified.java:Qualified', 'positive')).toEqual([
      'Method:a/Element.java:Element.save#0',
    ]);
    expect(targets('Qualified.java:Qualified', 'negative')).toEqual([]);
  });
  it('does not interpret an array element type parameter as an unrelated same-named class', () => {
    expect(targets('Main.java:Generic', 'bounded')).not.toContain('Method:Main.java:T.save#0');
    expect(targets('Main.java:Generic', 'bounded')).toEqual(['Method:Main.java:Base.save#0']);
  });
  it('does not infer an array element from an inapplicable implicit producer call', () => {
    expect(targets('Main.java:App', 'inapplicableNoArg')).toEqual([]);
  });
});

describe('Java annotated lambda array parameter', () => {
  const result = useFixture('java-annotated-lambda-array', {
    'Main.java': `class Element { void save() {} }
  class Marker { void save() {} }
  interface ArrayAction { void accept(Element[] values); }
  class App {
    void run() {
      ArrayAction action = (Element @p.Marker [] values) -> values[0].save();
    }
  }`,
    'p/Marker.java': `package p;
  import java.lang.annotation.Target;
  import java.lang.annotation.ElementType;
  @Target(ElementType.TYPE_USE) public @interface Marker {}`,
  });

  it('resolves the lambda array element owner, never the type-use annotation', () => {
    const targets = getRelationships(result(), 'CALLS')
      .filter((edge) => edge.target === 'save')
      .map((edge) => edge.rel.targetId);
    expect(targets).toEqual(['Method:Main.java:Element.save#0']);
  });
});

/**
 * `values[0].save()` over an array whose element type is written qualified
 * (`Outer.Inner[]`). The element spelling is read where the array was
 * declared, through the same qualified lookup a declared `Outer.Inner` takes,
 * so a top-level `Inner` in the same package is never the owner, and a
 * qualifier the lookup refuses leaves the call unresolved.
 */
describe('Java array elements written as qualified member types', () => {
  const result = useFixture('java-r5-qualified-array-elements', {
    'p/Model.java': `package p;
public class Model {}
class Outer { static class Inner { void save() {} } }`,
    'p/Decoy.java': 'package p; class Inner { void save() {} }',
    'q/Outer2.java': `package q;
public class Outer2 { public static class Inner { public void save() {} } }`,
    'p/Use.java': `package p;
import q.Outer2;
class Use {
  Outer.Inner[] field;
  void parameter(Outer.Inner[] values) { values[0].save(); }
  void local() { Outer.Inner[] values = new Outer.Inner[1]; values[0].save(); }
  void viaField() { field[0].save(); }
  void viaThis() { this.field[0].save(); }
  void importedRoot(Outer2.Inner[] values) { values[0].save(); }
  void fullyQualified(q.Outer2.Inner[] values) { values[0].save(); }
  void simple(Inner[] values) { values[0].save(); }
}`,
    // The inherited member type Outer shadows the same-package top-level Outer
    // (JLS 6.4.1).
    'p/Single.java': `package p;
class SingleBase { static class Outer { static class Inner { void save() {} } } }
class Single extends SingleBase { void run(Outer.Inner[] values) { values[0].save(); } }`,
    // Outer is inherited from both a superclass and an interface: the name is
    // ambiguous (JLS 8.5), so the qualified lookup refuses.
    'p/BaseB.java': 'package p; interface BaseB { class Outer { class Inner { void save() {} } } }',
    'p/Ambiguous.java': `package p;
class BaseA { static class Outer { static class Inner { void save() {} } } }
class Ambiguous extends BaseA implements BaseB {
  void run(Outer.Inner[] values) { values[0].save(); }
  void runPlain(Outer.Inner value) { value.save(); }
}`,
  });

  const saveTargets = (caller: string): string[] =>
    getRelationships(result(), 'CALLS')
      .filter((edge: RelEdge) => edge.rel.sourceId === caller && edge.target === 'save')
      .map((edge) => edge.rel.targetId)
      .sort();

  it.each([
    ['Use.parameter#1', 'Method:p/Model.java:Inner.save#0'],
    ['Use.local#0', 'Method:p/Model.java:Inner.save#0'],
    ['Use.viaField#0', 'Method:p/Model.java:Inner.save#0'],
    ['Use.viaThis#0', 'Method:p/Model.java:Inner.save#0'],
    ['Use.importedRoot#1', 'Method:q/Outer2.java:Inner.save#0'],
    ['Use.fullyQualified#1', 'Method:q/Outer2.java:Inner.save#0'],
    ['Use.simple#1', 'Method:p/Decoy.java:Inner.save#0'],
  ])('types the element of %s as the written type: %s', (method, target) => {
    expect(saveTargets(`Method:p/Use.java:${method}`)).toEqual([target]);
  });

  it('reads an inherited member type before a same-package top-level type', () => {
    const targets = saveTargets('Method:p/Single.java:Single.run#1');
    expect(targets).not.toContain('Method:p/Model.java:Inner.save#0');
    expect(targets).toEqual(['Method:p/Single.java:Inner.save#0']);
  });

  it.each(['Ambiguous.run#1', 'Ambiguous.runPlain#1'])(
    'leaves %s unresolved when the qualified lookup refuses an ambiguous root',
    (method) => {
      expect(saveTargets(`Method:p/Ambiguous.java:${method}`)).toEqual([]);
    },
  );
});

describe('Java this/super array producers', () => {
  const result = useFixture('java-review-followups-overload', {
    'Main.java': `
class User { void save() {} }
class Other { void save() {} }
interface Marker { Other[] items(); }
class Base {
  User[] items() { return null; }
  private Other[] hidden() { return null; }
  User[] over() { return null; }
  Other[] over(int value) { return null; }
  User[] pick(Integer value) { return null; }
  Other[] pick(String value) { return null; }
}
class Sub extends Base {
  User[] own() { return null; }
  void viaSuper() { super.items()[0].save(); }
  void viaThis() { this.own()[0].save(); }
  void privateSuper() { super.hidden()[0].save(); }
  void overloadedSuper() { super.over()[0].save(); }
  void ambiguousSuper() { super.pick(null)[0].save(); }
  void anonymous() {
    new Runnable() {
      Other[] own() { return null; }
      public void run() { this.own()[0].save(); }
    };
  }
}
class Lone implements Marker {
  public Other[] items() { return null; }
  void viaObjectSuper() { super.items()[0].save(); }
}
`,
  });

  const targets = (caller: string, name: string): string[] =>
    getRelationships(result(), 'CALLS')
      .filter((edge) => edge.rel.sourceId === `Method:Main.java:${caller}` && edge.target === name)
      .map((edge) => edge.rel.targetId)
      .sort();
  const saveTargets = (caller: string): string[] => targets(caller, 'save');

  it.each([['Sub.viaSuper#0'], ['Sub.viaThis#0'], ['Sub.overloadedSuper#0']])(
    'binds the element of the producer selected through %s',
    (caller) => {
      expect(saveTargets(caller)).toEqual(['Method:Main.java:User.save#0']);
    },
  );

  it('types this inside an anonymous class as that class, not the enclosing Sub', () => {
    // Sub.own() returns User[] and must never be the producer of this.own().
    expect(targets('Sub$1.run#0', 'own')).toEqual(['Method:Main.java:Sub$1.own#0']);
    expect(saveTargets('Sub$1.run#0')).toEqual(['Method:Main.java:Other.save#0']);
  });

  it.each([['Sub.privateSuper#0'], ['Sub.ambiguousSuper#0'], ['Lone.viaObjectSuper#0']])(
    'leaves %s unresolved when the producer cannot be proven',
    (caller) => {
      expect(result().graph.getNode(`Method:Main.java:${caller}`)).toBeDefined();
      expect(saveTargets(caller)).toEqual([]);
    },
  );
});

describe('Java implicit array receivers inside an anonymous class method', () => {
  const result = useFixture('java-anonymous-implicit-array', {
    'app/User.java': 'package app; public class User { public void save() {} }',
    'app/Other.java': 'package app; public class Other { public void save() {} }',
    'app/Host.java': `package app;
public class Host {
  User[] items() { return null; }
  Runnable task = new Runnable() {
    Other[] items() { return null; }
    public void run() { items()[0].save(); }
  };
  void named() { items()[0].save(); }
}`,
  });
  const saveTargets = (caller: string): string[] =>
    getRelationships(result(), 'CALLS')
      .filter((edge) => edge.rel.sourceId === caller && edge.target === 'save')
      .map((edge) => edge.rel.targetId)
      .sort();

  it.each([
    [
      'the anonymous class',
      'Method:app/Host.java:Host$1.run#0',
      'Method:app/Other.java:Other.save#0',
    ],
    ['the named class', 'Method:app/Host.java:Host.named#0', 'Method:app/User.java:User.save#0'],
  ])('reads items() of %s for an implicit receiver', (_label, caller, target) => {
    expect(saveTargets(caller)).toEqual([target]);
  });
});

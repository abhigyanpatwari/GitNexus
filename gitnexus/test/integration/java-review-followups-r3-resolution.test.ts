import { describe, expect, it } from 'vitest';
import { getRelationships, useFixture, type RelEdge } from './resolvers/helpers.js';

const saveTargets = (edges: readonly RelEdge[], caller: string): string[] =>
  edges
    .filter((edge) => edge.rel.sourceId === caller && edge.target === 'save')
    .map((edge) => edge.rel.targetId)
    .sort();

// JLS 6.4.1: an inherited member type shadows a package of the same name, so
// `models.User` inside `Child` is `Base.models.User`, never `models.User`.
describe('Java qualified type roots shadowed by an inherited member type', () => {
  const result = useFixture('java-r3-inherited-member-root', {
    'models/User.java': `package models;
public class User { public void save() {} }
`,
    'app/Base.java': `package app;
public class Base {
  public static class models {
    public static class User { public void save() {} }
  }
}
`,
    'app/Child.java': `package app;
public class Child extends Base {
  void run(models.User u) { u.save(); }
  class Nested {
    void run(models.User u) { u.save(); }
  }
}
`,
    'app/Plain.java': `package app;
public class Plain {
  void run(models.User u) { u.save(); }
}
`,
  });

  it.each([['Method:app/Child.java:Child.run#1'], ['Method:app/Child.java:Nested.run#1']])(
    'reads the inherited member root as that member type in %s',
    (caller) => {
      expect(saveTargets(getRelationships(result(), 'CALLS'), caller)).toEqual([
        'Method:app/Base.java:User.save#0',
      ]);
    },
  );

  it('still reads the root as a package where no member type is inherited', () => {
    expect(
      saveTargets(getRelationships(result(), 'CALLS'), 'Method:app/Plain.java:Plain.run#1'),
    ).toEqual(['Method:models/User.java:User.save#0']);
  });
});

// An indexed producer is typed from the overload javac selects at that call,
// one array dimension per index step; ambiguous or unknown selections stay
// unresolved instead of picking either return type.
describe('Java overloaded producers before an array index', () => {
  const result = useFixture('java-r3-indexed-overloads', {
    'Main.java': `
class User { void save() {} }
class Other { void save() {} }
class Base {
  User[] over() { return null; }
  Other[] over(int value) { return null; }
}
class Sub extends Base {
  void viaSuper() { super.over()[0].save(); }
  void viaThis() { this.over(1)[0].save(); }
}
class Holder {
  Other[] make() { return null; }
  User[] make(int value) { return null; }
  User[][] grid() { return null; }
  Other[][] grid(int value) { return null; }
  User[] pick(Integer value) { return null; }
  Other[] pick(String value) { return null; }
}
class Free {
  User[] all() { return null; }
  Other[] all(int value) { return null; }
  void none() { all()[0].save(); }
}
class Use {
  void typedNoArg(Holder h) { h.make()[0].save(); }
  void typedInt(Holder h) { h.make(1)[0].save(); }
  void twoDims(Holder h) { h.grid()[0][1].save(); }
  void tooFewDims(Holder h) { h.grid()[0].save(); }
  void ambiguousNull(Holder h) { h.pick(null)[0].save(); }
  void unknownArgument(Holder h, Missing m) { h.pick(m.value())[0].save(); }
}
`,
  });

  it.each([
    ['Sub.viaSuper#0', 'User'],
    ['Sub.viaThis#0', 'Other'],
    ['Free.none#0', 'User'],
    ['Use.typedNoArg#1', 'Other'],
    ['Use.typedInt#1', 'User'],
    ['Use.twoDims#1', 'User'],
  ])('binds %s to the element of the selected overload', (caller, owner) => {
    expect(saveTargets(getRelationships(result(), 'CALLS'), `Method:Main.java:${caller}`)).toEqual([
      `Method:Main.java:${owner}.save#0`,
    ]);
  });

  it.each([['Use.tooFewDims#1'], ['Use.ambiguousNull#1'], ['Use.unknownArgument#2']])(
    'leaves %s unresolved',
    (caller) => {
      expect(result().graph.getNode(`Method:Main.java:${caller}`)).toBeDefined();
      expect(
        saveTargets(getRelationships(result(), 'CALLS'), `Method:Main.java:${caller}`),
      ).toEqual([]);
    },
  );
});

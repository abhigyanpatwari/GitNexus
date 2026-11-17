import { describe, expect, it } from 'vitest';
import { getRelationships, useFixture, type RelEdge } from './resolvers/helpers.js';

const saveTargetsOf =
  (result: () => Parameters<typeof getRelationships>[0]) =>
  (caller: string): string[] =>
    getRelationships(result(), 'CALLS')
      .filter((edge: RelEdge) => edge.rel.sourceId === caller && edge.target === 'save')
      .map((edge) => edge.rel.targetId)
      .sort();

/**
 * `users()[0].save()` peels the producer's declared return type to its element.
 * Type annotations and comments are not part of a Java type's spelling, so a
 * return type written `User @Mark []` or `User /* c *\/ []` (or with its
 * dimensions after the parameter list, or as a record component's type) types
 * the element exactly as `User[]`.
 */
describe('Java producer return types written with annotations or comments', () => {
  const result = useFixture('java-r6-annotated-producer-returns', {
    'e/User.java': 'package e; public class User { public void save() {} }',
    'e/Mark.java': `package e;
@java.lang.annotation.Target(java.lang.annotation.ElementType.TYPE_USE)
public @interface Mark {}`,
    'e/Repo.java': `package e;
class Repo {
  User @Mark [] annotated() { return null; }
  User /* c */ [] blockComment() { return null; }
  User // c
    [] lineComment() { return null; }
  User trailing() @Mark [] { return null; }
  User @Mark [] [] nested() { return null; }
  User @Mark [] split() /* c */ [] { return null; }
  User plain()[] { return null; }
  void callAnnotated() { annotated()[0].save(); }
  void callBlockComment() { blockComment()[0].save(); }
  void callLineComment() { lineComment()[0].save(); }
  void callTrailing() { trailing()[0].save(); }
  void callNested() { nested()[0][0].save(); }
  void callSplit() { split()[0][0].save(); }
  void callPlain() { plain()[0].save(); }
}`,
    'e/Rec.java': `package e;
record Rec(User @Mark [] users) { void callRecord() { users()[0].save(); } }`,
  });
  const saveTargets = saveTargetsOf(result);

  it.each([
    'e/Repo.java:Repo.callAnnotated#0',
    'e/Repo.java:Repo.callBlockComment#0',
    'e/Repo.java:Repo.callLineComment#0',
    'e/Repo.java:Repo.callTrailing#0',
    'e/Repo.java:Repo.callNested#0',
    'e/Repo.java:Repo.callSplit#0',
    'e/Repo.java:Repo.callPlain#0',
    'e/Rec.java:Rec.callRecord#0',
  ])('types the producer element in %s as User', (caller) => {
    expect(saveTargets(`Method:${caller}`)).toEqual(['Method:e/User.java:User.save#0']);
  });
});

/**
 * `make()[0].save()` over a producer whose return type names a member type
 * (`Outer.Inner[]`). The peeled element is a qualified spelling written where
 * the return type was declared, so it takes the qualified lookup a declared
 * `Outer.Inner` takes there: a same-package top-level `Inner` is never the
 * owner, and a qualifier the lookup refuses leaves the call unresolved.
 */
describe('Java producer return types written as qualified member-type arrays', () => {
  const result = useFixture('java-r6-qualified-producer-returns', {
    'f/Model.java': `package f;
public class Model {}
class Outer { static class Inner { void save() {} } }`,
    'f/Inner.java': 'package f; class Inner { void save() {} }',
    'g/Outer2.java': `package g;
public class Outer2 { public static class Inner { public void save() {} } }`,
    'f/Prod.java': `package f;
import g.Outer2;
public class Prod {
  Outer.Inner[] samePackage() { return null; }
  Outer2.Inner[] imported() { return null; }
  g.Outer2.Inner[] fullyQualified() { return null; }
  Outer.Inner[][] grid() { return null; }
  Inner[] simple() { return null; }
  protected Outer.Inner[] shared() { return null; }
  void callSamePackage() { samePackage()[0].save(); }
  void callImported() { imported()[0].save(); }
  void callFullyQualified() { fullyQualified()[0].save(); }
  void callGrid() { grid()[0][0].save(); }
  void callSimple() { simple()[0].save(); }
}`,
    // The return type means what it meant where it was written: this package's
    // own Outer does not rebind the inherited producer's element.
    'h/Outer.java': 'package h; class Outer { static class Inner { void save() {} } }',
    'h/Caller.java': `package h;
class Caller extends f.Prod { void callShared() { shared()[0].save(); } }`,
    // The inherited member type Outer shadows the same-package top-level Outer
    // (JLS 6.4.1) where the return type was written.
    'f/Single.java': `package f;
class SingleBase { static class Outer { static class Inner { void save() {} } } }
class Single extends SingleBase {
  Outer.Inner[] make() { return null; }
  void run() { make()[0].save(); }
}`,
    // Outer is inherited from both a superclass and an interface: the name is
    // ambiguous (JLS 8.5), so the qualified lookup refuses.
    'f/BaseB.java': 'package f; interface BaseB { class Outer { class Inner { void save() {} } } }',
    'f/Ambiguous.java': `package f;
class BaseA { static class Outer { static class Inner { void save() {} } } }
class Ambiguous extends BaseA implements BaseB {
  Outer.Inner[] make() { return null; }
  void run() { make()[0].save(); }
}`,
  });
  const saveTargets = saveTargetsOf(result);

  it.each([
    ['f/Prod.java:Prod.callSamePackage#0', 'Method:f/Model.java:Inner.save#0'],
    ['f/Prod.java:Prod.callImported#0', 'Method:g/Outer2.java:Inner.save#0'],
    ['f/Prod.java:Prod.callFullyQualified#0', 'Method:g/Outer2.java:Inner.save#0'],
    ['f/Prod.java:Prod.callGrid#0', 'Method:f/Model.java:Inner.save#0'],
    ['f/Prod.java:Prod.callSimple#0', 'Method:f/Inner.java:Inner.save#0'],
    ['h/Caller.java:Caller.callShared#0', 'Method:f/Model.java:Inner.save#0'],
    ['f/Single.java:Single.run#0', 'Method:f/Single.java:Inner.save#0'],
  ])('types the producer element in %s as the written type: %s', (caller, target) => {
    expect(saveTargets(`Method:${caller}`)).toEqual([target]);
  });

  it('leaves the producer element unresolved when the qualified lookup refuses an ambiguous root', () => {
    expect(saveTargets('Method:f/Ambiguous.java:Ambiguous.run#0')).toEqual([]);
  });
});

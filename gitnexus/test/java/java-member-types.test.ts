import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  getRelationships,
  runPipelineFromRepo,
  useFixture,
  writeFixtureRepo,
  type RelEdge,
} from '../integration/resolvers/helpers.js';
import type { PipelineResult } from '../../src/types/pipeline.js';

// Java member types: inherited, protected, private and hidden member types, producer
// return types, and fields inherited from a same-package base.

const callTargets = (result: PipelineResult, caller: string, name: string): string[] =>
  getRelationships(result, 'CALLS')
    .filter((edge) => edge.rel.sourceId === caller && edge.target === name)
    .map((edge) => edge.rel.targetId)
    .sort();

const saveTargets = (result: PipelineResult, caller: string): string[] =>
  getRelationships(result, 'CALLS')
    .filter((edge: RelEdge) => edge.rel.sourceId === caller && edge.target === 'save')
    .map((edge) => edge.rel.targetId)
    .sort();

// JLS 6.6.2 / 8.5: a protected member type is accessible in, and so inherited
// by, the body of a subclass in another package. `Box.Item` there is the
// member path of the supertype's `Box`. A package-private `Box` of another
// package is not inherited at all, so the root reads as it would without it;
// code outside a subclass cannot reach a protected `Box`.
describe('Java protected member types inherited across packages', () => {
  const result = useFixture('java-r6-protected-member-root', {
    'a/Base2.java': `package a;
public class Base2 { protected static class Box { public static class Item { public void save() {} } } }`,
    'b/Child2.java': `package b;
class Child2 extends a.Base2 {
  void run(Box.Item i) { i.save(); }
  void local() { Box.Item i = null; i.save(); }
  class Deep { void deep(Box.Item i) { i.save(); } }
  void take(Box.Item i) {}
  void take(String s) {}
  void pass(Box.Item i) { take(i); }
}`,
    'b/Stranger.java': `package b;
class Stranger { void run(a.Base2.Box.Item i) { i.save(); } }`,
    'pp/PkgBase.java': `package pp;
public class PkgBase { static class Box { public static class Item { public void save() {} } } }`,
    'pq/Box.java': `package pq;
public class Box { public static class Item { public void save() {} } }`,
    'pq/PkgChild.java': `package pq;
class PkgChild extends pp.PkgBase { void run(Box.Item i) { i.save(); } }`,
  });

  it.each([
    ['Method:b/Child2.java:Child2.run#1'],
    ['Method:b/Child2.java:Child2.local#0'],
    ['Method:b/Child2.java:Deep.deep#1'],
  ])('reads the root in %s as the inherited protected member type', (caller) => {
    expect(callTargets(result(), caller, 'save')).toEqual(['Method:a/Base2.java:Item.save#0']);
  });

  it('selects the overload by an argument typed through the protected member type', () => {
    expect(callTargets(result(), 'Method:b/Child2.java:Child2.pass#1', 'take')).toEqual([
      'Method:b/Child2.java:Child2.take#1~Box.Item',
    ]);
  });

  it('reads a root whose package-private member type is not inherited as the same-package type', () => {
    expect(callTargets(result(), 'Method:pq/PkgChild.java:PkgChild.run#1', 'save')).toEqual([
      'Method:pq/Box.java:Item.save#0',
    ]);
  });

  // `Stranger` is not a subclass of `Base2`, so it cannot reach `Base2.Box`.
  it('leaves a protected member type unresolved outside a subclass body', () => {
    expect(result().graph.getNode('Method:b/Stranger.java:Stranger.run#1')).toBeDefined();
    expect(callTargets(result(), 'Method:b/Stranger.java:Stranger.run#1', 'save')).toEqual([]);
  });
});

// JLS 6.4.1 / 8.5: a member type a class inherits is in scope in the whole
// class body and shadows every same-package, same-file and single-type-imported
// type of that name there. A declaration nearer the use site (a member of the
// inheriting class itself, a local class) still wins; an ambiguous inherited
// reading refuses. A private member type, or a package-private one of another
// package, is not inherited at all, so the name reads as it would without it.
// An interface's member types are implicitly public (JLS 9.5).
describe('Java simple type names that an enclosing class inherits as a member type', () => {
  const result = useFixture('java-r6-inherited-simple-name', {
    'g/Base.java': `package g;
public class Base { public static class Nested { public void save() {} } }`,
    'g/IBase.java': `package g;
public interface IBase { public static class Nested { public void save() {} } }`,
    'h/Nested.java': 'package h; public class Nested { public void save() {} }',
    'h2/Nested.java': 'package h2; public class Nested { public void save() {} }',
    'h/Child.java': `package h;
class Child extends g.Base {
  Nested field;
  void plain(Nested n) { n.save(); }
  void local() { Nested n = null; n.save(); }
  void viaField() { field.save(); }
  void array(Nested[] values) { values[0].save(); }
  class Inner { void deep(Nested n) { n.save(); } }
  void take(Nested n) {}
  void take(h.Nested n) {}
  void pass(Nested n) { take(n); }
}`,
    'h/Imported.java': `package h;
import h2.Nested;
class Imported extends g.Base { void viaImport(Nested n) { n.save(); } }`,
    'h/Own.java': `package h;
class Own extends g.Base {
  static class Nested { void save() {} }
  void own(Nested n) { n.save(); }
}`,
    'h/LocalClass.java': `package h;
class LocalClass extends g.Base {
  void run() {
    class Nested { void save() {} }
    Nested n = new Nested();
    n.save();
  }
}`,
    'h/Twice.java': `package h;
class Twice extends g.Base implements g.IBase { void plain(Nested n) { n.save(); } }`,
    'k/SameFile.java': `package k;
class Nested { void save() {} }
class SameFile extends g.Base {
  void plain(Nested n) { n.save(); }
  void take(g.Base.Nested n) {}
  void take(k.Nested n) {}
  void pass(Nested n) { take(n); }
}`,
    'pa/PBase.java': `package pa;
public class PBase { protected static class Nested { public void save() {} } }`,
    'pb/Nested.java': 'package pb; public class Nested { public void save() {} }',
    'pb/PChild.java': `package pb;
class PChild extends pa.PBase { void plain(Nested n) { n.save(); } }`,
    'pp/PkgBase.java': `package pp;
public class PkgBase { static class Nested { public void save() {} } }`,
    'pq/Nested.java': 'package pq; public class Nested { public void save() {} }',
    'pq/PkgChild.java': `package pq;
class PkgChild extends pp.PkgBase {
  void plain(Nested n) { n.save(); }
  void take(Nested n) {}
  void take(String s) {}
  void pass(Nested n) { take(n); }
}`,
    'r/PrivBase.java': `package r;
public class PrivBase { private static class Nested { void save() {} } }`,
    'r/Nested.java': 'package r; public class Nested { public void save() {} }',
    'r/PrivChild.java': `package r;
class PrivChild extends PrivBase { void plain(Nested n) { n.save(); } }`,
    'ia/I.java': `package ia;
public interface I { class Inner { public void save() {} } }`,
    'ib/Inner.java': 'package ib; public class Inner { public void save() {} }',
    'ib/Impl.java': `package ib;
class Impl implements ia.I {
  void plain(Inner i) { i.save(); }
  void qualified(ia.I.Inner i) { i.save(); }
}`,
  });

  it.each([
    ['Method:h/Child.java:Child.plain#1', 'Method:g/Base.java:Nested.save#0'],
    ['Method:h/Child.java:Child.local#0', 'Method:g/Base.java:Nested.save#0'],
    ['Method:h/Child.java:Child.viaField#0', 'Method:g/Base.java:Nested.save#0'],
    ['Method:h/Child.java:Child.array#1', 'Method:g/Base.java:Nested.save#0'],
    ['Method:h/Child.java:Inner.deep#1', 'Method:g/Base.java:Nested.save#0'],
    ['Method:h/Imported.java:Imported.viaImport#1', 'Method:g/Base.java:Nested.save#0'],
    ['Method:k/SameFile.java:SameFile.plain#1', 'Method:g/Base.java:Nested.save#0'],
    ['Method:pb/PChild.java:PChild.plain#1', 'Method:pa/PBase.java:Nested.save#0'],
    ['Method:pq/PkgChild.java:PkgChild.plain#1', 'Method:pq/Nested.java:Nested.save#0'],
    ['Method:r/PrivChild.java:PrivChild.plain#1', 'Method:r/Nested.java:Nested.save#0'],
    ['Method:ib/Impl.java:Impl.plain#1', 'Method:ia/I.java:Inner.save#0'],
    ['Method:ib/Impl.java:Impl.qualified#1', 'Method:ia/I.java:Inner.save#0'],
    ['Method:h/Own.java:Own.own#1', 'Method:h/Own.java:Nested.save#0'],
    [
      'Method:h/LocalClass.java:LocalClass.run#0',
      'Method:h/LocalClass.java:LocalClass$1Nested.save#0',
    ],
  ])('types the receiver in %s as %s', (caller, target) => {
    expect(callTargets(result(), caller, 'save')).toEqual([target]);
  });

  it.each([
    ['Method:h/Child.java:Child.pass#1', 'Method:h/Child.java:Child.take#1~Nested'],
    [
      'Method:k/SameFile.java:SameFile.pass#1',
      'Method:k/SameFile.java:SameFile.take#1~g.Base.Nested',
    ],
    ['Method:pq/PkgChild.java:PkgChild.pass#1', 'Method:pq/PkgChild.java:PkgChild.take#1~Nested'],
  ])('selects the overload in %s by the inherited member type: %s', (caller, target) => {
    expect(callTargets(result(), caller, 'take')).toEqual([target]);
  });

  // `Nested` is inherited from both `Base` and `IBase`: ambiguous (JLS 8.5).
  it('leaves an ambiguous inherited simple name unresolved', () => {
    expect(result().graph.getNode('Method:h/Twice.java:Twice.plain#1')).toBeDefined();
    expect(callTargets(result(), 'Method:h/Twice.java:Twice.plain#1', 'save')).toEqual([]);
  });
});

// JLS 8.5: a member type a class declares hides every inherited member type of
// that name, so a class inherits from each direct supertype only the member
// types visible there. `Builder` in `C extends B` is `B.Builder`, never the
// `A.Builder` that `B.Builder` hides; in `D extends A` it is `A.Builder`. Two
// distinct declarations from different direct supertypes are ambiguous; one
// declaration reached through two interfaces is not.
describe('Java inherited member types hidden by a nearer supertype', () => {
  const members = '{ public void go() {} public static class Part { public void go() {} } }';
  const classBuilder = `public static class Builder ${members}`;
  // An interface's member types are implicitly public and static (JLS 9.5).
  const interfaceBuilder = `class Builder ${members}`;
  const result = useFixture('java-r6-hidden-member-types', {
    'hd/A.java': `package hd;\npublic class A { ${classBuilder} }`,
    'hd/B.java': `package hd;\npublic class B extends A { ${classBuilder} }`,
    'hd/C.java': `package hd;
class C extends B {
  void simple(Builder b) { b.go(); }
  void qualified(Builder.Part p) { p.go(); }
}`,
    'hd/D.java': `package hd;
class D extends A {
  void simple(Builder b) { b.go(); }
  void qualified(Builder.Part p) { p.go(); }
}`,
    'hd/E.java': `package hd;
class E extends C {
  void simple(Builder b) { b.go(); }
  void qualified(Builder.Part p) { p.go(); }
}`,
    'hd/J.java': `package hd;\npublic interface J { ${interfaceBuilder} }`,
    'hd/F.java': `package hd;
class F extends A implements J {
  void simple(Builder b) { b.go(); }
  void qualified(Builder.Part p) { p.go(); }
}`,
    'hd/K.java': `package hd;\npublic interface K { ${interfaceBuilder} }`,
    'hd/K1.java': 'package hd; public interface K1 extends K {}',
    'hd/K2.java': 'package hd; public interface K2 extends K {}',
    'hd/G.java': `package hd;
class G implements K1, K2 {
  void simple(Builder b) { b.go(); }
  void qualified(Builder.Part p) { p.go(); }
}`,
  });

  it.each([
    ['Method:hd/C.java:C.simple#1', 'Method:hd/B.java:Builder.go#0'],
    ['Method:hd/C.java:C.qualified#1', 'Method:hd/B.java:Part.go#0'],
    ['Method:hd/D.java:D.simple#1', 'Method:hd/A.java:Builder.go#0'],
    ['Method:hd/D.java:D.qualified#1', 'Method:hd/A.java:Part.go#0'],
    ['Method:hd/E.java:E.simple#1', 'Method:hd/B.java:Builder.go#0'],
    ['Method:hd/E.java:E.qualified#1', 'Method:hd/B.java:Part.go#0'],
    ['Method:hd/G.java:G.simple#1', 'Method:hd/K.java:Builder.go#0'],
    ['Method:hd/G.java:G.qualified#1', 'Method:hd/K.java:Part.go#0'],
  ])('types the receiver in %s as %s', (caller, target) => {
    expect(callTargets(result(), caller, 'go')).toEqual([target]);
  });

  it.each([['Method:hd/F.java:F.simple#1'], ['Method:hd/F.java:F.qualified#1']])(
    'leaves %s unresolved: Builder is inherited from two direct supertypes',
    (caller) => {
      expect(result().graph.getNode(caller)).toBeDefined();
      expect(callTargets(result(), caller, 'go')).toEqual([]);
    },
  );
});

describe('Java private member types across top-level classes in one file', () => {
  const result = useFixture('java-r2-private-member-type', {
    'Main.java': `
class Outer {
  private static class Hidden { void save() {} }
  static class Shown { void save() {} }
  void inside(Outer.Hidden h) { h.save(); }
  static class Nested { void nested(Outer.Hidden h) { h.save(); } }
}
class Other {
  void outside(Outer.Hidden h) { h.save(); }
  void shown(Outer.Shown h) { h.save(); }
}
class Decoy { void save() {} }
`,
  });

  it.each([
    ['Method:Main.java:Outer.inside#1', 'Method:Main.java:Hidden.save#0'],
    ['Method:Main.java:Nested.nested#1', 'Method:Main.java:Hidden.save#0'],
    ['Method:Main.java:Other.shown#1', 'Method:Main.java:Shown.save#0'],
  ])('%s resolves an accessible member type to %s', (caller, target) => {
    expect(saveTargets(result(), caller)).toEqual([target]);
  });

  // JLS 6.6.1: a private member type is accessible only within the body of
  // its own top-level class, not from another top-level class in the file.
  it('does not resolve a private member type from another top-level class', () => {
    expect(saveTargets(result(), 'Method:Main.java:Other.outside#1')).toEqual([]);
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
    expect(saveTargets(result(), `Method:Main.java:${caller}`)).toEqual([
      `Method:Main.java:${owner}.save#0`,
    ]);
  });

  it.each([['Use.tooFewDims#1'], ['Use.ambiguousNull#1'], ['Use.unknownArgument#2']])(
    'leaves %s unresolved',
    (caller) => {
      expect(result().graph.getNode(`Method:Main.java:${caller}`)).toBeDefined();
      expect(saveTargets(result(), `Method:Main.java:${caller}`)).toEqual([]);
    },
  );
});

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
    expect(saveTargets(result(), `Method:${caller}`)).toEqual(['Method:e/User.java:User.save#0']);
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

  it.each([
    ['f/Prod.java:Prod.callSamePackage#0', 'Method:f/Model.java:Inner.save#0'],
    ['f/Prod.java:Prod.callImported#0', 'Method:g/Outer2.java:Inner.save#0'],
    ['f/Prod.java:Prod.callFullyQualified#0', 'Method:g/Outer2.java:Inner.save#0'],
    ['f/Prod.java:Prod.callGrid#0', 'Method:f/Model.java:Inner.save#0'],
    ['f/Prod.java:Prod.callSimple#0', 'Method:f/Inner.java:Inner.save#0'],
    ['h/Caller.java:Caller.callShared#0', 'Method:f/Model.java:Inner.save#0'],
    ['f/Single.java:Single.run#0', 'Method:f/Single.java:Inner.save#0'],
  ])('types the producer element in %s as the written type: %s', (caller, target) => {
    expect(saveTargets(result(), `Method:${caller}`)).toEqual([target]);
  });

  it('leaves the producer element unresolved when the qualified lookup refuses an ambiguous root', () => {
    expect(saveTargets(result(), 'Method:f/Ambiguous.java:Ambiguous.run#0')).toEqual([]);
  });
});

// A bare field read in a subclass (`inner.save()`, an implicit `this.inner`)
// is typed by the field the class inherits from a base in another file of its
// package. That must not depend on how many files the package holds: the
// package-sibling machinery caps and then skips large packages.
describe('Java fields inherited from a same-package base', () => {
  it.each([
    { label: 'small package', extraSiblings: 0 },
    { label: 'package past the sibling skip', extraSiblings: 501 },
  ])(
    'types a bare inherited field in a $label',
    async ({ extraSiblings }) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-java-inherited-field-'));
      try {
        const files: Record<string, string> = {
          'src/app/Base.java': `package app;
public class Base {
  public static class Inner { public void save() {} }
  protected Inner inner;
  protected Inner shadow;
}
`,
          'src/app/Other.java': `package app;
public class Other { public void save() {} }
`,
          'src/app/Kid.java': `package app;
public class Kid extends Base {
  Other shadow;
  void run() {
    inner.save();
    shadow.save();
  }
}
`,
        };
        for (let i = 0; i < extraSiblings; i++)
          files[`src/app/F${i}.java`] = `package app;\nclass F${i} {}\n`;
        writeFixtureRepo(root, files);
        const result = await runPipelineFromRepo(root, () => {}, {});
        const targets = getRelationships(result, 'CALLS')
          .filter((edge) => edge.rel.sourceId === 'Method:src/app/Kid.java:Kid.run#0')
          .map((edge) => edge.rel.targetId)
          .sort();
        // The class's own `shadow` hides the inherited one.
        expect(targets).toEqual([
          'Method:src/app/Base.java:Inner.save#0',
          'Method:src/app/Other.java:Other.save#0',
        ]);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
    120000,
  );
});

import { describe, expect, it } from 'vitest';
import { getRelationships, useFixture } from './resolvers/helpers.js';
import type { PipelineResult } from '../../src/types/pipeline.js';

const callTargets = (result: PipelineResult, caller: string, name: string): string[] =>
  getRelationships(result, 'CALLS')
    .filter((edge) => edge.rel.sourceId === caller && edge.target === name)
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

// JLS 7.5.3 / 6.4.1: `import static p.Outer.Inner;` imports the static member
// type `Inner`, which shadows a same-package top-level `Inner`, so
// `Inner.Nested` is `p.Outer.Inner.Nested`. A static import of a field or
// method brings in no type; an import whose owner may bring in an unseen
// type, or two imports of the name, refuse.
describe('Java qualified roots named by a single static import', () => {
  const result = useFixture('java-r6-static-single-root', {
    'p/Outer.java': `package p;
public class Outer { public static class Inner { public static class Nested { public void save() {} } } }`,
    'p/Other.java': `package p;
public class Other { public static class Inner { public static class Nested { public void save() {} } } }`,
    'p/Consts.java': 'package p; public class Consts { public static final int Inner = 1; }',
    'p/Derived.java': 'package p; public class Derived extends lib.Base {}',
    'p/Hidden.java': `package p;
public class Hidden { static class Inner { public static class Nested { public void save() {} } } }`,
    'q/Inner.java': `package q;
public class Inner { public static class Nested { public void save() {} } }`,
    'q/Use.java': `package q;
import static p.Outer.Inner;
class Use {
  void run(Inner.Nested n) { n.save(); }
  void local() { Inner.Nested n = null; n.save(); }
  void take(Inner.Nested n) {}
  void take(q.Inner.Nested n) {}
  void pass(Inner.Nested n) { take(n); }
}`,
    'q/ConstUse.java': `package q;
import static p.Consts.Inner;
class ConstUse { void run(Inner.Nested n) { n.save(); } }`,
    'q/ExtUse.java': `package q;
import static lib.Ext.Inner;
class ExtUse { void run(Inner.Nested n) { n.save(); } }`,
    'q/DerivedUse.java': `package q;
import static p.Derived.Inner;
class DerivedUse { void run(Inner.Nested n) { n.save(); } }`,
    'q/HiddenUse.java': `package q;
import static p.Hidden.Inner;
class HiddenUse { void run(Inner.Nested n) { n.save(); } }`,
    'q/TwoUse.java': `package q;
import static p.Outer.Inner;
import static p.Other.Inner;
class TwoUse { void run(Inner.Nested n) { n.save(); } }`,
  });

  it.each([
    ['Method:q/Use.java:Use.run#1', 'Method:p/Outer.java:Nested.save#0'],
    ['Method:q/Use.java:Use.local#0', 'Method:p/Outer.java:Nested.save#0'],
    ['Method:q/ConstUse.java:ConstUse.run#1', 'Method:q/Inner.java:Nested.save#0'],
  ])('types the receiver in %s as %s', (caller, target) => {
    expect(callTargets(result(), caller, 'save')).toEqual([target]);
  });

  it('selects the overload by the statically imported member type', () => {
    expect(callTargets(result(), 'Method:q/Use.java:Use.pass#1', 'take')).toEqual([
      'Method:q/Use.java:Use.take#1~Inner.Nested',
    ]);
  });

  // The owner is outside the workspace, names a supertype outside it, declares
  // the member type package-private in another package, or two static imports
  // name it.
  it.each([
    ['Method:q/ExtUse.java:ExtUse.run#1'],
    ['Method:q/DerivedUse.java:DerivedUse.run#1'],
    ['Method:q/HiddenUse.java:HiddenUse.run#1'],
    ['Method:q/TwoUse.java:TwoUse.run#1'],
  ])('leaves %s unresolved', (caller) => {
    expect(result().graph.getNode(caller)).toBeDefined();
    expect(callTargets(result(), caller, 'save')).toEqual([]);
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

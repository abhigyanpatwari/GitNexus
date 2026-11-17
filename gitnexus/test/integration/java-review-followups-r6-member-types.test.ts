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
// member path of the supertype's `Box`; a package-private `Box` is not
// inherited, and code outside a subclass cannot reach a protected `Box`.
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

  // `Stranger` is not a subclass of `Base2`, and `PkgBase.Box` is
  // package-private in another package: neither reaches the member type.
  it.each([['Method:b/Stranger.java:Stranger.run#1'], ['Method:pq/PkgChild.java:PkgChild.run#1']])(
    'leaves %s unresolved',
    (caller) => {
      expect(result().graph.getNode(caller)).toBeDefined();
      expect(callTargets(result(), caller, 'save')).toEqual([]);
    },
  );
});

// JLS 6.4.1 / 8.5: a member type a class inherits is in scope in the whole
// class body and shadows every same-package, same-file and single-type-imported
// type of that name there. A declaration nearer the use site (a member of the
// inheriting class itself, a local class) still wins; an ambiguous or
// inaccessible inherited reading refuses rather than falling back.
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
class PkgChild extends pp.PkgBase { void plain(Nested n) { n.save(); } }`,
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
  ])('selects the overload in %s by the inherited member type: %s', (caller, target) => {
    expect(callTargets(result(), caller, 'take')).toEqual([target]);
  });

  // `Nested` is inherited from both `Base` and `IBase`: ambiguous (JLS 8.5).
  it('leaves an ambiguous inherited simple name unresolved', () => {
    expect(result().graph.getNode('Method:h/Twice.java:Twice.plain#1')).toBeDefined();
    expect(callTargets(result(), 'Method:h/Twice.java:Twice.plain#1', 'save')).toEqual([]);
  });

  it('never reads a package-private member type of another package as inherited', () => {
    expect(result().graph.getNode('Method:pq/PkgChild.java:PkgChild.plain#1')).toBeDefined();
    expect(callTargets(result(), 'Method:pq/PkgChild.java:PkgChild.plain#1', 'save')).not.toContain(
      'Method:pp/PkgBase.java:Nested.save#0',
    );
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

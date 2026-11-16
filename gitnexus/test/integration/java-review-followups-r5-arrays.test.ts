import { describe, expect, it } from 'vitest';
import { getRelationships, useFixture, type RelEdge } from './resolvers/helpers.js';

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

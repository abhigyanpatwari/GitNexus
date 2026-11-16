import { describe, expect, it } from 'vitest';
import { getRelationships, useFixture } from './resolvers/helpers.js';

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

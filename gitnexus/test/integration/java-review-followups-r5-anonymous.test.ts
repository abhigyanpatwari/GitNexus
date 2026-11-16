import { describe, expect, it } from 'vitest';
import { getRelationships, useFixture } from './resolvers/helpers.js';

describe('Java this inside an anonymous class body', () => {
  const result = useFixture('java-review-followups-r5-anonymous-this', {
    'Main.java': `
class User { void save() {} }
class Other { void save() {} }
abstract class Holder { Other[] inherited() { return null; } abstract void run(); }
abstract class Task { abstract void run(); }
class Sub {
  User[] own() { return null; }
  User[] inherited() { return null; }
  void viaInherited() {
    new Holder() {
      void run() { this.inherited()[0].save(); }
    };
  }
  void viaNested() {
    new Runnable() {
      public void run() {
        new Task() {
          Other[] own() { return null; }
          void run() { this.own()[0].save(); }
        };
      }
    };
  }
}
`,
  });

  const targets = (caller: string, name: string): string[] =>
    getRelationships(result(), 'CALLS')
      .filter((edge) => edge.rel.sourceId === `Method:Main.java:${caller}` && edge.target === name)
      .map((edge) => edge.rel.targetId)
      .sort();

  it('reaches a member the anonymous class inherits, not the enclosing class member', () => {
    expect(targets('Sub$1.run#0', 'inherited')).toEqual(['Method:Main.java:Holder.inherited#0']);
    expect(targets('Sub$1.run#0', 'save')).toEqual(['Method:Main.java:Other.save#0']);
  });

  it('binds this to the innermost anonymous class', () => {
    expect(targets('Sub$2$1.run#0', 'own')).toEqual(['Method:Main.java:Sub$2$1.own#0']);
    expect(targets('Sub$2$1.run#0', 'save')).toEqual(['Method:Main.java:Other.save#0']);
  });
});

describe('Java copy of an enclosing local inside an anonymous class method', () => {
  const result = useFixture('java-review-followups-r5-anonymous-alias', {
    'Main.java': `
import lib.LibraryTask;
class User { void save() {} }
class Other { void save() {} }
class Factory { User make() { return null; } }
abstract class Task { abstract void m(); }
abstract class Sink { abstract void m(Other value); }
abstract class FieldTask { Other value; abstract void m(); }
abstract class DeepTask extends FieldTask {}
class App {
  Factory factory;
  void captured() {
    var value = factory.make();
    new Task() { void m() { var copy = value; copy.save(); } };
  }
  void inLocalClass() {
    var value = factory.make();
    class Local { void m() { var copy = value; copy.save(); } }
  }
  void inheritedField() {
    var value = factory.make();
    new FieldTask() { void m() { var copy = value; copy.save(); } };
  }
  void deepInheritedField() {
    var value = factory.make();
    new DeepTask() { void m() { var copy = value; copy.save(); } };
  }
  void externalSupertype() {
    var value = factory.make();
    new LibraryTask() { public void run() { var copy = value; copy.save(); } };
  }
  void ownField() {
    var value = factory.make();
    new Task() { Other value; void m() { var copy = value; copy.save(); } };
  }
  void parameter() {
    var value = factory.make();
    new Sink() { void m(Other value) { var copy = value; copy.save(); } };
  }
  void writtenAfter() {
    var value = factory.make();
    new Task() { void m() { var copy = value; copy.save(); } };
    value = null;
  }
}
`,
  });

  const saveTargets = (caller: string): string[] =>
    getRelationships(result(), 'CALLS')
      .filter(
        (edge) => edge.rel.sourceId === `Method:Main.java:${caller}` && edge.target === 'save',
      )
      .map((edge) => edge.rel.targetId)
      .sort();

  it.each([['App$1.m#0'], ['App$1Local.m#0']])(
    'types the copy in %s from the enclosing local producer',
    (caller) => {
      expect(saveTargets(caller)).toEqual(['Method:Main.java:User.save#0']);
    },
  );

  it.each([
    ['App$5.m#0', 'a field the anonymous class declares'],
    ['App$6.m#1', 'a parameter'],
  ])('reads the copy in %s through %s, not the enclosing local', (caller) => {
    expect(saveTargets(caller)).toEqual(['Method:Main.java:Other.save#0']);
  });

  it.each([
    ['App$2.m#0', 'a workspace supertype declares a field of that name'],
    ['App$3.m#0', 'an indirect workspace supertype declares a field of that name'],
  ])('never types the copy in %s from the enclosing local when %s', (caller) => {
    expect(result().graph.getNode(`Method:Main.java:${caller}`)).toBeDefined();
    expect(
      saveTargets(caller).filter((target) => target !== 'Method:Main.java:Other.save#0'),
    ).toEqual([]);
  });

  it.each([
    ['App$4.run#0', 'the supertype is outside the workspace and may declare that field'],
    ['App$7.m#0', 'the local is written after its declaration'],
  ])('leaves the copy in %s unresolved when %s', (caller) => {
    expect(result().graph.getNode(`Method:Main.java:${caller}`)).toBeDefined();
    expect(saveTargets(caller)).toEqual([]);
  });
});

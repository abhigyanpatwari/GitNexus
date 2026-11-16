import { describe, expect, it } from 'vitest';
import { getRelationships, useFixture } from './resolvers/helpers.js';

describe('Java switch groups, shadowed writes, initializer receivers and pattern types', () => {
  const result = useFixture('java-review-followups-r2-captures', {
    'Model.java': `package p;
class User { void save() {} int id() { return 0; } }
class Other { void save() {} int id() { return 0; } }
class Repo { Other other() { return null; } User user() { return null; } }
class Decoy { Other[] items() { return null; } }
@interface Ann {}`,
    'Switches.java': `package p;
class Switches {
  Repo repo;
  Switches() { var o = repo.other(); var c = o; c.save(); }
  void unbracedGroup(int k) { var o = repo.other(); switch (k) { case 1: var c = o; c.save(); break; } }
  void producerInGroup(int k) { switch (k) { case 1: var o = repo.other(); var c = o; c.save(); break; } }
  void switchExpressionGroup(int k) {
    var o = repo.other();
    int r = switch (k) { case 1: var c = o; c.save(); yield 1; default: yield 0; };
  }
  void writtenInGroup(int k) { var o = repo.other(); switch (k) { case 1: o = repo.user(); var c = o; c.save(); break; } }
  void writtenInLaterGroup(int k) {
    var o = repo.other();
    switch (k) { case 1: var c = o; c.save(); break; case 2: o = repo.user(); break; }
  }
}`,
    'Shadow.java': `package p;
class Shadow {
  Repo repo;
  void localClassFieldAfterCopy(boolean ready) {
    var x = repo.other();
    if (ready) { var y = x; y.save(); }
    class L { Other x; void f() { x = null; } }
  }
  void localClassFieldBeforeCopy() {
    var x = repo.other();
    class L { Repo x; void f() { x = null; } }
    var y = x;
    y.save();
  }
  void anonymousClassField() {
    var x = repo.other();
    Runnable r = new Runnable() { Repo x; public void run() { x = null; } };
    var y = x;
    y.save();
  }
  void localTypeNamedLikeProducerType() {
    var x = repo.other();
    class Other { void save() {} }
    var y = x;
    y.save();
  }
  void realWrite(boolean ready) {
    var x = repo.other();
    if (ready) { var y = x; y.save(); }
    x = repo.user();
  }
}`,
    'Init.java': `package p;
class FieldInit { int first = items()[0].id(); User[] items() { return null; } }
class BlockInit { { items()[0].save(); } User[] items() { return null; } }
class LambdaFieldInit { Runnable action = () -> items()[0].save(); User[] items() { return null; } }
enum EnumInit { A; int first = items()[0].id(); { items()[0].save(); } User[] items() { return null; } }
class StaticFieldInit { static int first = items()[0].id(); static User[] items() { return null; } }
class StaticBlockInit { static { items()[0].save(); } static User[] items() { return null; } }
interface ConstantInit { int FIRST = items()[0].id(); static User[] items() { return null; } }`,
    'Patterns.java': `package p;
class Patterns {
  void annotated(Object o) { if (o instanceof @Ann User u) { u.save(); } }
  void qualifiedAnnotated(Object o) { if (o instanceof p.@Ann User u) { u.save(); } }
}`,
  });
  const targets = (source: string, member: string) =>
    getRelationships(result(), 'CALLS')
      .filter((edge) => edge.rel.sourceId.startsWith(source) && edge.target === member)
      .map((edge) => edge.rel.targetId)
      .sort();

  it.each([
    'Constructor:Switches.java:Switches.Switches#',
    'Method:Switches.java:Switches.unbracedGroup#',
    'Method:Switches.java:Switches.producerInGroup#',
    'Method:Switches.java:Switches.switchExpressionGroup#',
  ])('keeps a var copy made in an unbraced switch group or constructor: %s', (caller) => {
    expect(targets(caller, 'save')).toEqual(['Method:Model.java:Other.save#0']);
  });

  it.each([
    'Method:Switches.java:Switches.writtenInGroup#',
    'Method:Switches.java:Switches.writtenInLaterGroup#',
  ])('refuses a switch-group copy of a source written in the switch: %s', (caller) => {
    expect(targets(caller, 'save')).toEqual([]);
  });

  it.each([
    'Method:Shadow.java:Shadow.localClassFieldAfterCopy#',
    'Method:Shadow.java:Shadow.localClassFieldBeforeCopy#',
    'Method:Shadow.java:Shadow.anonymousClassField#',
  ])('does not treat a same-named field write as a write to the outer local: %s', (caller) => {
    expect(targets(caller, 'save')).toEqual(['Method:Model.java:Other.save#0']);
  });

  it('types a copy after a local type by the producer, not by the local type', () => {
    expect(targets('Method:Shadow.java:Shadow.localTypeNamedLikeProducerType#', 'save')).toEqual([
      'Method:Model.java:Other.save#0',
    ]);
  });

  it('still refuses a nested copy when the outer local itself is written', () => {
    expect(targets('Method:Shadow.java:Shadow.realWrite#', 'save')).toEqual([]);
  });

  it.each([
    ['Class:Init.java:FieldInit', 'id', 'Method:Model.java:User.id#0'],
    ['Class:Init.java:BlockInit', 'save', 'Method:Model.java:User.save#0'],
    ['Class:Init.java:LambdaFieldInit', 'save', 'Method:Model.java:User.save#0'],
    ['Enum:Init.java:EnumInit', 'id', 'Method:Model.java:User.id#0'],
    ['Enum:Init.java:EnumInit', 'save', 'Method:Model.java:User.save#0'],
  ])('reads an implicit this array receiver in %s initializers (%s)', (caller, member, target) => {
    expect(targets(caller, member)).toEqual([target]);
  });

  it.each([
    ['Class:Init.java:StaticFieldInit', 'id'],
    ['Class:Init.java:StaticBlockInit', 'save'],
    ['Interface:Init.java:ConstantInit', 'id'],
  ])('refuses an implicit this array receiver in static %s initializers (%s)', (caller, member) => {
    expect(targets(caller, member)).toEqual([]);
  });

  it.each(['annotated', 'qualifiedAnnotated'])(
    'binds an annotated instanceof pattern to its type without the annotation: %s',
    (caller) => {
      expect(targets(`Method:Patterns.java:Patterns.${caller}#`, 'save')).toEqual([
        'Method:Model.java:User.save#0',
      ]);
    },
  );
});

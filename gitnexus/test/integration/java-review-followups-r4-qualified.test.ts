import { describe, expect, it } from 'vitest';
import { getRelationships, useFixture } from './resolvers/helpers.js';
import type { PipelineResult } from '../../src/types/pipeline.js';

const callTargets = (result: PipelineResult, caller: string, name: string): string[] =>
  getRelationships(result, 'CALLS')
    .filter((edge) => edge.rel.sourceId === caller && edge.target === name)
    .map((edge) => edge.rel.targetId)
    .sort();

// JLS 7.5.4: `import static lib.Outer.*;` imports every accessible static
// member type of `Outer`, inherited ones included. With `Outer` outside the
// workspace, `Inner` may be such a type, which shadows the package `Inner`
// (JLS 6.5.2), so `Inner.User` cannot be read as the workspace package type.
describe('Java qualified roots under a static on-demand import', () => {
  const result = useFixture('java-r4-static-on-demand-root', {
    'Inner/User.java': 'package Inner; public class User { public void save() {} }',
    'Inner/Other.java': 'package Inner; public class Other { public void save() {} }',
    'app/Static.java': `package app;
import static lib.Outer.*;
class Static {
  void param(Inner.User x) { x.save(); }
  void local() { Inner.User x = null; x.save(); }
}`,
    'app/Control.java': `package app;
class Control {
  void param(Inner.User x) { x.save(); }
  void local() { Inner.User x = null; x.save(); }
}`,
    'app/Consts.java': 'package app; public class Consts { public static final int LIMIT = 1; }',
    'app/Known.java': `package app;
import static app.Consts.*;
class Known { void param(Inner.User x) { x.save(); } }`,
    'app/Derived.java': 'package app; public class Derived extends lib.Base {}',
    'app/ViaDerived.java': `package app;
import static app.Derived.*;
class ViaDerived { void param(Inner.User x) { x.save(); } }`,
    'side/Sink.java': `package side;
public class Sink {
  public void take(Inner.User u) {}
  public void take(Inner.Other u) {}
}`,
    'side/Static.java': `package side;
import static lib.Outer.*;
class Static { void pass(Sink s, Inner.User x) { s.take(x); } }`,
    'side/Control.java': `package side;
class Control { void pass(Sink s, Inner.User x) { s.take(x); } }`,
  });

  it.each([
    ['Method:app/Static.java:Static.param#1'],
    ['Method:app/Static.java:Static.local#0'],
    ['Method:app/ViaDerived.java:ViaDerived.param#1'],
  ])('refuses the package reading in %s', (caller) => {
    expect(result().graph.getNode(caller)).toBeDefined();
    expect(callTargets(result(), caller, 'save')).toEqual([]);
  });

  it.each([
    ['Method:app/Control.java:Control.param#1'],
    ['Method:app/Control.java:Control.local#0'],
    ['Method:app/Known.java:Known.param#1'],
  ])('keeps the package reading in %s', (caller) => {
    expect(callTargets(result(), caller, 'save')).toEqual(['Method:Inner/User.java:User.save#0']);
  });

  it('does not select an overload from an argument typed through that root', () => {
    expect(result().graph.getNode('Method:side/Static.java:Static.pass#2')).toBeDefined();
    expect(callTargets(result(), 'Method:side/Static.java:Static.pass#2', 'take')).toEqual([]);
  });

  it('selects the package-typed overload without the static import', () => {
    expect(callTargets(result(), 'Method:side/Control.java:Control.pass#2', 'take')).toEqual([
      'Method:side/Sink.java:Sink.take#1~Inner.User',
    ]);
  });
});

// JLS 6.4.1 / 8.5: a member type an enclosing class inherits shadows the
// package of that name in the class body, so `models.User` there is the
// supertype's member type. Readings that cannot be proven stay unresolved.
describe('Java qualified roots that an enclosing class inherits as a member type', () => {
  const result = useFixture('java-r4-inherited-member-root', {
    'models/User.java': 'package models; public class User { public void save() {} }',
    'models/Other.java': 'package models; public class Other { public void save() {} }',
    'app/Base.java': `package app;
public class Base { public static class models { public static class User { public void save() {} } } }`,
    'app/Outer.java': `package app;
class Outer extends Base {
  void direct(models.User u) { u.save(); }
  class Plain2 { void nearPlain(models.User u) { u.save(); } }
  class Inner extends lib.Lib { void nearExt(models.User u) { u.save(); } }
}`,
    'app/ExtSub.java': `package app;
class ExtSub extends lib.Base { void viaExt(models.User u) { u.save(); } }`,
    'app/I1.java': `package app;
public interface I1 { class models { public static class User { public void save() {} } } }`,
    'app/Iface.java': `package app;
class Iface implements I1 { void viaIface(models.User u) { u.save(); } }`,
    'app/Two.java': `package app;
class Two extends Base implements I1 { void two(models.User u) { u.save(); } }`,
    'app/Mid.java': `package app;
public class Mid extends Base { public static class models { public static class User { public void save() {} } } }`,
    'app/Hidden.java': `package app;
class Hidden extends Mid { void hidden(models.User u) { u.save(); } }`,
    'app/PrivBase.java': `package app;
public class PrivBase { private static class models { static class User { void save() {} } } }`,
    'app/PrivSub.java': `package app;
class PrivSub extends PrivBase { void priv(models.User u) { u.save(); } }`,
    'other/PkgBase.java': `package other;
public class PkgBase { static class models { static class User { void save() {} } } }`,
    'app/PkgSub.java': `package app;
class PkgSub extends other.PkgBase { void pkg(models.User u) { u.save(); } }`,
    'app/Sink.java': `package app;
public class Sink {
  public void take(app.Base.models.User u) {}
  public void take(models.User u) {}
}`,
    'app/Sub.java': `package app;
class Sub extends Base { void pass(Sink s, models.User u) { s.take(u); } }`,
    'app/Plain.java': `package app;
class Plain { void pass(Sink s, models.User u) { s.take(u); } }`,
  });

  it.each([
    ['Method:app/Outer.java:Outer.direct#1', 'Method:app/Base.java:User.save#0'],
    ['Method:app/Outer.java:Plain2.nearPlain#1', 'Method:app/Base.java:User.save#0'],
    ['Method:app/Iface.java:Iface.viaIface#1', 'Method:app/I1.java:User.save#0'],
  ])('reads the root in %s as the inherited member type %s', (caller, target) => {
    expect(callTargets(result(), caller, 'save')).toEqual([target]);
  });

  // A nearer class or supertype outside the workspace may supply another
  // `models`, and two inherited `models` make the name ambiguous.
  it.each([
    ['Method:app/Outer.java:Inner.nearExt#1'],
    ['Method:app/ExtSub.java:ExtSub.viaExt#1'],
    ['Method:app/Two.java:Two.two#1'],
  ])('leaves %s unresolved', (caller) => {
    expect(result().graph.getNode(caller)).toBeDefined();
    expect(callTargets(result(), caller, 'save')).toEqual([]);
  });

  // `Mid.models` hides `Base.models`; private and other-package
  // package-private member types are not inherited at all.
  it.each([
    ['Method:app/Hidden.java:Hidden.hidden#1', 'Method:app/Base.java:User.save#0'],
    ['Method:app/Hidden.java:Hidden.hidden#1', 'Method:models/User.java:User.save#0'],
    ['Method:app/PrivSub.java:PrivSub.priv#1', 'Method:app/PrivBase.java:User.save#0'],
    ['Method:app/PkgSub.java:PkgSub.pkg#1', 'Method:other/PkgBase.java:User.save#0'],
  ])('never binds %s to %s', (caller, wrong) => {
    expect(result().graph.getNode(caller)).toBeDefined();
    expect(callTargets(result(), caller, 'save')).not.toContain(wrong);
  });

  it.each([
    ['Method:app/Sub.java:Sub.pass#2', 'Method:app/Sink.java:Sink.take#1~app.Base.models.User'],
    ['Method:app/Plain.java:Plain.pass#2', 'Method:app/Sink.java:Sink.take#1~models.User'],
  ])('selects the overload in %s by the same reading: %s', (caller, target) => {
    expect(callTargets(result(), caller, 'take')).toEqual([target]);
  });
});

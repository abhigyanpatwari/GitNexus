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
} from './resolvers/helpers.js';
import type { PipelineResult } from '../../src/types/pipeline.js';

// Java qualified and annotated type spellings: qualified roots, shadowing, static
// imports, container element proofs, and try-with-resources bindings.

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

describe('Java qualified and annotated receiver bindings', () => {
  const result = useFixture('java-qualified-bindings', {
    'models/User.java': `package models; public class User<T> { public void save() {} }`,
    'other/User.java': `package other; public class User { public void save() {} }`,
    'app/Main.java': `package app;
import other.User;
@java.lang.annotation.Target(java.lang.annotation.ElementType.TYPE_USE) @interface Mark {}
class App {
  models.User field;
  models.User getUser() { return field; }
  void parameter(models.User user) { user.save(); }
  void local() { models.User user = null; user.save(); }
  void field() { this.field.save(); }
  void returned() { getUser().save(); }
  void constructor() { var user = new models.User(); user.save(); }
  void genericConstructor() { var user = new models.User<>(); user.save(); }
  void annotatedConstructor() { var user = new models.@Mark User<>(); user.save(); }
  void alias(models.User user) { var copy = user; copy.save(); }
  void annotated(models.@Mark User user) { user.save(); }
  void annotatedArray(models.User @Mark [] users) { users[0].save(); }
  void qualifiedArray(models.User[] users) { users[0].save(); }
  void unresolved() { missing.User user = null; user.save(); }
}
`,
  });
  const targets = (caller: string) =>
    getRelationships(result(), 'CALLS')
      .filter((edge) => edge.source === caller && edge.target === 'save')
      .map((edge) => edge.rel.targetId)
      .sort();
  it.each([
    'parameter',
    'local',
    'field',
    'returned',
    'constructor',
    'genericConstructor',
    'annotatedConstructor',
    'alias',
    'annotated',
    'annotatedArray',
    'qualifiedArray',
  ])('%s retains the qualified owner despite a competing import', (caller) => {
    expect(targets(caller)).toEqual(['Method:models/User.java:User.save#0']);
  });
  it('does not replace an unresolved qualified type with an imported simple name', () => {
    expect(targets('unresolved')).toEqual([]);
  });
});

describe('Java qualified type root shadowed by a same-package type', () => {
  const result = useFixture('java-qualified-type-root-shadow', {
    'prefix/User.java': 'package prefix; public class User { public void save() {} }',
    'p/prefix.java': `package p; public class prefix {
  public static class User { public void save() {} }
}`,
    'p/App.java': `package p; public class App {
  void run(prefix.User value) { value.save(); }
}`,
  });

  // `prefix.User` names the member type `p.prefix.User`: the root `prefix` is a
  // class in scope from the same package, so it is read as a type and never as
  // the package `prefix` (JLS 6.5.4.1), even though that package has a `User`.
  it('reads a visible same-package type qualifier as a type, not as an unrelated package', () => {
    const targets = getRelationships(result(), 'CALLS')
      .filter(
        (edge) => edge.rel.sourceId === 'Method:p/App.java:App.run#1' && edge.target === 'save',
      )
      .map((edge) => edge.rel.targetId);
    expect(targets).not.toContain('Method:prefix/User.java:User.save#0');
    expect(targets).toEqual(['Method:p/prefix.java:User.save#0']);
  });
});

describe('Java try-with-resources bindings', () => {
  it('binds resources through the try body without leaking into handlers or later statements', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-java-resource-ownership-'));
    try {
      writeFixtureRepo(root, {
        'Main.java': `class Resource implements AutoCloseable {
  public void close() {}
  void inside() {} void caught() {} void finalized() {} void after() {} void save() {}
  Resource next() { return new Resource(); }
}
class Field {
  void inside() {} void caught() {} void finalized() {} void after() {} void save() {}
  Resource next() { return new Resource(); }
}
class App {
  Field r;
  Resource open() { return new Resource(); }
  void boundaries() {
    try (Resource r = open()) { r.inside(); }
    catch (Exception e) { r.caught(); }
    finally { r.finalized(); }
    r.after();
  }
  void constructed() { try (var r = new Resource()) { r.save(); } }
  void selectedCall() { try (var r = open()) { r.save(); } }
  void successive() { try (Resource r = open(); var q = r.next()) { q.save(); } }
  void existing(Resource r) { try (r) { r.save(); } r.after(); }
  void invalidSelfRead() { try (Resource r = r.next()) { } }
}
`,
      });
      const result = await runPipelineFromRepo(root, () => {}, {});
      const targets = (caller: string, member: string) =>
        getRelationships(result, 'CALLS')
          .filter(
            (edge) =>
              edge.rel.sourceId ===
                `Method:Main.java:App.${caller}#${caller === 'existing' ? 1 : 0}` &&
              edge.target === member,
          )
          .map((edge) => edge.rel.targetId)
          .sort();
      expect(targets('boundaries', 'inside')).toEqual(['Method:Main.java:Resource.inside#0']);
      for (const member of ['caught', 'finalized', 'after']) {
        expect(targets('boundaries', member)).toEqual([`Method:Main.java:Field.${member}#0`]);
      }
      for (const caller of ['constructed', 'selectedCall', 'successive', 'existing']) {
        expect(targets(caller, 'save')).toEqual(['Method:Main.java:Resource.save#0']);
      }
      expect(targets('existing', 'after')).toEqual(['Method:Main.java:Resource.after#0']);
      // Definite assignment is outside ingestion's contract; the self-read
      // belongs to the new local, typed `Resource`, and must never reconnect the
      // enclosing field.
      expect(targets('invalidSelfRead', 'next')).toEqual(['Method:Main.java:Resource.next#0']);
      expect(targets('successive', 'next')).toEqual(['Method:Main.java:Resource.next#0']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 120000);
});

describe('Java qualified member-type spellings', () => {
  const result = useFixture('java-review-followups-nested-fqn', {
    'models/Outer.java': `package models;
public class Outer {
  public static class Inner { public void run() {} }
  public interface Face { void run(); }
}`,
    'models/Other.java': 'package models; public class Other { public void run() {} }',
    'app/App.java': `package app;
class App {
  void parameter(models.Outer.Inner value) { value.run(); }
  void local() { models.Outer.Inner value = null; value.run(); }
  void member(models.Outer.Face value) { value.run(); }
}`,
    'Same.java': `class Uniq { static class Solo { void run() {} } }
class Other2 { void run() {} }
class SameFile { void q4(Uniq.Solo value) { value.run(); } }`,
  });

  it.each([
    ['parameter', 'Method:app/App.java:App.parameter#1', 'Method:models/Outer.java:Inner.run#0'],
    ['local', 'Method:app/App.java:App.local#0', 'Method:models/Outer.java:Inner.run#0'],
    ['member', 'Method:app/App.java:App.member#1', 'Method:models/Outer.java:Face.run#0'],
    ['same-file', 'Method:Same.java:SameFile.q4#1', 'Method:Same.java:Solo.run#0'],
  ])('resolves a %s receiver typed by a nested type FQN', (_label, caller, target) => {
    expect(callTargets(result(), caller, 'run')).toEqual([target]);
  });

  it.each([
    ['Method:app/App.java:App.parameter#1', 'Method:models/Other.java:Other.run#0'],
    ['Method:Same.java:SameFile.q4#1', 'Method:Same.java:Other2.run#0'],
  ])('never binds %s to the unrelated owner %s', (caller, wrong) => {
    expect(callTargets(result(), caller, 'run')).not.toContain(wrong);
  });
});

describe('Java qualified spellings are judged per reference', () => {
  const result = useFixture('java-review-followups-per-reference', {
    'models/User.java': 'package models; public class User { public void save() {} }',
    'models/Other.java': 'package models; public class Other { public void save() {} }',
    'app/App.java': `package app;
import models.User;
class App {
  void good(models.User u) { u.save(); }
  static class Nested {
    static class models { static class User { void save() {} } }
    void unrelated(models.User u) { u.save(); }
  }
}`,
  });

  it('resolves the package-qualified reference outside the shadowing type', () => {
    expect(callTargets(result(), 'Method:app/App.java:App.good#1', 'save')).toEqual([
      'Method:models/User.java:User.save#0',
    ]);
  });

  it('resolves the shadowed reference to the member type, never to the package type', () => {
    expect(callTargets(result(), 'Method:app/App.java:Nested.unrelated#1', 'save')).toEqual([
      'Method:app/App.java:User.save#0',
    ]);
  });
});

describe('Java qualified spellings under an inherited member type', () => {
  const result = useFixture('java-review-followups-inherited-root', {
    'models/User.java': 'package models; public class User { public void save() {} }',
    'models/Other.java': 'package models; public class Other { public void save() {} }',
    'app/App.java': `package app;
class Base { static class models { static class User { void save() {} } } }
class Sub extends Base { void inherited(models.User u) { u.save(); } }
class Plain { void unrelated(models.User u) { u.save(); } }`,
  });

  // JLS 6.4.1 / 8.5: `Sub` inherits the accessible member type `Base.models`,
  // which shadows the package `models` in its body.
  it('reads a root a subclass inherits as a member type as that member type', () => {
    expect(callTargets(result(), 'Method:app/App.java:Sub.inherited#1', 'save')).toEqual([
      'Method:app/App.java:User.save#0',
    ]);
  });

  it('keeps the package reading where no enclosing type inherits the member', () => {
    expect(callTargets(result(), 'Method:app/App.java:Plain.unrelated#1', 'save')).toEqual([
      'Method:models/User.java:User.save#0',
    ]);
  });
});

describe('Java qualified type roots that name a type from another file', () => {
  const nested = 'public class prefix { public static class User { public void save() {} } }';
  const result = useFixture('java-r2-qualified-root', {
    'prefix/User.java': 'package prefix; public class User { public void save() {} }',
    'q/prefix.java': `package q; ${nested}`,
    'r/prefix.java': `package r; ${nested}`,
    's/OnDemand.java': `package s;
import q.*;
public class OnDemand { void run(prefix.User value) { value.save(); } }`,
    's/Single.java': `package s;
import r.prefix;
public class Single { void run(prefix.User value) { value.save(); } }`,
    's/Ambiguous.java': `package s;
import q.*;
import r.*;
public class Ambiguous { void run(prefix.User value) { value.save(); } }`,
    's/Plain.java': `package s;
public class Plain { void run(prefix.User value) { value.save(); } }`,
    'p/prefix.java': `package p; ${nested}`,
    'p/Routes.java': `package p;
public class Routes {
  prefix.User field;
  prefix.User make() { return null; }
  void viaField() { field.save(); }
  void viaThis() { this.field.save(); }
  void viaLocal() { prefix.User local = make(); local.save(); }
}`,
    'p/Base.java': `package p;
public class Base { public static class prefix { public static class User { public void save() {} } } }`,
    'p/Inherits.java': `package p;
public class Inherits extends Base { void run(prefix.User value) { value.save(); } }`,
  });

  it.each([
    ['Method:s/OnDemand.java:OnDemand.run#1', 'Method:q/prefix.java:User.save#0'],
    ['Method:s/Single.java:Single.run#1', 'Method:r/prefix.java:User.save#0'],
    ['Method:p/Routes.java:Routes.viaField#0', 'Method:p/prefix.java:User.save#0'],
    ['Method:p/Routes.java:Routes.viaThis#0', 'Method:p/prefix.java:User.save#0'],
    ['Method:p/Routes.java:Routes.viaLocal#0', 'Method:p/prefix.java:User.save#0'],
  ])('%s reads the imported or same-package root as a type: %s', (caller, target) => {
    expect(saveTargets(result(), caller)).not.toContain('Method:prefix/User.java:User.save#0');
    expect(saveTargets(result(), caller)).toEqual([target]);
  });

  it('keeps reading an unclaimed root as a package', () => {
    expect(saveTargets(result(), 'Method:s/Plain.java:Plain.run#1')).toEqual([
      'Method:prefix/User.java:User.save#0',
    ]);
  });

  // Two on-demand imports both supply `prefix`: the root is ambiguous and may
  // not fall back to a package.
  it('refuses an ambiguous root', () => {
    expect(saveTargets(result(), 'Method:s/Ambiguous.java:Ambiguous.run#1')).toEqual([]);
  });

  // The inherited member type `Base.prefix` shadows the same-package `prefix`
  // and the package `prefix` (JLS 6.4.1).
  it('reads an inherited member root as that member type', () => {
    expect(saveTargets(result(), 'Method:p/Inherits.java:Inherits.run#1')).toEqual([
      'Method:p/Base.java:User.save#0',
    ]);
  });
});

describe('Java JDK container elements in a package past the sibling injection cap', () => {
  // More than 200 files in one package truncates same-package sibling
  // injection. Each package is its own workspace, as in a real repository.
  const count = 205;
  const workspace = (field: string, imports: string, extra: Record<string, string>) => ({
    'p/Base.java': 'package p; public class Base {}',
    'p/User.java': 'package p; public class User { public void save() {} }',
    'p/Other.java': 'package p; public class Other { public void save() {} }',
    ...extra,
    ...Object.fromEntries(
      Array.from({ length: count }, (_, index) => [
        `p/K${index}.java`,
        `package p;
${imports}
class K${index} extends Base {
  ${field} items;
  void runEach() { items.forEach(u -> u.save()); }
  void runFor() { for (var u : items) u.save(); }
}`,
      ]),
    ),
  });
  const results = {
    demand: useFixture('java-r2-large-demand', workspace('List<User>', 'import java.util.*;', {})),
    raw: useFixture('java-r2-large-raw', workspace('java.util.List<User>', '', {})),
    shadow: useFixture(
      'java-r2-large-shadow',
      workspace('List<User>', 'import java.util.*;', {
        'p/List.java': 'package p; public class List<T> {}',
      }),
    ),
  };
  // Java keeps one CALLS edge per caller and target, so each element route
  // gets its own method: one method holding both calls would still show one
  // `User.save` target when either route alone resolves.
  const targets = (name: keyof typeof results, method: 'runEach' | 'runFor'): string[][] =>
    Array.from({ length: count }, (_, index) =>
      saveTargets(results[name](), `Method:p/K${index}.java:K${index}.${method}#0`),
    );

  it.each([
    ['demand', 'runEach'],
    ['demand', 'runFor'],
    ['raw', 'runEach'],
    ['raw', 'runFor'],
  ] as const)(
    'every %s member types its element through the JDK List identity in %s',
    (name, method) => {
      expect(targets(name, method)).toEqual(
        Array.from({ length: count }, () => ['Method:p/User.java:User.save#0']),
      );
    },
  );

  it.each(['runEach', 'runFor'] as const)(
    'still refuses an on-demand List shadowed by a same-package class in %s',
    (method) => {
      expect(targets('shadow', method)).toEqual(Array.from({ length: count }, () => []));
    },
  );
});

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
      expect(saveTargets(result(), caller)).toEqual(['Method:app/Base.java:User.save#0']);
    },
  );

  it('still reads the root as a package where no member type is inherited', () => {
    expect(saveTargets(result(), 'Method:app/Plain.java:Plain.run#1')).toEqual([
      'Method:models/User.java:User.save#0',
    ]);
  });
});

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
    'side/WithMath.java': `package side;
import static java.lang.Math.*;
class WithMath {
  void take(java.lang.String value) {}
  void take(java.lang.Integer value) {}
  void pass(java.lang.String value) { take(value); }
  void param(Inner.User u) { u.save(); }
}`,
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

  it('keeps qualified workspace and JDK types beside the Math static import', () => {
    expect(callTargets(result(), 'Method:side/WithMath.java:WithMath.param#1', 'save')).toEqual([
      'Method:Inner/User.java:User.save#0',
    ]);
    expect(callTargets(result(), 'Method:side/WithMath.java:WithMath.pass#1', 'take')).toEqual([
      'Method:side/WithMath.java:WithMath.take#1~java.lang.String',
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
    'app/Root.java': `package app;
public class Root { public static class Item { public void save() {} } }`,
    'lib/Imported.java': `package lib;
public class Imported { public static class Item { public void save() {} } }`,
    'app/Unknown.java': `package app;
import lib.Imported;
class Unknown extends missing.Parent {
  void samePackage(Root.Item x) { x.save(); }
  void imported(Imported.Item x) { x.save(); }
  void pick(Root.Item x) {}
  void pick(Imported.Item x) {}
  void pass(Root.Item x) { pick(x); }
}
class ThroughUnknown extends Unknown { void indirect(Root.Item x) { x.save(); } }
class Complete {
  void imported(Imported.Item x) { x.save(); }
  void nested() {
    class Local { void local(Imported.Item x) { x.save(); } }
    new Root() { void anonymous(Imported.Item x) { x.save(); } };
    class Unseen extends missing.Parent { void unknown(Imported.Item x) { x.save(); } }
  }
}`,
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
    ['Method:app/Unknown.java:Unknown.samePackage#1'],
    ['Method:app/Unknown.java:Unknown.imported#1'],
    ['Method:app/Unknown.java:ThroughUnknown.indirect#1'],
    ['Method:app/Unknown.java:Complete$1Unseen.unknown#1'],
  ])('leaves %s unresolved', (caller) => {
    expect(result().graph.getNode(caller)).toBeDefined();
    expect(callTargets(result(), caller, 'save')).toEqual([]);
  });

  it('uses the imported root with a complete hierarchy and refuses an overload behind an unseen base', () => {
    for (const caller of ['Complete.imported', 'Complete$1Local.local', 'Complete$1.anonymous'])
      expect(callTargets(result(), `Method:app/Unknown.java:${caller}#1`, 'save')).toEqual([
        'Method:lib/Imported.java:Item.save#0',
      ]);
    expect(result().graph.getNode('Method:app/Unknown.java:Unknown.pass#1')).toBeDefined();
    expect(callTargets(result(), 'Method:app/Unknown.java:Unknown.pass#1', 'pick')).toEqual([]);
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

// JLS 6.5.4.1 / 6.5.5.2: in a type, the qualifier of `models.User` is a
// PackageOrTypeName, so only types and packages compete for `models`. A
// field, parameter or local named `models` never obscures it (JLS 6.4.2 is
// about expression names), while a type named `models` still shadows it.
describe('Java qualified type roots named like a variable in scope', () => {
  const result = useFixture('java-r4-variable-named-root', {
    'models/User.java': 'package models; public class User { public void save() {} }',
    'models/Other.java': 'package models; public class Other { public void save() {} }',
    'app/Params.java': `package app;
class Params {
  void param(models.User models, models.User u) { u.save(); }
  void local() { int models = 0; models.User u = null; u.save(); }
}`,
    'app/Field.java': `package app;
class Field {
  String models;
  void viaParam(models.User u) { u.save(); }
  void viaLocal() { models.User u = null; u.save(); }
}`,
    'app/Both.java': `package app;
class Both {
  String models;
  static class models { static class User { void save() {} } }
  void run(models.User u) { u.save(); }
}`,
    'app/LocalClass.java': `package app;
class LocalClass {
  void shadow() {
    class models { class User { void save() {} } }
    models.User u = null;
    u.save();
  }
}`,
    'cb/UserCb.java': 'package cb; public interface UserCb { void accept(models.User u); }',
    'cb/OtherCb.java': 'package cb; public interface OtherCb { void accept(models.Other u); }',
    'app/Handler.java': `package app;
class Handler {
  void accept(cb.UserCb cb) {}
  void use(Handler h) { h.accept(x -> x.save()); }
}`,
    'app/Sink.java': `package app;
public class Sink {
  public void take(models.User models) {}
  public void take(models.Other models) {}
}`,
    'app/Pass.java': `package app;
class Pass {
  void pass(Sink s, models.User models) { s.take(models); }
  void passOther(Sink s, models.Other models) { s.take(models); }
}`,
    'app/Expr.java': `package app;
class Expr { void call(cb.UserCb cb, models.User u) { cb.accept(u); } }`,
  });

  it.each([
    ['Method:app/Params.java:Params.param#2'],
    ['Method:app/Params.java:Params.local#0'],
    ['Method:app/Field.java:Field.viaParam#1'],
    ['Method:app/Field.java:Field.viaLocal#0'],
  ])('reads the root in %s as the package despite a variable of that name', (caller) => {
    expect(callTargets(result(), caller, 'save')).toEqual(['Method:models/User.java:User.save#0']);
  });

  it('types a lambda parameter through a qualified type next to a parameter of the root name', () => {
    expect(callTargets(result(), 'Method:app/Handler.java:Handler.use#1', 'save')).toEqual([
      'Method:models/User.java:User.save#0',
    ]);
  });

  it('reads the root as the member type where a field and a member type share the name', () => {
    expect(callTargets(result(), 'Method:app/Both.java:Both.run#1', 'save')).toEqual([
      'Method:app/Both.java:User.save#0',
    ]);
  });

  it('never reads a root a local class shadows as the package', () => {
    expect(result().graph.getNode('Method:app/LocalClass.java:LocalClass.shadow#0')).toBeDefined();
    expect(
      callTargets(result(), 'Method:app/LocalClass.java:LocalClass.shadow#0', 'save'),
    ).not.toContain('Method:models/User.java:User.save#0');
  });

  it.each([
    ['Method:app/Pass.java:Pass.pass#2', 'Method:app/Sink.java:Sink.take#1~models.User'],
    ['Method:app/Pass.java:Pass.passOther#2', 'Method:app/Sink.java:Sink.take#1~models.Other'],
  ])('selects the overload in %s by the parameter type: %s', (caller, target) => {
    expect(callTargets(result(), caller, 'take')).toEqual([target]);
  });

  it('keeps a receiver expression of the root name bound to the variable', () => {
    expect(callTargets(result(), 'Method:app/Expr.java:Expr.call#2', 'accept')).toEqual([
      'Method:cb/UserCb.java:UserCb.accept#1',
    ]);
  });
});

// A `var` element taken from a JDK container is kept only if the container's
// name means the JDK type where it was written. That name is written in a
// type, so a variable named `java` or `List` never gives it another meaning;
// a type of that name (a local class, a same-package type) still does.
describe('Java container element proofs next to a variable named like the proof root', () => {
  const result = useFixture('java-r4-variable-named-proof-root', {
    'models/User.java': 'package models; public class User { public void save() {} }',
    'models/Other.java': 'package models; public class Other { public void save() {} }',
    'app/ParamRoot.java': `package app;
import models.User;
class ParamRoot { void run(String java, java.util.List<User> users) { for (var u : users) u.save(); } }`,
    'app/FieldRoot.java': `package app;
import models.User;
class FieldRoot {
  String java;
  void run(java.util.List<User> users) { for (var u : users) u.save(); }
}`,
    'app/LocalRoot.java': `package app;
import models.User;
class LocalRoot {
  java.util.List<User> make() { return null; }
  void run() { int java = 0; java.util.List<User> users = make(); for (var u : users) u.save(); }
}`,
    'app/OnDemandVar.java': `package app;
import java.util.*;
import models.User;
class OnDemandVar { void run(String List, List<User> users) { for (var u : users) u.save(); } }`,
    'app/LocalClassList.java': `package app;
import java.util.*;
import models.User;
import models.Other;
class LocalClassList {
  void run() {
    class List<T> implements Iterable<Other> { public Iterator<Other> iterator() { return null; } }
    List<User> users = new List<>();
    for (var u : users) u.save();
  }
}`,
    'sib/List.java': `package sib;
public class List<T> implements Iterable<models.Other> {
  public java.util.Iterator<models.Other> iterator() { return null; }
}`,
    'sib/SiblingList.java': `package sib;
import java.util.*;
import models.User;
class SiblingList { void run(String List, List<User> users) { for (var u : users) u.save(); } }`,
  });

  it.each([
    ['Method:app/ParamRoot.java:ParamRoot.run#2'],
    ['Method:app/FieldRoot.java:FieldRoot.run#1'],
    ['Method:app/LocalRoot.java:LocalRoot.run#0'],
    ['Method:app/OnDemandVar.java:OnDemandVar.run#2'],
  ])('keeps the JDK container element in %s', (caller) => {
    expect(callTargets(result(), caller, 'save')).toEqual(['Method:models/User.java:User.save#0']);
  });

  it.each([
    ['Method:app/LocalClassList.java:LocalClassList.run#0'],
    ['Method:sib/SiblingList.java:SiblingList.run#2'],
  ])('never reads %s through the JDK container a type of that name shadows', (caller) => {
    expect(result().graph.getNode(caller)).toBeDefined();
    expect(callTargets(result(), caller, 'save')).not.toContain(
      'Method:models/User.java:User.save#0',
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

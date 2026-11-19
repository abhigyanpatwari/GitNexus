// JDK container element inference: callbacks, loops, call-result elements,
// large packages, and container identity behind shadowed package roots.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PipelineResult } from '../../src/types/pipeline.js';
import {
  getRelationships,
  runPipelineFromRepo,
  useFixture,
  writeFixtureRepo,
  type RelEdge,
} from './resolvers/helpers.js';

describe('Java contextual element declaration identity', () => {
  const result = useFixture('java-contextual-declaration-identity', {
    'a/User.java': 'package a; public class User { public void save() {} }',
    'Outer.java': `import java.util.List;
import a.User;
class Outer {
  List<User> users;
  void direct() { users.forEach(x -> x.save()); }
  class Inner {
    static class User { void save() {} }
    void callback() { users.forEach(x -> x.save()); }
    void loop() { for (var x : users) x.save(); }
  }
}`,
  });
  const targets = (caller: string) =>
    getRelationships(result(), 'CALLS')
      .filter(
        (edge) => edge.rel.sourceId === `Method:Outer.java:${caller}#0` && edge.target === 'save',
      )
      .map((edge) => edge.rel.targetId);

  it('retains ordinary imported element inference', () => {
    expect(targets('Outer.direct')).toEqual(['Method:a/User.java:User.save#0']);
  });
  it.each(['callback', 'loop'])(
    'never rebinds an outer container argument inside Inner.%s',
    (caller) => {
      expect(targets(`Inner.${caller}`)).toEqual(['Method:a/User.java:User.save#0']);
    },
  );
});

describe('Java raw JDK inference with local element declarations', () => {
  const result = useFixture('java-contextual-local-element-identity', {
    'decoy/User.java': 'package decoy; public class User { public void save() {} }',
    'Outer.java': `import decoy.User;
class Outer {
  void callback() {
    class User { void save() {} }
    java.util.List<User> users = null;
    users.forEach(x -> x.save());
  }
  void loop() {
    class User { void save() {} }
    java.util.List<User> users = null;
    for (var x : users) x.save();
  }
}`,
  });
  // A local class is in scope for the rest of its block (JLS 6.3): it, not the
  // imported decoy, is the element type the raw `java.util.List` proves.
  it.each([
    ['callback', 'Method:Outer.java:Outer$1User.save#0'],
    ['loop', 'Method:Outer.java:Outer$2User.save#0'],
  ])('resolves the local User, not the imported decoy, in %s', (caller, local) => {
    expect(
      getRelationships(result(), 'CALLS')
        .filter(
          (edge) =>
            edge.rel.sourceId === `Method:Outer.java:Outer.${caller}#0` && edge.target === 'save',
        )
        .map((edge) => edge.rel.targetId),
    ).toEqual([local]);
  });
});

describe('Java contextual JDK element receivers', () => {
  it('infers element receivers only at proven JDK callbacks and iteration operations', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-java-contextual-elements-'));
    try {
      writeFixtureRepo(root, {
        'Main.java': `import java.util.List;
import java.util.Map;
import java.util.stream.Stream;
class User { void save() {} void audit() {} }
class Key { void save() {} }
class App {
  User x;
  void list(List<User> users) { users.forEach(x -> x.save()); }
  void stream(Stream<User> users) { users.forEachOrdered(x -> x.save()); }
  void map(Map<Key, User> users) { users.forEach((key, value) -> { key.save(); value.save(); }); }
  void array(User[] users) { for (var user : users) { user.save(); } }
  void iterable(List<User> users) { for (var user : users) user.save(); }
  void mapValues(Map<Key, User> users) { for (var user : users.values()) user.save(); }
  void mapKeys(Map<Key, User> users) { for (var key : users.keySet()) key.save(); }
  void typedLoop(List<Key> users) { for (Key x : users) x.save(); x.audit(); }
  void raw(List users) { users.forEach(x -> x.save()); }
  void wildcard(List<? extends User> users) { users.forEach(x -> x.save()); }
  <T> void generic(List<T> users) { users.forEach(x -> x.save()); }
  void changing(Stream<User> users) { users.map(x -> x).forEach(x -> x.save()); }
  void unrelated(List<User> users) { users.arbitrary(x -> x.save()); }
  void containerAlias(List<User> users) { var copy = users; copy.save(); }
}
`,
        'Lookalike.java': `class List<T> { void forEach(Object callback) {} }
class Map<K,V> { Object values() { return null; } }
class FakeUser { void save() {} }
class Lookalike {
  FakeUser x;
  void custom(List<FakeUser> users) { users.forEach(x -> x.save()); }
  void customMap(Map<String,FakeUser> users) { for (var x : users.values()) x.save(); }
}
`,
      });
      const result = await runPipelineFromRepo(root, () => {}, {});
      const targets = (owner: string, caller: string, member: string, file = 'Main.java') =>
        getRelationships(result, 'CALLS')
          .filter(
            (edge) =>
              edge.rel.sourceId === `Method:${file}:${owner}.${caller}#1` && edge.target === member,
          )
          .map((edge) => edge.rel.targetId)
          .sort();
      for (const caller of ['list', 'stream', 'array', 'iterable', 'mapValues']) {
        expect(targets('App', caller, 'save')).toEqual(['Method:Main.java:User.save#0']);
      }
      expect(targets('App', 'typedLoop', 'save')).toEqual(['Method:Main.java:Key.save#0']);
      expect(targets('App', 'mapKeys', 'save')).toEqual(['Method:Main.java:Key.save#0']);
      expect(targets('App', 'typedLoop', 'audit')).toEqual(['Method:Main.java:User.audit#0']);
      expect(targets('App', 'map', 'save')).toEqual([
        'Method:Main.java:Key.save#0',
        'Method:Main.java:User.save#0',
      ]);
      for (const caller of [
        'raw',
        'wildcard',
        'generic',
        'changing',
        'unrelated',
        'containerAlias',
      ]) {
        expect(targets('App', caller, 'save')).toEqual([]);
      }
      expect(targets('Lookalike', 'custom', 'save', 'Lookalike.java')).toEqual([]);
      expect(targets('Lookalike', 'customMap', 'save', 'Lookalike.java')).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 120000);
});

// Every fixture has two `save` owners, so a missing proof cannot pass by luck.
const OWNERS = {
  'app/User.java': 'package app; public class User { public void save() {} }',
  'app/Other.java': 'package app; public class Other { public void save() {} }',
};
const USER = 'Method:app/User.java:User.save#0';
const OTHER = 'Method:app/Other.java:Other.save#0';
const LIB_ITEM = 'Method:lib/Item.java:Item.save#0';

function saveTargets(result: PipelineResult, caller: string): string[] {
  return getRelationships(result, 'CALLS')
    .filter((edge) => edge.rel.sourceId === caller && edge.target === 'save')
    .map((edge) => edge.rel.targetId)
    .sort();
}

// `var xs = producer(); for (var x : xs)`: the loop variable is typed only from
// the exactly selected producer's own declared JDK container return type, read
// where that return type was written.
describe('Java var loops over a selected method result', () => {
  const result = useFixture('java-followup-call-result-elements', {
    ...OWNERS,
    'lib/Item.java': 'package lib; public class Item { public void save() {} }',
    'other/Item.java': 'package other; public class Item { public void save() {} }',
    'app/Repo.java': `package app;
import java.util.List;
import java.util.Map;
public class Repo {
  public List<User> findAll() { return null; }
  public Map<String, User> byId() { return null; }
  public Map<User, Other> byUser() { return null; }
}`,
    'app/Catalog.java': `package app;
import java.util.List;
import lib.Item;
public class Catalog { public List<Item> items() { return null; } }`,
    'app/Generic.java': `package app;
import java.util.List;
public class Generic {
  public <User> List<User> shadowed() { return null; }
  public <T> List<T> generic() { return null; }
}`,
    'app/Overloads.java': `package app;
import java.util.List;
public class Overloads {
  public List<User> load(String key) { return null; }
  public List<Other> load(Integer key) { return null; }
}`,
    'app/Svc.java': `package app;
import java.util.List;
import other.Item;
public class Svc {
  private Repo repo;
  private Catalog catalog;
  private Generic generic;
  private Overloads overloads;
  List<User> all() { return null; }
  void sameClass() { var xs = all(); for (var x : xs) x.save(); }
  void crossFile() { var xs = repo.findAll(); for (var x : xs) x.save(); }
  void mapValues() { var m = repo.byId(); for (var u : m.values()) u.save(); }
  void mapKeys() { var m = repo.byUser(); for (var k : m.keySet()) k.save(); }
  void copied() { var xs = repo.findAll(); var ys = xs; for (var y : ys) y.save(); }
  void producerImport() { var xs = catalog.items(); for (var x : xs) x.save(); }
  void typeParameter() { var xs = generic.shadowed(); for (var x : xs) x.save(); }
  void methodTypeVariable() { var xs = generic.<User>generic(); for (var x : xs) x.save(); }
  void exactOverload() { var xs = overloads.load("a"); for (var x : xs) x.save(); }
  void unknownOverload(external.Key key) {
    var xs = overloads.load(key.value());
    for (var x : xs) x.save();
  }
}`,
    // A same-package type shadows a type-import-on-demand (JLS 6.4.1, 7.5.2).
    'shadow/List.java': 'package shadow; public class List<T> {}',
    'shadow/Repo.java': `package shadow;
import java.util.*;
import app.User;
public class Repo { public List<User> findAll() { return null; } }`,
    'shadow/Svc.java': `package shadow;
public class Svc {
  private Repo repo;
  void run() { var xs = repo.findAll(); for (var x : xs) x.save(); }
}`,
  });

  it.each<[string, string, string[]]>([
    ['same-class producer', 'Method:app/Svc.java:Svc.sameClass#0', [USER]],
    ['cross-file producer', 'Method:app/Svc.java:Svc.crossFile#0', [USER]],
    ['Map values()', 'Method:app/Svc.java:Svc.mapValues#0', [USER]],
    ['Map keySet()', 'Method:app/Svc.java:Svc.mapKeys#0', [USER]],
    ['a copied result', 'Method:app/Svc.java:Svc.copied#0', [USER]],
    ['the exactly selected overload', 'Method:app/Svc.java:Svc.exactOverload#0', [USER]],
  ])('%s types the loop variable from the declared return', (_label, caller, expected) => {
    expect(saveTargets(result(), caller)).toEqual(expected);
  });

  it("reads the element in the producer's import environment, not the caller's", () => {
    expect(saveTargets(result(), 'Method:app/Svc.java:Svc.producerImport#0')).toEqual([LIB_ITEM]);
  });

  it.each<[string, string]>([
    ['a same-package List over java.util.*', 'Method:shadow/Svc.java:Svc.run#0'],
    ['a method type parameter named User', 'Method:app/Svc.java:Svc.typeParameter#0'],
    ['a method type variable element', 'Method:app/Svc.java:Svc.methodTypeVariable#0'],
    ['overloads that cannot be selected', 'Method:app/Svc.java:Svc.unknownOverload#1'],
  ])('%s leaves the loop variable unbound', (_label, caller) => {
    expect(saveTargets(result(), caller)).toEqual([]);
  });

  it('keeps the selected overloads and producers as call targets', () => {
    const targets = getRelationships(result(), 'CALLS')
      .filter((edge) => edge.rel.sourceId === 'Method:app/Svc.java:Svc.exactOverload#0')
      .map((edge) => edge.rel.targetId)
      .sort();
    expect(targets).toEqual(['Method:app/Overloads.java:Overloads.load#1~String', USER]);
    expect(saveTargets(result(), 'Method:app/Svc.java:Svc.crossFile#0')).not.toContain(OTHER);
  });
});

const USER_SAVE = 'Method:models/User.java:User.save#0';
const MEMBER_SAVE = 'Method:app/models.java:User.save#0';
const MODELS_CLASS =
  'package app;\npublic class models {\n  public static class User { public void save() {} }\n}\n';

/**
 * One package member per shape: the JDK `List` through `import java.util.*`
 * or spelled `java.util.List`, each with and without a same-package base.
 */
const SHAPES = [
  {
    name: 'on-demand List with a same-package base',
    imports: 'import java.util.*;\n',
    list: 'List',
    base: ' extends Base',
  },
  {
    name: 'java.util.List with a same-package base',
    imports: '',
    list: 'java.util.List',
    base: ' extends Base',
  },
  {
    name: 'on-demand List without a base',
    imports: 'import java.util.*;\n',
    list: 'List',
    base: '',
  },
  { name: 'java.util.List without a base', imports: '', list: 'java.util.List', base: '' },
] as const;
const ON_DEMAND_SHAPES = [0, 2] as const;
const RAW_SHAPES = [1, 3] as const;

/** `User` comes in through a single-type import; `models.User` is written out. */
type Element = 'User' | 'models.User';

const member = (index: number, element: Element): string => {
  const shape = SHAPES[index % SHAPES.length]!;
  const userImport = element === 'User' ? 'import models.User;\n' : '';
  return `package app;
${shape.imports}${userImport}public class K${index}${shape.base} {
  ${shape.list}<${element}> items;
  models.User one;
  void viaLambda() { items.forEach(u -> u.save()); }
  void viaLoop() { for (var u : items) u.save(); }
  void viaField() { one.save(); }
}
`;
};

/**
 * `count` members in package `app`, plus two `save` owners in `models`:
 * `Other.save` is a decoy no call may reach.
 */
const largePackage = (
  count: number,
  element: Element,
  extra: Readonly<Record<string, string>>,
): Record<string, string> => ({
  'models/User.java': 'package models;\npublic class User { public void save() {} }\n',
  'models/Other.java': 'package models;\npublic class Other { public void save() {} }\n',
  'app/Base.java': 'package app;\npublic class Base {}\n',
  ...extra,
  ...Object.fromEntries(
    Array.from({ length: count }, (_, index) => [`app/K${index}.java`, member(index, element)]),
  ),
});

interface MemberTargets {
  readonly lambda: readonly string[];
  readonly loop: readonly string[];
  readonly field: readonly string[];
}

/** `save` targets of each member of `shape`, by call site. */
const targetsOf = (result: PipelineResult, count: number, shape: number): MemberTargets[] => {
  const from = (caller: string): string[] => saveTargets(result, caller);
  return Array.from({ length: count }, (_, index) => index)
    .filter((index) => index % SHAPES.length === shape)
    .map((index) => ({
      lambda: from(`Method:app/K${index}.java:K${index}.viaLambda#0`),
      loop: from(`Method:app/K${index}.java:K${index}.viaLoop#0`),
      field: from(`Method:app/K${index}.java:K${index}.viaField#0`),
    }));
};

const membersOf = (count: number, shape: number): number =>
  Array.from({ length: count }, (_, index) => index).filter(
    (index) => index % SHAPES.length === shape,
  ).length;

const every = (count: number, shape: number, targets: MemberTargets): MemberTargets[] =>
  Array.from({ length: membersOf(count, shape) }, () => targets);

const RESOLVED: MemberTargets = { lambda: [USER_SAVE], loop: [USER_SAVE], field: [USER_SAVE] };
const FIELD_ONLY: MemberTargets = { lambda: [], loop: [], field: [USER_SAVE] };
const MEMBER_TARGETS: MemberTargets = {
  lambda: [MEMBER_SAVE],
  loop: [MEMBER_SAVE],
  field: [MEMBER_SAVE],
};
const IMPORTED_WITH_MEMBER_FIELD: MemberTargets = {
  lambda: [USER_SAVE],
  loop: [USER_SAVE],
  field: [MEMBER_SAVE],
};

// 205 members pass the 200-sibling injection cap; 505 pass the 500-file limit
// past which a package gets no sibling injection at all. Either way every
// member's same-package visibility is incomplete, which must only refuse a
// name that a same-package type could actually claim.
describe.each([205, 505])('Java JDK container elements in a package of %i members', (count) => {
  const imported = useFixture(`java-large-${count}-imported`, largePackage(count, 'User', {}));
  const listShadowed = useFixture(
    `java-large-${count}-list-shadow`,
    largePackage(count, 'User', { 'app/List.java': 'package app;\npublic class List<T> {}\n' }),
  );
  // JLS 6.5.4.1: a same-package type named `models` makes the written
  // `models.User` its member type, never the `models` package's `User`.
  const rootShadowed = useFixture(
    `java-large-${count}-root-shadow`,
    largePackage(count, 'models.User', { 'app/models.java': MODELS_CLASS }),
  );
  // JLS 7.5.1, 6.3: `import models.User` names the `models` package's type; a
  // same-package type is not in scope in an import. Only the written
  // `models.User` field names the member of the same-package class.
  const importShadowed = useFixture(
    `java-large-${count}-import-shadow`,
    largePackage(count, 'User', { 'app/models.java': MODELS_CLASS }),
  );

  it.each(SHAPES.map((shape, index) => [shape.name, index] as const))(
    'types every %s element as the single-type-imported User',
    (_name, shape) => {
      expect(targetsOf(imported(), count, shape)).toEqual(every(count, shape, RESOLVED));
    },
  );

  it.each(ON_DEMAND_SHAPES.map((shape) => [SHAPES[shape].name, shape] as const))(
    'refuses every %s element when a same-package List shadows the on-demand import',
    (_name, shape) => {
      expect(targetsOf(listShadowed(), count, shape)).toEqual(every(count, shape, FIELD_ONLY));
    },
  );

  it.each(RAW_SHAPES.map((shape) => [SHAPES[shape].name, shape] as const))(
    'still types every %s element beside a same-package List',
    (_name, shape) => {
      expect(targetsOf(listShadowed(), count, shape)).toEqual(every(count, shape, RESOLVED));
    },
  );

  it.each(SHAPES.map((shape, index) => [shape.name, index] as const))(
    'binds the written models.User to the same-package member type for every %s member',
    (_name, shape) => {
      expect(targetsOf(rootShadowed(), count, shape)).toEqual(every(count, shape, MEMBER_TARGETS));
    },
  );

  it.each(SHAPES.map((shape, index) => [shape.name, index] as const))(
    'binds every %s element through its import beside a same-package class named models',
    (_name, shape) => {
      expect(targetsOf(importShadowed(), count, shape)).toEqual(
        every(count, shape, IMPORTED_WITH_MEMBER_FIELD),
      );
    },
  );
});

// An element written as a simple name that `import models.User` brings in is
// the `models` package's `User` wherever it is read (JLS 7.5.1: an import
// names a canonical name, and a same-package type is not in scope there,
// JLS 6.3). A same-package class `models` must not capture it. The written
// `models.User` is different: the class `models` is in scope there, so the
// name is its member type (JLS 6.5.4.1, 6.5.5.2).
describe('Java element types named through a single-type import beside a same-package class models', () => {
  const result = useFixture('java-import-root-shadow', {
    'models/User.java': 'package models;\npublic class User { public void save() {} }\n',
    'models/Other.java': 'package models;\npublic class Other { public void save() {} }\n',
    'app/models.java': MODELS_CLASS,
    'app/OnDemand.java': `package app;
import java.util.*;
import models.User;
public class OnDemand {
  List<User> items;
  void viaLambda() { items.forEach(u -> u.save()); }
  void viaLoop() { for (var u : items) u.save(); }
}
`,
    'app/Raw.java': `package app;
import models.User;
public class Raw {
  java.util.List<User> items;
  void viaLambda() { items.forEach(u -> u.save()); }
  void viaLoop() { for (var u : items) u.save(); }
}
`,
    'app/Written.java': `package app;
import java.util.*;
public class Written {
  List<models.User> items;
  void viaLambda() { items.forEach(u -> u.save()); }
  void viaLoop() { for (var u : items) u.save(); }
}
`,
    'app/Repo.java': `package app;
import java.util.*;
import models.User;
public class Repo {
  public List<User> all() { return null; }
  public Map<String, User> byName() { return null; }
  public Map<models.User, User> both() { return null; }
}
`,
    'app/Caller.java': `package app;
public class Caller {
  Repo repo;
  void viaReturn() { var xs = repo.all(); for (var u : xs) u.save(); }
  void viaValues() { var m = repo.byName(); for (var u : m.values()) u.save(); }
  void bothKeys() { var b = repo.both(); for (var k : b.keySet()) k.save(); }
  void bothValues() { var b = repo.both(); for (var v : b.values()) v.save(); }
}
`,
    'inh/Base.java': `package inh;
public class Base {
  public static class User { public void save() {} }
}
`,
    'inh/Sub.java': `package inh;
import java.util.*;
import models.User;
public class Sub extends Base {
  List<User> items;
  void viaLambda() { items.forEach(u -> u.save()); }
  void viaLoop() { for (var u : items) u.save(); }
}
`,
  });

  it.each([
    ['Method:app/OnDemand.java:OnDemand.viaLambda#0'],
    ['Method:app/OnDemand.java:OnDemand.viaLoop#0'],
    ['Method:app/Raw.java:Raw.viaLambda#0'],
    ['Method:app/Raw.java:Raw.viaLoop#0'],
    ['Method:app/Caller.java:Caller.viaReturn#0'],
    ['Method:app/Caller.java:Caller.viaValues#0'],
  ])('%s calls the imported models.User, never the member type of class models', (caller) => {
    expect(saveTargets(result(), caller)).toEqual([USER_SAVE]);
  });

  it.each([
    ['Method:app/Written.java:Written.viaLambda#0'],
    ['Method:app/Written.java:Written.viaLoop#0'],
  ])('%s reads the written models.User as the member type of class models', (caller) => {
    expect(saveTargets(result(), caller)).toEqual([MEMBER_SAVE]);
  });

  // One return type spells `models.User` both as written (the member type)
  // and through the import, and both are read at that type: neither is taken.
  it.each([
    ['Method:app/Caller.java:Caller.bothKeys#0'],
    ['Method:app/Caller.java:Caller.bothValues#0'],
  ])('%s leaves an element it cannot tell apart unresolved', (caller) => {
    expect(saveTargets(result(), caller)).toEqual([]);
  });

  // JLS 6.4.1: an inherited member type `User` shadows the single-type import
  // in the subclass body, so the element is not the imported `User`.
  it.each([['Method:inh/Sub.java:Sub.viaLambda#0'], ['Method:inh/Sub.java:Sub.viaLoop#0']])(
    '%s does not take the import past an inherited member type User',
    (caller) => {
      expect(saveTargets(result(), caller)).toEqual([]);
    },
  );
});

/**
 * `values.forEach(value -> value.save())` where `values` is written as a JDK
 * container but a workspace type gives that spelling another meaning. Capture
 * reads the spelling as the JDK container and types the lambda parameter by its
 * element, behind a proof that resolution refutes. The refuted lambda then takes
 * its parameter type from the selected `forEach` itself: the single abstract
 * method of the functional interface that `forEach` declares, a JDK
 * `java.util.function` one or a workspace one (JLS 15.27.3). Where the JDK
 * container reading stands, that element type is kept.
 */
describe('Java lambda parameters behind a refuted JDK container reading', () => {
  const result = useFixture('java-r6-shadow-root', {
    // In package `shadow`, the simple name `java` is the class `shadow.java`;
    // a type obscures a package (JLS 6.4.2), so `java.util.List` is the member
    // type `shadow.java.util.List`, never the JDK interface.
    'shadow/ShadowItem.java': 'package shadow; public class ShadowItem { public void save() {} }',
    'shadow/ShadowOther.java': 'package shadow; public class ShadowOther { public void save() {} }',
    'shadow/ShadowCallback.java':
      'package shadow; public interface ShadowCallback<T> { void accept(T value); }',
    // An import names its type from the package root (JLS 7.5.1), so this
    // `Consumer` is the JDK interface even inside package `shadow`.
    'shadow/java.java': `package shadow; import java.util.function.Consumer;
public class java {
  public static class util {
    public static class List<T> {
      public void forEach(Consumer<ShadowOther> callback) {}
    }
    public static class Set<T> {
      public void forEach(ShadowCallback<ShadowOther> callback) {}
    }
  }
}`,
    'shadow/ShadowProbe.java': `package shadow;
class ShadowProbe {
  ShadowItem value;
  void raw(java.util.List<ShadowItem> values) { values.forEach(value -> value.save()); }
  void callback(java.util.Set<ShadowItem> values) { values.forEach(value -> value.save()); }
}`,
    // A same-package type shadows a type-import-on-demand (JLS 6.4.1).
    'ondemand/Item.java': 'package ondemand; public class Item { public void save() {} }',
    'ondemand/Other.java': 'package ondemand; public class Other { public void save() {} }',
    'ondemand/Callback.java':
      'package ondemand; public interface Callback<T> { void accept(T value); }',
    'ondemand/List.java': `package ondemand;
public class List<T> { public void forEach(Callback<Other> callback) {} }`,
    'ondemand/Use.java': `package ondemand;
import java.util.*;
class Use {
  void run(List<Item> values) { values.forEach(value -> value.save()); }
}`,
    // The JDK reading stands: the lambda parameter is the container element.
    'jdk/Item.java': 'package jdk; public class Item { public void save() {} }',
    'jdk/Use.java': `package jdk;
import java.util.List;
class Use {
  void imported(List<Item> values) { values.forEach(value -> value.save()); }
  void raw(java.util.List<Item> values) { values.forEach(value -> value.save()); }
}`,
    // A lambda in an anonymous class body reads an enclosing local through a
    // supertype that declares no such field (JLS 6.4.1).
    'anon/Item.java': 'package anon; public class Item { public void save() {} }',
    'anon/Other.java': 'package anon; public class Other { public void save() {} }',
    'anon/Callback.java': 'package anon; public interface Callback<T> { void accept(T value); }',
    'anon/Box.java': `package anon;
public class Box<T> { public void forEach(Callback<Other> callback) {} }`,
    'anon/Base.java': 'package anon; public class Base {}',
    'anon/Use.java': `package anon;
class Use {
  void run(Box<Item> values) {
    new Base() { void go() { values.forEach(value -> value.save()); } };
  }
}`,
  });

  const saveTargets = (caller: string): string[] =>
    getRelationships(result(), 'CALLS')
      .filter((edge: RelEdge) => edge.rel.sourceId === caller && edge.target === 'save')
      .map((edge) => edge.rel.targetId)
      .sort();

  it.each([
    [
      'a shadowed java root with a JDK Consumer',
      'Method:shadow/ShadowProbe.java:ShadowProbe.raw#1',
      'Method:shadow/ShadowOther.java:ShadowOther.save#0',
    ],
    [
      'a shadowed java root with a workspace callback',
      'Method:shadow/ShadowProbe.java:ShadowProbe.callback#1',
      'Method:shadow/ShadowOther.java:ShadowOther.save#0',
    ],
    [
      'a same-package type over an on-demand import',
      'Method:ondemand/Use.java:Use.run#1',
      'Method:ondemand/Other.java:Other.save#0',
    ],
    [
      'an enclosing local no supertype field hides',
      'Method:anon/Use.java:Use$1.go#0',
      'Method:anon/Other.java:Other.save#0',
    ],
  ])('types the lambda by the workspace forEach behind %s', (_shape, caller, target) => {
    expect(saveTargets(caller)).toEqual([target]);
  });

  it.each([
    ['Use.imported#1', 'Method:jdk/Item.java:Item.save#0'],
    ['Use.raw#1', 'Method:jdk/Item.java:Item.save#0'],
  ])('keeps the JDK element type for %s', (method, target) => {
    expect(saveTargets(`Method:jdk/Use.java:${method}`)).toEqual([target]);
  });
});

describe('Java callback container identity with a shadowed package root', () => {
  const result = useFixture('java-callback-qualified-lookalike', {
    'p/User.java': 'package p; public class User { public void save() {} }',
    'p/Other.java': `package p; import java.util.function.Consumer;
public class Other { public void save() {} public void forEach(Consumer<Other> callback) {} }`,
    'p/java.java': `package p;
import java.util.function.Consumer;
import java.util.function.BiConsumer;
import java.util.Iterator;
import java.util.Collection;
import java.util.Collections;
public class java {
  public static class util {
    public static class List<T> implements Iterable<Other> {
      public void forEach(Consumer<? super Other> callback) {}
      public Iterator<Other> iterator() { return Collections.emptyIterator(); }
    }
    public static class Map<K,V> {
      public Collection<Other> values() { return Collections.emptyList(); }
      public void forEach(BiConsumer<Other,Other> callback) {}
    }
  }
}`,
    'p/App.java': `package p; import java.util.List;
public class App {
  void run(java.util.List<User> values) { values.forEach(value -> value.save()); }
  void alias(java.util.List<User> values) { values.forEach(value -> { var copy = value; copy.save(); }); }
  void nested(java.util.List<List<User>> values) { values.forEach(value -> value.forEach(inner -> inner.save())); }
  void iterate(java.util.List<User> values) { for (var value : values) value.save(); }
  void mapValues(java.util.Map<String,User> values) { for (var value : values.values()) value.save(); }
  void mapCallback(java.util.Map<String,User> values) { values.forEach((key, value) -> value.save()); }
  void imported(List<User> values) { values.forEach(value -> value.save()); }
}`,
    'ok/User.java': 'package ok; public class User { public void save() {} }',
    'ok/App.java': `package ok; public class App {
  void run(java.util.List<User> values) { values.forEach(value -> value.save()); }
}`,
  });

  it.each(['run', 'alias', 'nested', 'iterate', 'mapValues', 'mapCallback'])(
    'does not infer a JDK element from a shadowed package root in %s',
    (caller) => {
      const targets = getRelationships(result(), 'CALLS')
        .filter(
          (edge) =>
            edge.rel.sourceId === `Method:p/App.java:App.${caller}#1` && edge.target === 'save',
        )
        .map((edge) => edge.rel.targetId);
      expect(targets).not.toContain('Method:p/User.java:User.save#0');
    },
  );

  it.each([
    ['p/App.java', 'App.imported#1', 'p/User.java'],
    ['ok/App.java', 'App.run#1', 'ok/User.java'],
  ])('retains proven JDK inference for %s:%s', (file, caller, targetFile) => {
    const targets = getRelationships(result(), 'CALLS')
      .filter((edge) => edge.rel.sourceId === `Method:${file}:${caller}` && edge.target === 'save')
      .map((edge) => edge.rel.targetId);
    expect(targets).toEqual([`Method:${targetFile}:User.save#0`]);
  });
});

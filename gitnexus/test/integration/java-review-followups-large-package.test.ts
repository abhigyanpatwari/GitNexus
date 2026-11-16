import { describe, expect, it } from 'vitest';
import { getRelationships, useFixture } from './resolvers/helpers.js';
import type { PipelineResult } from '../../src/types/pipeline.js';

const USER_SAVE = 'Method:models/User.java:User.save#0';
const MEMBER_SAVE = 'Method:app/models.java:User.save#0';
const MODELS_CLASS =
  'package app;\npublic class models {\n  public static class User { public void save() {} }\n}\n';

/** Sorted `save` targets called from `caller`. */
const saveTargets = (result: PipelineResult, caller: string): string[] =>
  getRelationships(result, 'CALLS')
    .filter((edge) => edge.rel.sourceId === caller && edge.target === 'save')
    .map((edge) => edge.rel.targetId)
    .sort();

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
const NONE: MemberTargets = { lambda: [], loop: [], field: [] };
const ELEMENTS_ONLY: MemberTargets = { lambda: [USER_SAVE], loop: [USER_SAVE], field: [] };

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
  // `models.User` field may mean the class `models`, and visibility of that
  // class is incomplete here, so it stays unresolved.
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
    'never reads a written models.User as the package type in every %s member when a same-package type is named models',
    (_name, shape) => {
      expect(targetsOf(rootShadowed(), count, shape)).toEqual(every(count, shape, NONE));
    },
  );

  it.each(SHAPES.map((shape, index) => [shape.name, index] as const))(
    'binds every %s element through its import beside a same-package class named models',
    (_name, shape) => {
      expect(targetsOf(importShadowed(), count, shape)).toEqual(every(count, shape, ELEMENTS_ONLY));
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

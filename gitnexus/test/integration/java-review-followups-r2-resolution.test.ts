import { describe, expect, it } from 'vitest';
import { getRelationships, useFixture, type RelEdge } from './resolvers/helpers.js';
import type { PipelineResult } from '../../src/types/pipeline.js';

const saveTargets = (result: PipelineResult, caller: string): string[] =>
  getRelationships(result, 'CALLS')
    .filter((edge: RelEdge) => edge.rel.sourceId === caller && edge.target === 'save')
    .map((edge) => edge.rel.targetId)
    .sort();

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

describe('Java private member types across top-level classes in one file', () => {
  const result = useFixture('java-r2-private-member-type', {
    'Main.java': `
class Outer {
  private static class Hidden { void save() {} }
  static class Shown { void save() {} }
  void inside(Outer.Hidden h) { h.save(); }
  static class Nested { void nested(Outer.Hidden h) { h.save(); } }
}
class Other {
  void outside(Outer.Hidden h) { h.save(); }
  void shown(Outer.Shown h) { h.save(); }
}
class Decoy { void save() {} }
`,
  });

  it.each([
    ['Method:Main.java:Outer.inside#1', 'Method:Main.java:Hidden.save#0'],
    ['Method:Main.java:Nested.nested#1', 'Method:Main.java:Hidden.save#0'],
    ['Method:Main.java:Other.shown#1', 'Method:Main.java:Shown.save#0'],
  ])('%s resolves an accessible member type to %s', (caller, target) => {
    expect(saveTargets(result(), caller)).toEqual([target]);
  });

  // JLS 6.6.1: a private member type is accessible only within the body of
  // its own top-level class, not from another top-level class in the file.
  it('does not resolve a private member type from another top-level class', () => {
    expect(saveTargets(result(), 'Method:Main.java:Other.outside#1')).toEqual([]);
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

import { describe, expect, it } from 'vitest';
import { getRelationships, useFixture } from './resolvers/helpers.js';
import type { PipelineResult } from '../../src/types/pipeline.js';

const USER_SAVE = 'Method:models/User.java:User.save#0';

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
  const calls = getRelationships(result, 'CALLS').filter((edge) => edge.target === 'save');
  const from = (caller: string): string[] =>
    calls
      .filter((edge) => edge.rel.sourceId === caller)
      .map((edge) => edge.rel.targetId)
      .sort();
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
    largePackage(count, 'models.User', {
      'app/models.java':
        'package app;\npublic class models {\n  public static class User { public void save() {} }\n}\n',
    }),
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
});

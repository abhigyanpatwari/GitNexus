import { describe, expect, it } from 'vitest';
import { getRelationships, getResolutionOutcomes, useFixture } from './helpers.js';

describe('TypeScript re-export ownership', () => {
  const result = useFixture('ts-module-ownership', {
    'left.ts': `
export function publish() {}
export class Entity { save() {} }
function privateMember() {}
export default function defaultExport() {}
`,
    'right.ts': 'export function publish() {}\nexport class Entity { save() {} }',
    'dual.ts': 'export default function dual() {}\nexport { dual };',
    'first.ts': "export { publish } from './left.js';",
    'second.ts': "export * from './right.js';",
    'ambiguous.ts': `
export * from './first.js';
// @ts-expect-error The two paths publish the same name from different owners.
export * from './second.js';
`,
    'reversed.ts': `
export * from './second.js';
// @ts-expect-error Reversing the order cannot remove the conflict.
export * from './first.js';
`,
    'same.ts': "export * from './first.js';\nexport * from './left.js';",
    'explicit.ts': `
export * from './first.js';
export * from './second.js';
export { publish } from './right.js';
`,
    'types.ts': `
export type { Entity, publish as erased } from './left.js';
export { type publish as specifierErased } from './left.js';
`,
    'types-forward.ts': "export * from './types.js';",
    'type-star.ts': "export type * from './left.js';",
    'type-namespace.ts': "export type * as types from './left.js';",
    'mixed.ts': "export type * from './left.js';\nexport * from './left.js';",
    'cycle-a.ts': "export * from './cycle-b.js';\nexport { publish } from './left.js';",
    'cycle-b.ts': "export * from './cycle-a.js';",
    'namespace.ts': `
export * as operations from './left.js';
export function wrongLocal() {
  // @ts-expect-error A namespace re-export creates no local binding.
  operations.publish();
}
`,
    'namespace-forward.ts': "export { operations as api } from './namespace.js';",
    'dual-forward.ts': "export * from './dual.js';",
    'namespace-twin.ts': "export * as operations from './left.js';",
    'namespace-diamond.ts': "export * from './namespace.js';\nexport * from './namespace-twin.js';",
    'entry.ts': `
import { publish as ambiguous } from './ambiguous.js';
import { publish as reversed } from './reversed.js';
import { publish as same } from './same.js';
import { publish as explicit } from './explicit.js';
import { Entity, erased, specifierErased } from './types-forward.js';
import { operations as namespace } from './namespace.js';
import { api } from './namespace-forward.js';
import * as pack from './namespace-forward.js';
import { operations as diamond } from './namespace-diamond.js';
import { publish as erasedStar, Entity as StarEntity } from './type-star.js';
import { types } from './type-namespace.js';
import { publish as mixed } from './mixed.js';
import { publish as cycled } from './cycle-b.js';
import { dual } from './dual-forward.js';

export function ambiguousCall() { ambiguous(); }
export function reversedCall() { reversed(); }
export function sameCall() { same(); }
export function explicitCall() { explicit(); }
export function typedInstance(value: Entity) { value.save(); }
export function erasedCall() {
  // @ts-expect-error A type-only export cannot be used as a value.
  erased();
  // @ts-expect-error The per-specifier form also erases the value.
  specifierErased();
}
export function firstNamespace() { namespace.publish(); }
export function forwardedNamespace() { api.default(); }
export function namedDefault() {
  // @ts-expect-error The default declaration's lexical name is not published.
  api.defaultExport();
}
export function dualDefault() { dual(); }
export function nestedNamespace() { pack.api.publish(); }
export function diamondNamespace() { diamond.publish(); }
export function qualifiedType(value: pack.api.Entity) { value.save(); }
class Unpublished { save() {} }
// @ts-expect-error The imported module does not export Unpublished.
export function missingQualifiedType(value: pack.api.Unpublished) { value.save(); }
export function typeStarInstance(value: StarEntity) { value.save(); }
export function typeNamespaceInstance(value: types.Entity) { value.save(); }
export function erasedStarCall() {
  // @ts-expect-error The star is type-only.
  erasedStar();
}
export function erasedNamespaceCall() {
  // @ts-expect-error The published namespace is type-only.
  types.publish();
}
export function mixedCall() { mixed(); }
export function cycleCall() { cycled(); }
export function privateNamespace() {
  // @ts-expect-error The target module does not export privateMember.
  namespace.privateMember();
}
`,
  });

  const publishLeft = 'Function:left.ts:publish';
  const publishRight = 'Function:right.ts:publish';
  it.each([
    ['entry.ts:ambiguousCall', []],
    ['entry.ts:reversedCall', []],
    ['entry.ts:sameCall', [publishLeft]],
    ['entry.ts:explicitCall', [publishRight]],
    ['entry.ts:typedInstance', ['Method:left.ts:Entity.save#0']],
    ['entry.ts:erasedCall', []],
    ['entry.ts:firstNamespace', [publishLeft]],
    ['entry.ts:forwardedNamespace', ['Function:left.ts:defaultExport']],
    ['entry.ts:namedDefault', []],
    ['entry.ts:dualDefault', ['Function:dual.ts:dual']],
    ['entry.ts:nestedNamespace', [publishLeft]],
    ['entry.ts:diamondNamespace', [publishLeft]],
    ['entry.ts:qualifiedType', ['Method:left.ts:Entity.save#0']],
    ['entry.ts:missingQualifiedType', []],
    ['entry.ts:typeStarInstance', ['Method:left.ts:Entity.save#0']],
    ['entry.ts:typeNamespaceInstance', ['Method:left.ts:Entity.save#0']],
    ['entry.ts:erasedStarCall', []],
    ['entry.ts:erasedNamespaceCall', []],
    ['entry.ts:mixedCall', [publishLeft]],
    ['entry.ts:cycleCall', [publishLeft]],
    ['entry.ts:privateNamespace', []],
    ['namespace.ts:wrongLocal', []],
  ] as const)('emits only the exact targets for %s', (caller, expected) => {
    const actual = getRelationships(result(), 'CALLS')
      .filter(({ rel }) => rel.sourceId === `Function:${caller}`)
      .map(({ rel }) => rel.targetId)
      .sort();
    expect(actual).toEqual(expected);
  });

  it('reports both owners for each conflicting barrel', () => {
    const conflicts = getResolutionOutcomes(result()).flatMap((outcome) =>
      outcome.kind === 'reexport-ambiguous' && outcome.name === 'publish'
        ? [[outcome.filePath, [...outcome.candidateIds].sort()]]
        : [],
    );
    expect(conflicts.sort()).toEqual([
      ['ambiguous.ts', ['def:left.ts#2:7:Function:publish', 'def:right.ts#1:7:Function:publish']],
      ['reversed.ts', ['def:left.ts#2:7:Function:publish', 'def:right.ts#1:7:Function:publish']],
    ]);
  });

  it('records the written file dependencies with their erasure', () => {
    const imports = getRelationships(result(), 'IMPORTS');
    for (const file of ['types.ts', 'type-star.ts', 'type-namespace.ts']) {
      const edge = imports.find(
        ({ sourceFilePath, targetFilePath }) =>
          sourceFilePath === file && targetFilePath === 'left.ts',
      );
      expect(edge?.rel.reason).toContain('(type-only)');
    }
    expect(
      imports.some(
        ({ sourceFilePath, targetFilePath }) =>
          sourceFilePath === 'entry.ts' && targetFilePath === 'left.ts',
      ),
    ).toBe(false);
    expect(
      imports.some(
        ({ sourceFilePath, targetFilePath }) =>
          sourceFilePath === 'entry.ts' && targetFilePath === 'namespace-forward.ts',
      ),
    ).toBe(true);
  });
});

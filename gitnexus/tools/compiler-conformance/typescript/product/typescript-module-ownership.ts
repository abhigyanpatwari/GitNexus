import { registerCases } from '../support/cases.mjs';
import { describe, it } from 'node:test';
import { expect } from 'expect';
import { getRelationships, getResolutionOutcomes, useFixture } from '../support/fixture.js';

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
    'default-alias.ts':
      'export default function implementation() {}\nexport { implementation as exposed };',
    'local-alias.ts': `
function original() {}
export { original as exposed };
export function direct() {}
export { direct as additional };
`,
    'local-types.ts': `
class Impl { save() {} }
function hidden() {}
export type { Impl as Public };
export { type hidden };
export function directValue() {}
export type { directValue as Erased };
`,
    'local-types-forward.ts': "export * from './local-types.js';",
    'alias-forward.ts': "export * from './local-alias.js';",
    'wrapped.ts': `
function wrap(fn: () => void) { return fn; }
function callback() {}
export { callback as exposed };
export default wrap(function callback() {});
`,
    'import-forward.ts': `import { publish as original, Entity } from './left.js';
      import * as packageObject from './left.js';
      export { original as run, Entity as K, packageObject as api };
      export * from './competitor.js';`,
    'competitor.ts': 'export function run() {} export class K { save() {} }',
    'quote-namespace.ts': 'export * as "other object" from "./left.js";',
    'spaces.ts': `import * as pack from './left.js';
      export namespace Inner { export namespace pack { export class Entity { save() {} } }
        export function shadowed(v: pack.Entity) { v.save(); } }
      class Entity { save() {} }
      export namespace Models { export class Entity { save() {} } }
      export function local(v: Models.Entity) { v.save(); }
      export function outer(v: pack.Entity) { v.save(); }`,
    'loaders.ts': `import * as mod from './left.js';
      export async function useLocal() {
        const mod = await import('./right.js');
        const entity = new mod.Entity();
        entity.save();
      }
      export function useOuter() {
        const entity = new mod.Entity();
        entity.save();
      }`,
    'direct-type.ts': 'export interface publish { save(): void }',
    'direct-mixed.ts': "export * from './direct-type.js'; export * from './left.js';",
    'mixed-owners.ts': "export type * from './right.js'; export * from './left.js';",
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
import type { Public } from './local-types-forward.js';
import { hidden, Erased, directValue } from './local-types-forward.js';
import * as localTypes from './local-types.js';
export function useTypeAlias(x: Public) { x.save(); }
export function useDirectValue() { directValue(); }
export function erasedLocalCalls() {
  // @ts-expect-error The function name is exported only as a type.
  hidden();
  // @ts-expect-error The alias is exported only as a type.
  Erased();
  // @ts-expect-error Namespace access cannot recover an erased value.
  localTypes.hidden();
  // @ts-expect-error The class alias is exported only as a type.
  new localTypes.Public();
  // @ts-expect-error The imported class alias has no runtime constructor.
  new Public();
}
import { run as forwarded } from './import-forward.js';
import * as via from './import-forward.js';
import { "other object" as quotedNamespace } from './quote-namespace.js';
import { publish as valueBesideType } from './direct-mixed.js';
export function useValueBesideType() { valueBesideType(); }
import { publish as runtimeStar } from './mixed-owners.js';
export function callForwarded() { forwarded(); }
export function callForwardedNamespace() { via.run(); }
export function useForwardedObject() { via.api.publish(); }
export function useForwardedType(v: via.K) { v.save(); }
export function useQuotedNamespace() { quotedNamespace.publish(); }
export function useRuntimeStar() { runtimeStar(); }
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
import * as aliases from './default-alias.js';
import * as localAliases from './alias-forward.js';
import * as wrapper from './wrapped.js';

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
export function namedAliasOfDefault() { aliases.exposed(); }
export function privateAliasImplementation() {
  // @ts-expect-error The lexical name was not exported.
  aliases.implementation();
}
export function namedAlias() { localAliases.exposed(); }
export function hiddenLocalName() {
  // @ts-expect-error Only the alias was exported.
  localAliases.original();
}
export function directPublication() { localAliases.direct(); }
export function additionalPublication() { localAliases.additional(); }
export function wrapperDefault() { wrapper.default(); }
export function wrapperAlias() { wrapper.exposed(); }
export function hiddenWrapperCallback() {
  // @ts-expect-error The expression's callback name is local to its body.
  wrapper.callback();
}
export function nestedNamespace() { pack.api.publish(); }
export function diamondNamespace() { diamond.publish(); }
export function qualifiedType(value: pack.api.Entity) { value.save(); }
export function spacedQualifiedType(value: pack . api . Entity) { value.save(); }
export function escapedQualifiedType(value: pack.api.\\u0045ntity) { value.save(); }
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
  registerCases(
    it,
    [
      ['entry.ts:ambiguousCall', []],
      ['entry.ts:reversedCall', []],
      ['entry.ts:sameCall', [publishLeft]],
      ['entry.ts:explicitCall', [publishRight]],
      ['entry.ts:typedInstance', ['Method:left.ts:Entity.save#0']],
      ['entry.ts:erasedCall', []],
      ['entry.ts:firstNamespace', [publishLeft]],
      ['entry.ts:forwardedNamespace', ['Function:left.ts:defaultExport']],
      ['entry.ts:namedDefault', []],
      ['entry.ts:useTypeAlias', ['Method:local-types.ts:Impl.save#0']],
      ['entry.ts:useDirectValue', ['Function:local-types.ts:directValue']],
      ['entry.ts:erasedLocalCalls', []],
      ['entry.ts:callForwarded', [publishLeft]],
      ['entry.ts:callForwardedNamespace', [publishLeft]],
      ['entry.ts:useForwardedObject', [publishLeft]],
      ['entry.ts:useForwardedType', ['Method:left.ts:Entity.save#0']],
      ['entry.ts:useQuotedNamespace', [publishLeft]],
      ['entry.ts:useRuntimeStar', [publishLeft]],
      ['entry.ts:useValueBesideType', [publishLeft]],
      ['spaces.ts:outer', ['Method:left.ts:Entity.save#0']],
      ['spaces.ts:local', []],
      ['entry.ts:dualDefault', ['Function:dual.ts:dual']],
      ['entry.ts:namedAliasOfDefault', ['Function:default-alias.ts:implementation']],
      ['entry.ts:privateAliasImplementation', []],
      ['entry.ts:namedAlias', ['Function:local-alias.ts:original']],
      ['entry.ts:hiddenLocalName', []],
      ['entry.ts:directPublication', ['Function:local-alias.ts:direct']],
      ['entry.ts:additionalPublication', ['Function:local-alias.ts:direct']],
      ['entry.ts:wrapperDefault', ['Function:wrapped.ts:wrapped']],
      ['entry.ts:wrapperAlias', ['Function:wrapped.ts:callback']],
      ['entry.ts:hiddenWrapperCallback', []],
      ['entry.ts:nestedNamespace', [publishLeft]],
      ['entry.ts:diamondNamespace', [publishLeft]],
      ['entry.ts:qualifiedType', ['Method:left.ts:Entity.save#0']],
      ['entry.ts:spacedQualifiedType', ['Method:left.ts:Entity.save#0']],
      ['entry.ts:escapedQualifiedType', ['Method:left.ts:Entity.save#0']],
      ['entry.ts:missingQualifiedType', []],
      ['entry.ts:typeStarInstance', ['Method:left.ts:Entity.save#0']],
      ['entry.ts:typeNamespaceInstance', ['Method:left.ts:Entity.save#0']],
      ['entry.ts:erasedStarCall', []],
      ['entry.ts:erasedNamespaceCall', []],
      ['entry.ts:mixedCall', [publishLeft]],
      ['entry.ts:cycleCall', [publishLeft]],
      ['entry.ts:privateNamespace', []],
      ['namespace.ts:wrongLocal', []],
    ] as const,
    'emits only the exact targets for %s',
    (caller, expected) => {
      const actual = getRelationships(result(), 'CALLS')
        .filter(({ rel }) => rel.sourceId === `Function:${caller}`)
        .map(({ rel }) => rel.targetId)
        .sort();
      expect(actual).toEqual(expected);
    },
  );

  registerCases(
    it,
    [
      ['useLocal', 'right.ts'],
      ['useOuter', 'left.ts'],
    ],
    'resolves the instance method through the namespace visible to %s',
    (caller, targetFile) => {
      const methods = getRelationships(result(), 'CALLS')
        .filter(
          ({ rel }) =>
            rel.sourceId === `Function:loaders.ts:${caller}` && rel.targetId.startsWith('Method:'),
        )
        .map(({ rel }) => rel.targetId);
      expect(methods).toEqual([`Method:${targetFile}:Entity.save#0`]);
    },
  );

  it('refuses the outer import for a shadowed qualified parameter', () => {
    const calls = getRelationships(result(), 'CALLS')
      .filter(({ source }) => source === 'shadowed')
      .map(({ rel }) => rel.targetId);
    expect(calls).not.toContain('Method:left.ts:Entity.save#0');
  });

  it('keeps the quoted namespace dependency', () => {
    expect(
      getRelationships(result(), 'IMPORTS')
        .filter(({ sourceFilePath }) => sourceFilePath === 'quote-namespace.ts')
        .map(({ targetFilePath }) => targetFilePath),
    ).toEqual(['left.ts']);
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

registerCases(describe, ['ts', 'mjs'], 'quoted export ownership (%s)', (extension) => {
  const suffix = extension === 'ts' ? 'js' : extension;
  const result = useFixture(`quoted-exports-${extension}`, {
    [`local.${extension}`]: String.raw`
function original() {}
function defaultImpl() {}
function literalEscape() {}
function ordinary() {}
function astral() {}
export { astral as "\u{1F600}", \u006friginal as escapedLocal };
export { original as "pub\x6cic-name", defaultImpl as 'default', literalEscape as '\\u0061', ordinary as a };
`,
    [`barrel.${extension}`]: `export { 'public-name' as "another name" } from './local.${suffix}';`,
    [`entry.${extension}`]: String.raw`
import * as namespace from './local.${suffix}';
import primary, { 'public-name' as direct, '\\u0061' as escape, '\u{0000061}' as padded } from './local.${suffix}';
import { 'another name' as forwarded } from './barrel.${suffix}';
import { "\uD83D\uDE00" as emoji, escapedLocal } from './local.${suffix}';
export function useAstral() { emoji(); }
export function useEscapedLocal() { escapedLocal(); }
export function useDirect() { direct(); }
export function useDefault() { primary(); }
export function useLiteralEscape() { escape(); }
export function usePaddedEscape() { padded(); }
export function useBarrel() { forwarded(); }
export function hiddenName() {
  // @ts-expect-error The local name was never published.
  namespace.original();
}
`,
  });

  registerCases(
    it,
    [
      ['useDirect', 'original'],
      ['useAstral', 'astral'],
      ['useEscapedLocal', 'original'],
      ['useDefault', 'defaultImpl'],
      ['useLiteralEscape', 'literalEscape'],
      ['usePaddedEscape', 'ordinary'],
      ['useBarrel', 'original'],
      ['hiddenName', null],
    ] as const,
    'emits only the exact targets for %s',
    (caller, target) => {
      const actual = getRelationships(result(), 'CALLS')
        .filter(({ rel }) => rel.sourceId === `Function:entry.${extension}:${caller}`)
        .map(({ rel }) => rel.targetId);
      expect(actual).toEqual(target === null ? [] : [`Function:local.${extension}:${target}`]);
    },
  );
});

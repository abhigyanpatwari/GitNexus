/**
 * A function inside an object literal reaches a namespace import even when a
 * property of that literal is spelled like the import.
 *
 * Property names are not free identifiers: `lookupLexicalName` skips an
 * `Object` scope's own bindings whether the walk passes through it or starts
 * at it. The namespace target cache shares one snapshot between a scope and a
 * parent that has no facts about the imported name, and that parent can be the
 * object literal, so the lookup for `m` below starts at the `Object` scope.
 */
import { describe, it } from 'node:test';
import { expect } from 'expect';
import { getRelationships, useFixture } from '../support/fixture.js';

describe('TypeScript namespace import under a same-named object property', () => {
  // `f` has two owners, so only the namespace the prefix names can decide.
  const run = useFixture('ts-object-literal-namespace-import', {
    'x.ts': 'export function f(): void {}\n',
    'y.ts': 'export function f(): void {}\n',
    'a.ts': `import * as ns from './x';
import * as other from './y';

export const holder = {
  ns: 1,
  other: other,
  m() {
    ns.f();
  },
  arrow: () => {
    ns.f();
  },
};
`,
  });
  const targets = (sourceId: string): string[] =>
    getRelationships(run(), 'CALLS')
      .filter((edge) => edge.rel.sourceId === sourceId)
      .map((edge) => edge.rel.targetId)
      .sort();

  it('resolves the method through the import, not the property', () => {
    expect(targets('Method:a.ts:holder.m#0')).toEqual(['Function:x.ts:f']);
  });

  it('resolves the arrow property through the import, not the property', () => {
    expect(targets('Function:a.ts:holder.arrow')).toEqual(['Function:x.ts:f']);
  });
});

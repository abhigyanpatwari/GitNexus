import { describe, expect, it } from 'vitest';
import { getRelationships, useFixture } from './helpers.js';

describe('JavaScript re-export ownership', () => {
  const result = useFixture('js-module-ownership', {
    'package.json': '{"type":"module"}',
    'left.js': `
export function publish() {}
export function uniqueCall() {}
function privateMember() {}
export default function main() {}
`,
    'right.js': 'export function publish() {}',
    'first.js': "export { publish } from './left.js';",
    'second.js': "export * from './right.js';",
    'ambiguous.js': "export * from './first.js';\nexport * from './second.js';",
    'same.js': "export * from './left.js';\nexport * from './first.js';",
    'explicit.js': "export * from './ambiguous.js';\nexport { publish } from './right.js';",
    'namespace.js': `
export * as model from './left.js';
export { publish as publicCall } from './left.js';
export { uniqueCall } from './left.js';
export {} from './effect.js';
export function hiddenNamespace() { model.publish(); }
export function hiddenNamed() { publicCall(); }
export function hiddenUnique() { uniqueCall(); }
`,
    'effect.js': 'export const initialized = true;',
    'forward.js': "export { model as api } from './namespace.js';",
    'default-object.js': "export * as default from './left.js';",
    'literal-object.js': "export * as 'other object' from './left.js';",
    'real-local.js': `
import { uniqueCall } from './left.js';
export { uniqueCall } from './left.js';
export function boundUnique() { uniqueCall(); }
`,
    'entry.js': `
import { publish as choose } from './ambiguous.js';
import { publish as same } from './same.js';
import { publish as explicit } from './explicit.js';
import { api } from './forward.js';
import * as pack from './forward.js';
import defaultObject from './default-object.js';
import { publish as wrongLiteral } from './literal-object.js';
export function wrong() { choose(); }
export function useSame() { same(); }
export function useExplicit() { explicit(); }
export function useNamespace() { api.publish(); }
export function useNestedNamespace() { pack.api.publish(); }
export function useDefault() { api.default(); }
export function useDefaultObject() { defaultObject.publish(); }
export function useWrongLiteral() { wrongLiteral(); }
export function useDefaultAsNamed() { api.main(); }
export function usePrivate() { api.privateMember(); }
export function shadowed(api) { api.publish(); }
`,
  });

  it.each([
    ['entry.js:wrong', []],
    ['entry.js:useSame', ['Function:left.js:publish']],
    ['entry.js:useExplicit', ['Function:right.js:publish']],
    ['entry.js:useNamespace', ['Function:left.js:publish']],
    ['entry.js:useNestedNamespace', ['Function:left.js:publish']],
    ['entry.js:useDefault', ['Function:left.js:main']],
    ['entry.js:useDefaultObject', ['Function:left.js:publish']],
    ['entry.js:useWrongLiteral', []],
    ['entry.js:useDefaultAsNamed', []],
    ['entry.js:usePrivate', []],
    ['entry.js:shadowed', []],
    ['namespace.js:hiddenNamespace', []],
    ['namespace.js:hiddenNamed', []],
    ['namespace.js:hiddenUnique', []],
    ['real-local.js:boundUnique', ['Function:left.js:uniqueCall']],
  ] as const)('emits only the exact targets for %s', (caller, expected) => {
    const targets = getRelationships(result(), 'CALLS')
      .filter(({ rel }) => rel.sourceId === `Function:${caller}`)
      .map(({ rel }) => rel.targetId)
      .sort();
    expect(targets).toEqual(expected);
  });

  it('keeps the side-effect dependency from an empty export clause', () => {
    expect(
      getRelationships(result(), 'IMPORTS').some(
        ({ rel }) => rel.sourceId === 'File:namespace.js' && rel.targetId === 'File:effect.js',
      ),
    ).toBe(true);
  });
});

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
    'star-local.js': `
export * from './left.js';
export function starIsNotLocal() { uniqueCall(); }
`,
    'default-alias.js': `
function implementation() {}
export default implementation;
export { implementation as exposed };
`,
    'local-alias.js': `
function original() {}
export { original as exposed };
export function direct() {}
export { direct as additional };
`,
    'alias-forward.js': "export * from './local-alias.js';",
    'wrapped.js': `
function wrap(fn) { return fn; }
function callback() {}
export { callback as exposed };
export default wrap(function callback() {});
`,
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
import { exposed } from './default-alias.js';
import * as localAliases from './alias-forward.js';
import * as wrapper from './wrapped.js';
export function wrong() { choose(); }
export function useSame() { same(); }
export function useExplicit() { explicit(); }
export function useNamespace() { api.publish(); }
export function useNestedNamespace() { pack.api.publish(); }
export function useDefault() { api.default(); }
export function useDefaultObject() { defaultObject.publish(); }
export function useDefaultAlias() { exposed(); }
export function useLocalAlias() { localAliases.exposed(); }
export function useHiddenLocalName() { localAliases.original(); }
export function useDirect() { localAliases.direct(); }
export function useAdditional() { localAliases.additional(); }
export function useWrapperDefault() { wrapper.default(); }
export function useWrapperAlias() { wrapper.exposed(); }
export function useHiddenWrapperCallback() { wrapper.callback(); }
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
    ['entry.js:useDefaultAlias', ['Function:default-alias.js:implementation']],
    ['entry.js:useLocalAlias', ['Function:local-alias.js:original']],
    ['entry.js:useHiddenLocalName', []],
    ['entry.js:useDirect', ['Function:local-alias.js:direct']],
    ['entry.js:useAdditional', ['Function:local-alias.js:direct']],
    ['entry.js:useWrapperDefault', ['Function:wrapped.js:wrapped']],
    ['entry.js:useWrapperAlias', ['Function:wrapped.js:callback']],
    ['entry.js:useHiddenWrapperCallback', []],
    ['entry.js:useWrongLiteral', []],
    ['entry.js:useDefaultAsNamed', []],
    ['entry.js:usePrivate', []],
    ['entry.js:shadowed', []],
    ['namespace.js:hiddenNamespace', []],
    ['namespace.js:hiddenNamed', []],
    ['namespace.js:hiddenUnique', []],
    ['real-local.js:boundUnique', ['Function:left.js:uniqueCall']],
    ['star-local.js:starIsNotLocal', []],
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

describe('package ESM without static exports', () => {
  const wrapper = 'var module; module.exports = function candidate() {};';
  const result = useFixture('wrapper-format-without-esm-exports', {
    'package.json': '{"type":"module"}',
    'common/package.json': '{"type":"commonjs"}',
    'plain.js': 'module.exports = function candidate() {};',
    'guarded.js':
      'if (typeof module !== "undefined") { module.exports = function candidate() {}; }',
    'var-wrapper.js': wrapper,
    'explicit.mjs': wrapper,
    'shadow.js': 'var module = {exports:{}}; module.exports = function localOnly() {};',
    'forced.cjs': wrapper,
    'tsconfig.json': '{"compilerOptions":{"module":"NodeNext","moduleResolution":"NodeNext"}}',
    'mixed.ts':
      'var module = {}; module.exports = function privateTs() {}; export default function genuineTs() {} export function namedTs() {}',
    'typed.mts': `
      import chosenTs, { namedTs } from './mixed.js';
      import * as mixed from './mixed.js';
      export function typedUse(){ chosenTs(); namedTs(); mixed.privateTs(); }
    `,
    'common/wrapper.js': wrapper,
    'native.js':
      'var module = {}; module.exports = function privateFn() {}; export function open() {} export default function real() {}',
    'entry.mjs': `
      import plain from './plain.js';
      import * as guard from './guarded.js';
      import assigned from './var-wrapper.js';
      import * as wrap from './var-wrapper.js';
      import explicit from './explicit.mjs';
      import * as shadow from './shadow.js';
      import forced from './forced.cjs';
      import common from './common/wrapper.js';
      import chosen, {open} from './native.js';
      import * as native from './native.js';
      export function probePlain(){ plain(); }
      export function probeGuarded(){ guard.default(); }
      export function probeDirect(){ assigned(); }
      export function probeNamespace(){ wrap.default(); }
      export function probeName(){ wrap.candidate(); }
      export function probeExplicit(){ explicit(); }
      export function probeShadow(){ shadow.default(); }
      export function probeForced(){ forced(); }
      export function probeCommon(){ common(); }
      export function probeNative(){ chosen(); open(); native.privateFn(); }
    `,
  });
  it('keeps the ESM publications of a NodeNext TypeScript file with a local module variable', () => {
    const targets = getRelationships(result(), 'CALLS')
      .filter(({ rel }) => rel.sourceId === 'Function:typed.mts:typedUse')
      .map(({ rel }) => rel.targetId)
      .sort();
    expect(targets).toEqual(['Function:mixed.ts:genuineTs', 'Function:mixed.ts:namedTs']);
  });
  it.each([
    ['probePlain', []],
    ['probeGuarded', []],
    ['probeDirect', []],
    ['probeNamespace', []],
    ['probeName', []],
    ['probeExplicit', []],
    ['probeShadow', []],
    ['probeForced', ['Function:forced.cjs:candidate']],
    ['probeCommon', ['Function:common/wrapper.js:candidate']],
    ['probeNative', ['Function:native.js:open', 'Function:native.js:real']],
  ] as const)('publishes exactly the format-specific call targets for %s', (source, expected) => {
    const targets = getRelationships(result(), 'CALLS')
      .filter(({ rel }) => rel.sourceId === `Function:entry.mjs:${source}`)
      .map(({ rel }) => rel.targetId)
      .sort();
    expect(targets).toEqual(expected);
  });
});

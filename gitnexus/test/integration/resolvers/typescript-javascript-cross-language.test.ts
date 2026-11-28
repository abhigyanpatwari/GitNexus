/**
 * TypeScript ↔ JavaScript cross-language imports (#4252).
 *
 * Scope resolution runs once per language, so a `.ts` file importing a `.js`
 * module (or the reverse) used to have no target file and no definition to
 * bind against: neither IMPORTS nor CALLS was emitted. Each ECMAScript pass now
 * pulls the other language's imported files into its scope context.
 */
import { describe, it, expect } from 'vitest';
import { edgeSet, getRelationships, useFixture } from './helpers.js';

describe('TypeScript ↔ JavaScript cross-language imports (#4252)', () => {
  const result = useFixture('ts-js-cross-language', {
    'jslib/a.js':
      'export function fromJs() { return 1; }\n' +
      'export const jsUtils = { fromJs };\n' +
      "export { reJs } from './c';\n",
    'jslib/c.js': 'export function reJs() { return 3; }\n',
    'tslib/b.ts': 'export function fromTs() { return 2; }\nexport const tsUtils = { fromTs };\n',
    'app/t.ts':
      "import { fromJs, jsUtils, reJs } from '../jslib/a';\n" +
      'export function tDirect() { return fromJs(); }\n' +
      'export function tObj() { return jsUtils.fromJs(); }\n' +
      'export function tRe() { return reJs(); }\n',
    'app/j.js':
      "import { fromTs, tsUtils } from '../tslib/b';\n" +
      'export function jDirect() { return fromTs(); }\n' +
      'export function jObj() { return tsUtils.fromTs(); }\n',
    'app/jj.js':
      "import { fromJs } from '../jslib/a';\nexport function jjDirect() { return fromJs(); }\n",
  });

  const fileImports = () =>
    getRelationships(result(), 'IMPORTS')
      .map((e) => `${e.sourceFilePath} → ${e.targetFilePath}`)
      .sort();
  const functionCalls = () =>
    edgeSet(getRelationships(result(), 'CALLS').filter((e) => e.targetLabel === 'Function'));

  it('emits IMPORTS across the language boundary in both directions', () => {
    expect(fileImports()).toEqual(
      expect.arrayContaining([
        'app/t.ts → jslib/a.js',
        'app/j.js → tslib/b.ts',
        'app/jj.js → jslib/a.js',
      ]),
    );
  });

  it('resolves direct calls from TypeScript into JavaScript and back', () => {
    expect(functionCalls()).toEqual(
      expect.arrayContaining(['tDirect → fromJs', 'jDirect → fromTs', 'jjDirect → fromJs']),
    );
  });

  it('resolves calls through an aggregated object across the boundary', () => {
    expect(functionCalls()).toEqual(expect.arrayContaining(['tObj → fromJs', 'jObj → fromTs']));
  });

  it('follows a JavaScript re-export chain from a TypeScript caller', () => {
    expect(functionCalls()).toContain('tRe → reJs');
  });

  it('does not duplicate cross-language edges emitted by both passes', () => {
    const calls = getRelationships(result(), 'CALLS').map((e) => e.rel.id);
    expect(new Set(calls).size).toBe(calls.length);
  });
});

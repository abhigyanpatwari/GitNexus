/**
 * `@declaration.is-exported` — the export-evidence marker the TypeScript and
 * JavaScript capture emitters synthesize (`ts-js-export-marker.ts`), and its
 * landing on `SymbolDefinition.isExported` through the central extractor.
 * Review findings on #3182 (typescript/scope-resolver.ts:138).
 */
import { describe, it, expect } from 'vitest';
import { emitTsScopeCaptures } from '../../../src/core/ingestion/languages/typescript/captures.js';
import { emitJsScopeCaptures } from '../../../src/core/ingestion/languages/javascript/captures.js';
import { extract } from '../../../src/core/ingestion/scope-extractor.js';
import { typescriptScopeResolver } from '../../../src/core/ingestion/languages/typescript/scope-resolver.js';

type Emit = typeof emitTsScopeCaptures;

function verdicts(emit: Emit, src: string, filePath: string): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const m of emit(src, filePath)) {
    const name = m['@declaration.name']?.text;
    if (name === undefined) continue;
    if (name in out && out[name] !== undefined) continue;
    out[name] = m['@declaration.is-exported']?.text;
  }
  return out;
}

const ESM = `
export function a() {}
function b() {}
const c = () => 1;
export const d = 2;
function e() {}
export { c, e as renamed };
function f() {}
export default f;
function g() { function inner() {} }
`;

describe('@declaration.is-exported (TypeScript emitter)', () => {
  it('marks direct, clause and default exports true and everything else false in an ESM file', () => {
    const v = verdicts(emitTsScopeCaptures, ESM, 'test.ts');
    expect(v.a).toBe('true');
    expect(v.b).toBe('false');
    expect(v.c).toBe('true');
    expect(v.d).toBe('true');
    expect(v.e).toBe('true');
    expect(v.f).toBe('true');
    expect(v.g).toBe('false');
    expect(v.inner).toBe('false');
  });

  it('a member of an exported class is NOT itself exported; nested functions never are (magyargergo)', () => {
    const v = verdicts(
      emitTsScopeCaptures,
      'export class Unrelated { clash() {} }\nfunction wrapper() { function selected() {} }\nexport { selected };\nconst selected = 1;\n',
      'test.ts',
    );
    expect(v.Unrelated).toBe('true');
    expect(v.clash).toBe('false');
    expect(v.wrapper).toBe('false');
    // Two `selected`s: the module-level one is exported by the clause, the
    // nested one is not — `verdicts` keeps the first non-undefined per name, so
    // look them up individually.
    const all = emitTsScopeCaptures(
      'function wrapper() { function selected() {} }\nexport { selected };\nconst selected = 1;\n',
      'test.ts',
    ).filter((m) => m['@declaration.name']?.text === 'selected');
    expect(all.map((m) => m['@declaration.is-exported']?.text).sort()).toEqual(['false', 'true']);
  });

  it("a method of the `module.exports = { … }` object literal IS that module's export (magyargergo)", () => {
    const v = verdicts(
      emitJsScopeCaptures,
      'function helper() {}\nmodule.exports = { alpha() { return 1; }, beta: () => 2 };\n',
      'lib.js',
    );
    expect(v.alpha).toBe('true');
    expect(v.beta).toBe('true');
    expect(v.helper).toBeUndefined();
  });

  it('emits NO verdict for a CommonJS file — `module.exports` is an export surface it cannot read', () => {
    const v = verdicts(
      emitTsScopeCaptures,
      'function a() {}\nfunction b() {}\nmodule.exports = { a };\n',
      'test.ts',
    );
    expect(v.a).toBeUndefined();
    expect(v.b).toBeUndefined();
  });

  it('emits NO verdict for an ambient .d.ts', () => {
    const v = verdicts(emitTsScopeCaptures, 'declare function a(): void;\n', 'lib.d.ts');
    expect(v.a).toBeUndefined();
  });

  it('does not let a file that STARTS with `export` mark everything exported (the text-prefix trap)', () => {
    const v = verdicts(
      emitTsScopeCaptures,
      'export const x = 1;\nfunction hidden() {}\n',
      'test.ts',
    );
    expect(v.x).toBe('true');
    expect(v.hidden).toBe('false');
  });
});

describe('@declaration.is-exported — Opus review follow-ups', () => {
  it('a re-export FROM another module never marks a same-named local exported', () => {
    const v = verdicts(
      emitTsScopeCaptures,
      "export { alpha } from './other';\nexport { beta as gamma } from './o';\nexport type { T } from './t';\nfunction alpha() {}\nfunction beta() {}\nfunction gamma() {}\ntype T = number;\nexport const keep = 1;\n",
      'test.ts',
    );
    expect(v.alpha).not.toBe('true');
    expect(v.beta).not.toBe('true');
    expect(v.gamma).not.toBe('true');
    expect(v.T).not.toBe('true');
    expect(v.alpha).toBe('false');
    expect(v.keep).toBe('true');
  });

  it('exports inside a namespace or ambient module body are not file-level exports', () => {
    const v = verdicts(
      emitTsScopeCaptures,
      "export namespace NS { export function f() {} }\ndeclare module 'x' { export function q(): void; }\nexport function top() {}\n",
      'test.ts',
    );
    expect(v.NS).toBe('true');
    expect(v.f).not.toBe('true');
    expect(v.q).not.toBe('true');
    expect(v.top).toBe('true');
  });

  it('a comment or string mentioning module.exports does not silence the ESM verdicts', () => {
    const v = verdicts(
      emitTsScopeCaptures,
      "// legacy: module.exports = api\nconst note = 'exports.x = 1';\nexport function a() {}\nfunction b() {}\n",
      'test.ts',
    );
    expect(v.a).toBe('true');
    expect(v.b).toBe('false');
    // ...while a real alias of the export object still does.
    const cjs = verdicts(
      emitJsScopeCaptures,
      'const m = module.exports;\nfunction b() {}\nm.b = b;\n',
      'x.js',
    );
    expect(cjs.b).toBeUndefined();
  });
});

describe('@declaration.is-exported (JavaScript emitter)', () => {
  it('marks ESM declarations', () => {
    const v = verdicts(emitJsScopeCaptures, ESM, 'test.js');
    expect(v.a).toBe('true');
    expect(v.b).toBe('false');
    expect(v.e).toBe('true');
    expect(v.f).toBe('true');
  });

  it('stays silent for `exports.x =` files', () => {
    const v = verdicts(emitJsScopeCaptures, 'function a() {}\nexports.a = a;\n', 'test.js');
    expect(v.a).toBeUndefined();
  });
});

describe('SymbolDefinition.isExported through the extractor', () => {
  it('lands as a tri-state field: true / false / absent', () => {
    const esm = extract(
      emitTsScopeCaptures('export function a() {}\nfunction b() {}\n', 'x.ts'),
      'x.ts',
      typescriptScopeResolver,
    );
    const byName = new Map(esm.localDefs.map((d) => [d.qualifiedName, d.isExported]));
    expect(byName.get('a')).toBe(true);
    expect(byName.get('b')).toBe(false);
    const cjs = extract(
      emitTsScopeCaptures('function a() {}\nmodule.exports = a;\n', 'y.ts'),
      'y.ts',
      typescriptScopeResolver,
    );
    expect(cjs.localDefs.find((d) => d.qualifiedName === 'a')?.isExported).toBeUndefined();
    expect('isExported' in cjs.localDefs.find((d) => d.qualifiedName === 'a')!).toBe(false);
  });
});

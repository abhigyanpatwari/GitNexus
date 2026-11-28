/**
 * `@declaration.is-exported` — the export-evidence marker the TypeScript and
 * JavaScript capture emitters synthesize (`ts-js-export-marker.ts`), and its
 * landing on `SymbolDefinition.isExported` through the central extractor.
 * Review findings on #3182 (typescript/scope-resolver.ts:138).
 */
import { describe, it, expect } from 'vitest';
import { emitTsScopeCaptures } from '../../../src/core/ingestion/languages/typescript/captures.js';
import { emitJsScopeCaptures } from '../../../src/core/ingestion/languages/javascript/captures.js';
import { typescriptModuleExports } from '../../../src/core/ingestion/languages/typescript/module-exports.js';
import { extract } from '../../../src/core/ingestion/scope-extractor.js';
import {
  javascriptProvider,
  typescriptProvider,
} from '../../../src/core/ingestion/languages/typescript.js';

type Emit = typeof emitTsScopeCaptures;

function verdicts(emit: Emit, src: string, filePath: string): Record<string, string | undefined> {
  const out = Object.create(null) as Record<string, string | undefined>;
  for (const m of emit(src, filePath)) {
    const name = m['@declaration.name']?.text;
    if (name === undefined) continue;
    if (Object.hasOwn(out, name) && out[name] !== undefined) continue;
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

  it('does not skip a declaration named toString as an Object.prototype hit', () => {
    const v = verdicts(emitTsScopeCaptures, 'export function toString() {}\n', 'test.ts');
    expect(v.toString).toBe('true');
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
  it('keeps bracket-form top-level this exports undecided like dot-form exports', () => {
    for (const [emit, file] of [
      [emitJsScopeCaptures, 'x.js'],
      [emitTsScopeCaptures, 'x.ts'],
    ] as const) {
      const v = verdicts(emit, "function api() {} this['api'] = api;", file);
      expect(v.api).toBeUndefined();
    }
  });

  it('treats a top-level conditional this assignment as CommonJS', () => {
    for (const [emit, file] of [
      [emitJsScopeCaptures, 'x.js'],
      [emitTsScopeCaptures, 'x.ts'],
    ] as const) {
      for (const src of [
        'function api() {}\nif (enabled) this.api = api;\nfunction hidden() {}',
        'function api() {}\nif (enabled) { this.api = api; }\nfunction hidden() {}',
      ]) {
        const v = verdicts(emit, src, file);
        expect(v.api).toBeUndefined();
        expect(v.hidden).toBeUndefined();
      }
    }
  });

  it('does not treat this assignments inside a function as module exports', () => {
    const v = verdicts(
      emitJsScopeCaptures,
      'function wrapper() { if (enabled) this.api = api; }\nfunction hidden() {}',
      'x.js',
    );
    expect(v.hidden).toBe('false');
  });

  it('recognizes exported module-scoped var inside a block, but not block let or function-local var', () => {
    for (const [emit, file] of [
      [emitJsScopeCaptures, 'x.js'],
      [emitTsScopeCaptures, 'x.ts'],
    ] as const) {
      const v = verdicts(
        emit,
        'if (ok) { var visible = 1; let hidden = 2; } function wrapper() { var nested = 3; } export { visible, hidden, nested };',
        file,
      );
      expect(v.visible).toBe('true');
      expect(v.hidden).toBe('false');
      expect(v.nested).toBe('false');
    }
  });

  it('marks synthesized default-export HOC declarations in both emitters', () => {
    for (const [emit, file] of [
      [emitJsScopeCaptures, 'Widget.jsx'],
      [emitTsScopeCaptures, 'Widget.tsx'],
    ] as const) {
      const captures = emit('export default memo(() => <div />);', file).filter(
        (capture) => capture['@declaration.function'] !== undefined,
      );
      expect(captures.length).toBeGreaterThan(0);
      expect(
        captures.every((capture) => capture['@declaration.is-exported']?.text === 'true'),
      ).toBe(true);
    }
  });

  it.each([
    'function wrapper(module) { module.exports = {}; }',
    "function wrapper(module) { module['exports'] = {}; }",
    'function wrapper(exports) { exports.alpha = 1; }',
    "const wrapper = exports => { exports['alpha'] = 1; };",
    'function wrapper() { const module = {}; module.exports = {}; }',
    'function wrapper() { { module.exports = {}; let module; } }',
    'function wrapper({ receiver: module }) { module.exports = {}; }',
    'const module = {}; module.exports = { alpha() {} };',
    "import module from './other'; module.exports = {};",
    "import { receiver as exports } from './other'; exports.alpha = 1;",
    "import * as module from './other'; module.exports = {};",
    'const wrapper = function module() { module.exports = {}; };',
    'for (const exports of values) { exports.x = 1; }',
    'for (const module of values) { module.exports = {}; }',
  ])('ignores a shadowed CommonJS receiver: %s', (source) => {
    for (const [emit, file] of [
      [emitJsScopeCaptures, 'x.js'],
      [emitTsScopeCaptures, 'x.ts'],
    ] as const) {
      const v = verdicts(
        emit,
        `${source}\nexport function publicApi() {}\nfunction hidden() {}`,
        file,
      );
      expect(v.publicApi).toBe('true');
      expect(v.hidden).toBe('false');
    }
  });

  it('retains real CommonJS writes inside an unshadowed wrapper', () => {
    const v = verdicts(
      emitJsScopeCaptures,
      'function wrapper() { module.exports = {}; }\nfunction hidden() {}',
      'x.js',
    );
    expect(v.hidden).toBeUndefined();
  });

  it('an imported source name does not shadow a different local alias', () => {
    const v = verdicts(
      emitJsScopeCaptures,
      "import { module as other } from './other'; module.exports = {}; function hidden() {}",
      'x.js',
    );
    expect(v.hidden).toBeUndefined();
  });

  it.each(["module['exports']", 'module["exports"]'])(
    'recognizes %s object methods and properties as exports',
    (target) => {
      const v = verdicts(
        emitJsScopeCaptures,
        `function helper() {}\n${target} = { alpha() { return 1; }, beta: () => 2 };\n`,
        'lib.js',
      );
      expect(v.alpha).toBe('true');
      expect(v.beta).toBe('true');
      expect(v.helper).toBeUndefined();
    },
  );

  it('does not confuse dynamic or unrelated module subscripts with exports', () => {
    for (const target of ['module[key]', "module['other']"]) {
      const v = verdicts(emitJsScopeCaptures, `${target} = {};\nfunction hidden() {}`, 'lib.js');
      expect(v.hidden).toBe('false');
    }
  });

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

/** Names whose declaration captures carry `@declaration.is-default-export`. */
function defaultExports(emit: Emit, src: string, filePath: string): string[] {
  const names = emit(src, filePath).flatMap((m) =>
    m['@declaration.is-default-export']?.text === 'true'
      ? [m['@declaration.name']?.text ?? '']
      : [],
  );
  return [...new Set(names)].sort();
}

const BOTH_EMITTERS = [
  [emitTsScopeCaptures, 'x.ts'],
  [emitJsScopeCaptures, 'x.js'],
] as const;

describe('@declaration.is-default-export (#3956)', () => {
  it('marks a default-exported declaration but not its members or nested functions', () => {
    for (const [emit, file] of BOTH_EMITTERS) {
      expect(defaultExports(emit, 'export default class Foo { bar() {} }', file)).toEqual(['Foo']);
      expect(
        defaultExports(emit, 'export default function Child() { function inner() {} }', file),
      ).toEqual(['Child']);
    }
  });

  it('marks the top-level local named by `export default X` and `export { X as default }`', () => {
    for (const [emit, file] of BOTH_EMITTERS) {
      expect(defaultExports(emit, 'const X = () => 1;\nexport default X;', file)).toEqual(['X']);
      expect(defaultExports(emit, 'function h() {}\nexport { h as default };', file)).toEqual([
        'h',
      ]);
    }
  });

  it('marks nothing for named exports, re-exports from another module, or member defaults', () => {
    for (const [emit, file] of BOTH_EMITTERS) {
      expect(
        defaultExports(emit, 'export function Named() {}\nconst Y = 1;\nexport { Y };', file),
      ).toEqual([]);
      expect(
        defaultExports(emit, "export { X as default } from './c';\nfunction X() {}", file),
      ).toEqual([]);
      expect(defaultExports(emit, 'export default { fetch() {} };', file)).toEqual([]);
    }
  });

  it('marks no default when two different locals are both named as the default', () => {
    for (const [emit, file] of BOTH_EMITTERS) {
      expect(
        defaultExports(
          emit,
          'function a() {}\nfunction b() {}\nexport { a as default };\nexport { b as default };',
          file,
        ),
      ).toEqual([]);
    }
  });

  it('leaves TS `export =` unmarked (interop-dependent, deferred)', () => {
    expect(defaultExports(emitTsScopeCaptures, 'function f() {}\nexport = f;', 'x.ts')).toEqual([]);
  });

  it('marks the synthesized default-export HOC declaration in both emitters', () => {
    for (const [emit, file] of [
      [emitJsScopeCaptures, 'Widget.jsx'],
      [emitTsScopeCaptures, 'Widget.tsx'],
    ] as const) {
      const captures = emit('export default memo(() => <div />);', file).filter(
        (capture) => capture['@declaration.function'] !== undefined,
      );
      expect(captures.length).toBeGreaterThan(0);
      expect(
        captures.every((capture) => capture['@declaration.is-default-export']?.text === 'true'),
      ).toBe(true);
    }
  });

  it('lands on SymbolDefinition.isDefaultExport only for the top-level default', () => {
    const parsed = extract(
      emitTsScopeCaptures(
        'function outer() { function X() {} }\nconst X = () => 1;\nexport default X;\nexport function other() {}\n',
        'x.ts',
      ),
      'x.ts',
      typescriptProvider,
    );
    const xs = parsed.localDefs.filter((d) => d.qualifiedName === 'X');
    expect(xs.map((d) => d.isDefaultExport === true).sort()).toEqual([false, true, true]);
    const other = parsed.localDefs.find((d) => d.qualifiedName === 'other')!;
    expect('isDefaultExport' in other).toBe(false);
  });
});

describe('CommonJS callable default exports', () => {
  it.each([
    ['x.cjs', emitJsScopeCaptures, javascriptProvider],
    ['x.cts', emitTsScopeCaptures, typescriptProvider],
  ] as const)(
    'recognizes a bare wrapper export without other declarations in %s',
    (file, emit, provider) => {
      const source = 'module.exports = function candidate() {};';
      const { localDefs } = extract(emit(source, file), file, provider);
      expect(localDefs.find((def) => def.qualifiedName === 'candidate')).toMatchObject({
        isExported: true,
        isDefaultExport: true,
      });
    },
  );

  it.each([
    ['x.js', 'const module = {};', false],
    ['x.js', String.raw`const m\u006fdule = {};`, false],
    ['x.cjs', 'var module = {};', false],
    ['x.cjs', 'var module;', true],
    ['x.cjs', 'var module = module;', true],
    ['x.cjs', 'function module() {}', false],
    ['x.cjs', '{ const module = {}; module.exports = function inner() {}; }', true],
    [
      'x.cjs',
      'class C { static { var module = {}; module.exports = function inner() {}; } }',
      true,
    ],
    [
      'x.cjs',
      'function nested(module) { module.exports = function inner() {}; } nested({});',
      true,
    ],
  ] as const)('uses the wrapper binding in %s after %s', (file, prefix, exported) => {
    const source = `${prefix}\nmodule.exports = function candidate() {};`;
    const { localDefs } = extract(emitJsScopeCaptures(source, file), file, javascriptProvider);
    const candidate = localDefs.find((def) => def.qualifiedName === 'candidate');
    expect(candidate?.isExported).toBe(exported);
    expect(candidate?.isDefaultExport === true).toBe(exported);
    expect(localDefs.filter((def) => def.isDefaultExport).map((def) => def.qualifiedName)).toEqual(
      exported ? ['candidate'] : [],
    );
  });

  describe.each([
    ['x.cjs', emitJsScopeCaptures, javascriptProvider],
    ['x.cts', emitTsScopeCaptures, typescriptProvider],
  ] as const)('wrapper writes in %s', (file, emit, provider) => {
    it.each([
      ['{ module = {}; }', undefined],
      ['module = (module);', 'candidate'],
      ['const unused = (module = {}); const saved = module; module = saved;', undefined],
      ['module &&= {}; const saved = module; module = saved;', undefined],
      ['(() => { module = {}; })(); const saved = module; module = saved;', undefined],
      ['(function () { module = {}; })(); const saved = module; module = saved;', undefined],
      ['function run() { module = {}; } run(); const saved = module; module = saved;', undefined],
      ['function later() { module = {}; } const saved = module; module = saved;', 'candidate'],
      ['module ||= {}; const saved = module; module = saved;', 'candidate'],
      ['module &&= (module);', 'candidate'],
      ['const saved = module; module = undefined; module ||= saved;', 'candidate'],
      ['const saved = module; module = null; module ??= saved;', 'candidate'],
      [
        'const saved = module; (function () { module = {}; })(module = null); module ??= saved;',
        undefined,
      ],
      [
        'const saved = module; (function () { module = null; })(module = {}); module ??= saved;',
        'candidate',
      ],
      [
        'const saved = module; (() => { (() => { module = null; })(module = {}); })(module = {}); module ??= saved;',
        'candidate',
      ],
      [
        'const saved = module; (() => { module = {}; })((() => { module = null; })(module = {})); module ??= saved;',
        undefined,
      ],
      [
        '(function () { const saved = module; module = {}; module = saved; })(module = {});',
        undefined,
      ],
      [
        'const original = module; module = {}; (function () { const saved = module; module = {}; module = saved; })(module = original);',
        'candidate',
      ],
      ['const saved = module; var module = undefined; module ||= saved;', 'candidate'],
      ['const saved = module; module = false; module ||= saved;', 'candidate'],
      ['const saved = module; module = 0; module ??= saved;', undefined],
      ['const saved = module; module = ""; module &&= saved;', undefined],
      ['const saved = module; module = {}; module &&= saved;', 'candidate'],
      ['const saved = module; module = true; module ||= saved;', undefined],
      ['const saved = module; module = other; module ||= saved;', undefined],
      [
        'const saved = module; (function(undefined) { module = undefined; })({}); module ||= saved;',
        undefined,
      ],
      [
        'const saved = module; module = {}; if (false) { var module = null; } module ??= saved;',
        undefined,
      ],
      [
        'const saved = module; module = null; module || (module = {}); module ??= saved;',
        undefined,
      ],
      ['function fallback() { module ||= {}; } fallback();', 'candidate'],
      ['var module = module || {};', 'candidate'],
      ['const saved = module; if (flag) module = null; module ??= saved;', 'candidate'],
      [
        'const saved = module; const undefined = {}; module = undefined; module ||= saved;',
        undefined,
      ],
      ['const saved = module; module = {}; let fn; fn?.(module = saved);', undefined],
      ['{ module = module || {}; }', 'candidate'],
      ['const saved = module; { module = saved; }', 'candidate'],
      ['const saved = module; { module = {}; module = saved; }', 'candidate'],
      ['const saved = module; var module = {}; { module = saved; }', 'candidate'],
      ['{ const saved = module; module = {}; module = saved; }', 'candidate'],
      ['const saved = module; { const saved = {}; module = saved; }', undefined],
      ['{ module = {}; } const saved = module; { module = saved; }', undefined],
      ['const saved = module; { module = {}; module = saved; module = {}; }', undefined],
      ['let saved = module; saved = {}; { module = saved; }', undefined],
      ['var module = (/*same*/ (module));', 'candidate'],
      ['{ let module; { module = {}; } }', 'candidate'],
      ['function later() { module = {}; }', 'candidate'],
      ['if (false) { module = {}; }', 'candidate'],
      ['if (true) { module = {}; } const saved = module; { module = saved; }', undefined],
      ['const saved = module; { module = {}; module = saved; } if (true) module = {};', undefined],
      ['const saved = module; if (flag) module = saved;', 'candidate'],
      ['const saved = module; module = {}; if (flag) module = saved;', undefined],
      ['module.exports = function prior() {}; { { module = {}; } }', 'prior'],
    ])('publishes the correct default after %s', (prefix, expected) => {
      const source = `${prefix} module.exports = function candidate() {};`;
      const exports = typescriptModuleExports(extract(emit(source, file), file, provider));
      expect(exports.get('default')?.qualifiedName).toBe(expected);
    });
  });

  it.each([
    ['function late() { module = {}; }', 'late();', true],
    ['', 'late(); function late() { module = {}; }', true],
    ['const late = () => { module = {}; };', 'late();', true],
    ['late(); function late() { module = {}; }', '', false],
    ['run(); function late() { module = {}; }', 'function run() { late(); }', false],
    ['const callback = late; callback(); function late() { module = {}; }', '', false],
  ] as const)(
    'preserves exports established before a deferred write in %s %s',
    (before, after, expected) => {
      const source = `${before} module.exports = function visible() {}; ${after} module.exports = function hidden() {};`;
      for (const [emit, file] of [
        [emitJsScopeCaptures, 'late.cjs'],
        [emitTsScopeCaptures, 'late.cts'],
      ] as const) {
        const marked = emit(source, file)
          .filter((capture) => capture['@declaration.is-default-export']?.text === 'true')
          .map((capture) => capture['@declaration.name'].text);
        expect(marked).toEqual(expected ? ['visible'] : []);
      }
    },
  );

  it.each([
    ['', '(async () => { await Promise.resolve(); module = {}; })();', 'candidate'],
    [
      '',
      '(async () => { await 0; module = {}; })(); function edit(a) { a[0]++; delete a["old"]; ({entry: a[1]} = {}); }',
      'candidate',
    ],
    [
      '',
      '(async () => { await 0; module = {}; })(); const m = module; function edit() { [m["exports"]] = []; }',
      undefined,
    ],
    [
      '',
      '(async () => { await 0; module = {}; })(); function edit(m, key) { delete m[key]; }',
      undefined,
    ],
    ['', '(async () => { module = {}; await 0; })();', 'candidate'],
    ['(async () => { module = {}; await 0; })();', '', undefined],
    ['start();', 'function start() { (async () => { module = {}; })(); }', undefined],
    [
      '',
      '(async () => { await 0; module = {}; })(); { module.exports = function other() {}; }',
      undefined,
    ],
    [
      '',
      '(async (module) => { await 0; module = {}; module.exports = function other() {}; })({});',
      'candidate',
    ],
    [
      'module.exports = function earlier() {}; (async () => { if (globalThis.flag) await 0; module = {}; })();',
      '',
      undefined,
    ],
  ])('bounds an async IIFE wrapper write by its call in %s %s', (before, after, expected) => {
    const source = `${before} module.exports = function candidate() {}; ${after}`;
    for (const [emit, file, provider] of [
      [emitJsScopeCaptures, 'x.cjs', javascriptProvider],
      [emitTsScopeCaptures, 'x.cts', typescriptProvider],
    ] as const) {
      const exports = typescriptModuleExports(extract(emit(source, file), file, provider));
      expect(exports.get('default')?.qualifiedName).toBe(expected);
    }
  });

  it.each(['var module = {};', 'module = {};'])('applies %s at its write position', (write) => {
    const file = 'x.cjs';
    const source = `module.exports = function visible() {};\n${write}\nmodule.exports = function privateFn() {};`;
    const { localDefs } = extract(emitJsScopeCaptures(source, file), file, javascriptProvider);
    const visible = localDefs.find((def) => def.qualifiedName === 'visible');
    expect(visible).toMatchObject({ isExported: true, isDefaultExport: true });
    const privateFn = localDefs.find((def) => def.qualifiedName === 'privateFn');
    expect(privateFn?.isExported).toBe(false);
    expect(privateFn?.isDefaultExport).toBeUndefined();
  });
});

describe('SymbolDefinition.isExported through the extractor', () => {
  it('lands as a tri-state field: true / false / absent', () => {
    const esm = extract(
      emitTsScopeCaptures('export function a() {}\nfunction b() {}\n', 'x.ts'),
      'x.ts',
      typescriptProvider,
    );
    const byName = new Map(esm.localDefs.map((d) => [d.qualifiedName, d.isExported]));
    expect(byName.get('a')).toBe(true);
    expect(byName.get('b')).toBe(false);
    const cjs = extract(
      emitTsScopeCaptures('function a() {}\nmodule.exports = a;\n', 'y.ts'),
      'y.ts',
      typescriptProvider,
    );
    expect(cjs.localDefs.find((d) => d.qualifiedName === 'a')?.isExported).toBeUndefined();
    expect('isExported' in cjs.localDefs.find((d) => d.qualifiedName === 'a')!).toBe(false);
  });
});

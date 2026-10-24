/**
 * Locks the pure-JS category classifier (U5, KTD11): which `test/unit` files a mutation run may
 * use without native code, workers, child processes, or file reads that a prepared copy would
 * break. Real-repo cases run against the checkout; synthetic cases build a small repo in a temp
 * directory (`gitnexus/`, `gitnexus-shared/`, `node_modules/`) and classify one test file in it.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  classify,
  renderSummary,
  type Classification,
  type FileVerdict,
} from '../../../tools/mutation/classify/classify.js';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

// ── Real repo ──────────────────────────────────────────────────────────────

const REAL_ACCEPTED = [
  'test/unit/shared-type-extractors.test.ts',
  'test/unit/extract-element-type-from-string.test.ts',
  'test/unit/schema.test.ts',
];

const REAL_REJECTED: readonly (readonly [file: string, reason: string])[] = [
  ['test/unit/receiver-twin-list-drift.test.ts', 'reads source outside gitnexus/'],
  ['test/unit/type-env.test.ts', 'native package: tree-sitter'],
  ['test/unit/node-module-compat.test.ts', 'spawns processes: child_process'],
  // Found by gate 1's runtime load check: commander loads node:child_process when imported.
  ['test/unit/cli-command-banner.test.ts', 'spawns processes: child_process'],
];

let realResult: Classification | undefined;
const real = (): Classification =>
  (realResult ??= classify({
    repoRoot: REPO_ROOT,
    testFiles: [...REAL_ACCEPTED, ...REAL_REJECTED.map(([file]) => file)],
  }));

const verdictIn = (result: Classification, file: string): FileVerdict | undefined =>
  result.files.find((verdict) => verdict.file === file);

describe('classify on the real repo', () => {
  it.each(REAL_ACCEPTED)('accepts %s', (file) => {
    expect(verdictIn(real(), file)).toMatchObject({ status: 'accepted', reasons: [] });
  });

  it.each(REAL_REJECTED)('rejects %s with "%s"', (file, reason) => {
    expect(verdictIn(real(), file)?.status).toBe('rejected');
    expect(verdictIn(real(), file)?.reasons).toContain(reason);
  });

  it('finds child_process in node-module-compat through the dynamic import of runtime-install', () => {
    const evidence = verdictIn(real(), 'test/unit/node-module-compat.test.ts')?.evidence.find(
      (entry) => entry.reason === 'spawns processes: child_process',
    );
    expect(evidence).toMatchObject({
      module: 'gitnexus/src/core/embeddings/runtime-install.ts',
      via: [
        'gitnexus/test/unit/node-module-compat.test.ts',
        'gitnexus/src/core/embeddings/runtime-install.ts',
      ],
    });
  });

  it('resolves the gitnexus-shared alias into gitnexus-shared/src for schema.test.ts', () => {
    expect(verdictIn(real(), 'test/unit/schema.test.ts')?.closure).toContain(
      'gitnexus-shared/src/lbug/schema-constants.ts',
    );
  });
});

// ── Synthetic repos ────────────────────────────────────────────────────────

const BASE_FILES: Readonly<Record<string, string>> = {
  'gitnexus/package.json': '{ "name": "gitnexus", "type": "module" }\n',
  'gitnexus-shared/package.json': JSON.stringify({
    name: 'gitnexus-shared',
    type: 'module',
    exports: {
      '.': { types: './dist/index.d.ts', default: './dist/index.js' },
      './test-helpers': { types: './dist/test-helpers.d.ts', default: './dist/test-helpers.js' },
    },
  }),
  'gitnexus-shared/src/index.ts': "export { SHARED } from './constants.js';\n",
  'gitnexus-shared/src/constants.ts': "export const SHARED = 'shared';\n",
  'gitnexus-shared/src/test-helpers.ts': 'export const helper = (): number => 1;\n',
  'gitnexus/src/pure.ts': 'export const add = (a: number, b: number): number => a + b;\n',
  'gitnexus/src/x.ts': 'export const x = 1;\n',
  'gitnexus/src/spawn.ts':
    "import { execFileSync } from 'node:child_process';\nexport const run = () => execFileSync('true');\n",
  'gitnexus/node_modules/native-addon/package.json':
    '{ "name": "native-addon", "main": "index.js" }',
  'gitnexus/node_modules/native-addon/index.js':
    "module.exports = require('./build/Release/a.node');\n",
  'gitnexus/node_modules/native-addon/build/Release/a.node': 'binary',
  'gitnexus/node_modules/gyp-addon/package.json': '{ "name": "gyp-addon", "main": "index.js" }',
  'gitnexus/node_modules/gyp-addon/binding.gyp': '{}',
  'gitnexus/node_modules/gyp-addon/index.js': 'module.exports = {};\n',
  'gitnexus/node_modules/wrapper/package.json':
    '{ "name": "wrapper", "main": "index.js", "dependencies": { "native-addon": "1.0.0" } }',
  'gitnexus/node_modules/wrapper/index.js': 'module.exports = {};\n',
  'gitnexus/node_modules/plain-js/package.json':
    '{ "name": "plain-js", "main": "index.js", "dependencies": { "missing-optional": "1.0.0" } }',
  'gitnexus/node_modules/plain-js/index.js': 'module.exports = {};\n',
};

const TEST_FILE = 'test/unit/a.test.ts';
const TEST_PATH = `gitnexus/${TEST_FILE}`;

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function makeRepo(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'gitnexus-classify-'));
  roots.push(root);
  for (const [relative, text] of Object.entries({ ...BASE_FILES, ...files })) {
    const absolute = path.join(root, relative);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, text);
  }
  return root;
}

/** Classifies the single test file `gitnexus/test/unit/a.test.ts` of a synthetic repo. */
function classifyTest(
  testSource: string,
  extra: Readonly<Record<string, string>> = {},
): FileVerdict {
  const root = makeRepo({ ...extra, [TEST_PATH]: testSource });
  return classify({ repoRoot: root, testFiles: [TEST_FILE] }).files[0];
}

const NODE_IMPORTS = [
  "import { readFileSync, mkdtempSync } from 'node:fs';",
  "import os from 'node:os';",
  "import path from 'node:path';",
  "import { fileURLToPath } from 'node:url';",
  "import { it, expect, vi } from 'vitest';",
].join('\n');

const withTest = (body: string): string =>
  `${NODE_IMPORTS}\n${body}\nit('t', () => expect(1).toBe(1));\n`;

const CREATE_REQUIRE_LOADER = (specifier: string, base = 'import.meta.url'): string =>
  [
    "import { createRequire } from 'node:module';",
    `const require = createRequire(${base});`,
    `export const binding = require(${specifier});`,
  ].join('\n');

const REJECTIONS: readonly (readonly [
  label: string,
  testSource: string,
  extra: Readonly<Record<string, string>>,
  reason: string,
])[] = [
  [
    'reads src/x.ts as text through __dirname',
    withTest("const text = readFileSync(path.join(__dirname, '../../src/x.ts'), 'utf8');"),
    {},
    'reads source under src/',
  ],
  [
    'reads src/x.ts as text through import.meta.url',
    withTest("const text = readFileSync(new URL('../../src/x.ts', import.meta.url), 'utf8');"),
    {},
    'reads source under src/',
  ],
  [
    'reads src/x.ts by a cwd-relative literal path',
    withTest("const text = readFileSync('src/x.ts', 'utf8');"),
    {},
    'reads source under src/',
  ],
  [
    'reads src/x.ts through const-bound roots',
    withTest(
      [
        'const here = path.dirname(fileURLToPath(import.meta.url));',
        "const ROOT = path.resolve(here, '..', '..');",
        "const text = readFileSync(path.join(ROOT, 'src', 'x.ts'), 'utf8');",
      ].join('\n'),
    ),
    {},
    'reads source under src/',
  ],
  [
    'reads src/x.ts through a function-local require of path behind a type assertion',
    withTest(
      [
        "it('reads', () => {",
        "  const p = require('node:path') as typeof import('node:path');",
        "  const fsLocal = require('node:fs') as typeof import('node:fs');",
        "  const source = fsLocal.readFileSync(p.resolve(__dirname, '../../src/x.ts'), 'utf8');",
        '  expect(source).toBeTruthy();',
        '});',
      ].join('\n'),
    ),
    {},
    'reads source under src/',
  ],
  [
    'reads src/x.ts through a name that another function binds differently',
    withTest(
      [
        'export function temp() {',
        '  const here = os.tmpdir();',
        "  return readFileSync(path.join(here, 'a.txt'), 'utf8');",
        '}',
        'export function source() {',
        '  const here = path.dirname(fileURLToPath(import.meta.url));',
        "  return readFileSync(path.resolve(here, '../../src/x.ts'), 'utf8');",
        '}',
      ].join('\n'),
    ),
    {},
    'reads source under src/',
  ],
  [
    'names a file under src/ with an unknown name',
    withTest(
      "export const read = (name: string) => readFileSync(path.join(__dirname, '../../src', name));",
    ),
    {},
    'reads source under src/',
  ],
  [
    'reads test fixtures',
    withTest("const text = readFileSync(path.join(__dirname, '../fixtures/repo/a.ts'), 'utf8');"),
    {},
    'reads test fixtures',
  ],
  [
    'reads a file outside gitnexus/',
    withTest(
      "const text = readFileSync(path.join(__dirname, '../../../gitnexus-shared/src/index.ts'), 'utf8');",
    ),
    {},
    'reads source outside gitnexus/',
  ],
  [
    'names the package root with an unknown suffix',
    withTest(
      "export const read = (name: string) => readFileSync(path.join(__dirname, '../..', name));",
    ),
    {},
    'unresolvable file path',
  ],
  [
    'concatenates an unknown suffix onto the package root',
    withTest("export const read = (name: string) => readFileSync(process.cwd() + name, 'utf8');"),
    {},
    'unresolvable file path',
  ],
  [
    'loads a native package through createRequire in a production module',
    withTest("import { binding } from '../../src/loader.js';\nconsole.log(binding);"),
    { 'gitnexus/src/loader.ts': CREATE_REQUIRE_LOADER("'native-addon'") },
    'native package: native-addon',
  ],
  [
    'loads a local .node binding through createRequire',
    withTest("import { binding } from '../../src/loader.js';\nconsole.log(binding);"),
    {
      'gitnexus/src/loader.ts': CREATE_REQUIRE_LOADER("'./addon.node'"),
      'gitnexus/src/addon.node': 'binary',
    },
    'native binding: gitnexus/src/addon.node',
  ],
  [
    'imports a package that depends on a native package',
    withTest("import wrapper from 'wrapper';\nconsole.log(wrapper);"),
    {},
    'native package: native-addon',
  ],
  [
    'imports a package with binding.gyp',
    withTest("import gyp from 'gyp-addon';\nconsole.log(gyp);"),
    {},
    'native package: gyp-addon',
  ],
  [
    'imports a package known to load child_process when imported',
    withTest("import { Command } from 'commander';\nconsole.log(new Command());"),
    {},
    'spawns processes: child_process',
  ],
  [
    'imports a known native package that is not installed',
    withTest("import Parser from 'tree-sitter';\nconsole.log(new Parser());"),
    {},
    'native package: tree-sitter',
  ],
  [
    'mocks a native package with a factory that receives importOriginal',
    withTest(
      "vi.mock('tree-sitter', async (importOriginal) => ({ ...(await importOriginal<object>()) }));",
    ),
    {},
    'native package: tree-sitter',
  ],
  [
    'imports a computed specifier',
    withTest('export const load = (name: string) => import(name);'),
    {},
    'unresolvable dynamic import',
  ],
  [
    'imports a template specifier with an expression',
    withTest('export const load = (name: string) => import(`../../src/${name}.js`);'),
    {},
    'unresolvable dynamic import',
  ],
  [
    'requires a computed specifier in a production module',
    withTest("import { binding } from '../../src/loader.js';\nconsole.log(binding);"),
    { 'gitnexus/src/loader.ts': 'export const binding = (name: string) => require(name);\n' },
    'unresolvable dynamic import',
  ],
  [
    'requires a relative specifier through createRequire with an unknown base',
    withTest("import { binding } from '../../src/loader.js';\nconsole.log(binding);"),
    { 'gitnexus/src/loader.ts': CREATE_REQUIRE_LOADER("'./x.js'", 'process.argv[1]') },
    'unresolvable dynamic import',
  ],
  [
    'loads a computed specifier through vi.importActual',
    withTest('export const load = (name: string) => vi.importActual(name);'),
    {},
    'unresolvable dynamic import',
  ],
  [
    'reaches child_process through a const-bound dynamic import',
    withTest("const MOD = '../../src/spawn.js';\nexport const load = () => import(MOD);"),
    {},
    'spawns processes: child_process',
  ],
  [
    'imports Worker from worker_threads',
    withTest("import { Worker } from 'node:worker_threads';\nconsole.log(Worker);"),
    {},
    'spawns workers: worker_threads',
  ],
  [
    'imports a module outside gitnexus/ by a relative path',
    withTest(
      "import { SHARED } from '../../../gitnexus-shared/src/index.js';\nconsole.log(SHARED);",
    ),
    {},
    'imports outside gitnexus/',
  ],
  [
    'imports a module from test/fixtures',
    withTest("import { fixture } from '../fixtures/data.js';\nconsole.log(fixture);"),
    { 'gitnexus/test/fixtures/data.ts': 'export const fixture = 1;\n' },
    'imports from ignored dir: test/fixtures/',
  ],
  [
    'imports a missing relative module',
    withTest("import { missing } from '../../src/missing.js';\nconsole.log(missing);"),
    {},
    'unresolved import: ../../src/missing.js',
  ],
];

const ACCEPTANCES: readonly (readonly [
  label: string,
  testSource: string,
  extra: Readonly<Record<string, string>>,
])[] = [
  [
    'a production closure that imports fs while the test reads no files',
    withTest("import { add } from '../../src/io.js';\nconsole.log(add(1, 2));"),
    {
      'gitnexus/src/io.ts': [
        "import { readFileSync } from 'node:fs';",
        "export const read = (file: string) => readFileSync(file, 'utf8');",
        'export const add = (a: number, b: number) => a + b;',
      ].join('\n'),
    },
  ],
  [
    'a test that reads files in its own temp directory',
    withTest(
      [
        "const dir = mkdtempSync(path.join(os.tmpdir(), 'x-'));",
        "export const text = () => readFileSync(path.join(dir, 'a.txt'), 'utf8');",
      ].join('\n'),
    ),
    {},
  ],
  [
    'a test that reads a data file next to itself',
    withTest("const data = readFileSync(path.join(__dirname, 'data.json'), 'utf8');"),
    { 'gitnexus/test/unit/data.json': '{}' },
  ],
  [
    'a path concatenated from process.cwd() and path.sep',
    withTest("const pkg = readFileSync(process.cwd() + path.sep + 'package.json', 'utf8');"),
    {},
  ],
  [
    'type-only and type-position imports of native packages',
    withTest(
      [
        "import type Parser from 'tree-sitter';",
        "import { type Language } from 'tree-sitter-typescript';",
        "import { SyntaxNode } from 'tree-sitter';",
        'let node: SyntaxNode | Parser | Language | undefined;',
        'console.log(node);',
      ].join('\n'),
    ),
    {},
  ],
  [
    'worker_threads imported without Worker',
    withTest("import { isMainThread } from 'node:worker_threads';\nconsole.log(isMainThread);"),
    {},
  ],
  [
    'a native package mocked with a factory that does not load the original',
    withTest("vi.mock('tree-sitter', () => ({ default: class {} }));"),
    {},
  ],
  [
    'a const-bound dynamic import of a pure module',
    withTest("const MOD = '../../src/pure.js';\nexport const load = () => import(MOD);"),
    {},
  ],
  [
    'a package whose missing dependency is not installed',
    withTest("import plain from 'plain-js';\nconsole.log(plain);"),
    {},
  ],
  [
    'the gitnexus-shared aliases',
    withTest(
      [
        "import { SHARED } from 'gitnexus-shared';",
        "import { helper } from 'gitnexus-shared/test-helpers';",
        'console.log(SHARED, helper);',
      ].join('\n'),
    ),
    {},
  ],
];

describe('classify on synthetic repos', () => {
  it.each(REJECTIONS)('rejects a test that %s', (_label, testSource, extra, reason) => {
    const verdict = classifyTest(testSource, extra);
    expect(verdict.status).toBe('rejected');
    expect(verdict.reasons).toContain(reason);
  });

  it.each(ACCEPTANCES)('accepts %s', (_label, testSource, extra) => {
    expect(classifyTest(testSource, extra)).toMatchObject({ status: 'accepted', reasons: [] });
  });

  it('records the local closure, packages and builtins of an accepted file', () => {
    const verdict = classifyTest(
      withTest(
        [
          "import { SHARED } from 'gitnexus-shared';",
          "import plain from 'plain-js';",
          "const MOD = '../../src/pure.js';",
          'export const load = () => import(MOD);',
          'console.log(SHARED, plain, path.sep);',
        ].join('\n'),
      ),
    );
    expect(verdict.closure).toEqual([
      'gitnexus-shared/src/constants.ts',
      'gitnexus-shared/src/index.ts',
      'gitnexus/src/pure.ts',
      TEST_PATH,
    ]);
    expect(verdict.packages).toEqual(['plain-js', 'vitest']);
    expect(verdict.builtins).toEqual(['path']);
  });

  it('gives each rejection reason its module, line and import chain', () => {
    const verdict = classifyTest(
      withTest("import { load } from '../helpers/load.js';\nconsole.log(load);"),
      { 'gitnexus/test/helpers/load.ts': "export { run as load } from '../../src/spawn.js';\n" },
    );
    expect(verdict.evidence).toEqual([
      {
        reason: 'spawns processes: child_process',
        module: 'gitnexus/src/spawn.ts',
        line: 1,
        detail: 'imports node:child_process',
        via: [TEST_PATH, 'gitnexus/test/helpers/load.ts', 'gitnexus/src/spawn.ts'],
      },
    ]);
  });

  it('counts hooks, each-calls and test call sites of the test file', () => {
    const verdict = classifyTest(
      [
        "import { beforeAll, describe, it, expect } from 'vitest';",
        'let n = 0;',
        'beforeAll(() => { n = 1; });',
        "describe('d', () => {",
        '  beforeAll(() => { n += 1; });',
        "  it('one', () => expect(n).toBe(2));",
        "  it.each([1, 2])('row %i', (v) => expect(v).toBeGreaterThan(0));",
        '});',
      ].join('\n'),
    );
    expect(verdict).toMatchObject({
      status: 'accepted',
      hooks: { beforeAll: 2, beforeEach: 0, afterAll: 0, afterEach: 0 },
      eachCalls: 1,
      testCalls: 2,
    });
  });
});

describe('classify over a test root', () => {
  const root = (): string =>
    makeRepo({
      'gitnexus/test/unit/b.test.ts': withTest(
        "import { add } from '../../src/pure.js';\nadd(1, 2);",
      ),
      'gitnexus/test/unit/nested/c.test.ts': withTest(
        "import { run } from '../../../src/spawn.js';\nbeforeAll(() => run());",
      ),
      'gitnexus/test/unit/hooks.test.ts': withTest(
        "import { add } from '../../src/pure.js';\nbeforeAll(() => add(1, 2));",
      ),
      'gitnexus/test/unit/helper.ts': 'export const h = 1;\n',
    });

  it('lists every *.test.ts file under the root, sorted, and groups the verdicts', () => {
    const result = classify({ repoRoot: root(), testRoot: 'test/unit' });
    expect(result.files.map((verdict) => verdict.file)).toEqual([
      'test/unit/b.test.ts',
      'test/unit/hooks.test.ts',
      'test/unit/nested/c.test.ts',
    ]);
    expect(result.accepted).toEqual(['test/unit/b.test.ts', 'test/unit/hooks.test.ts']);
    expect(result.rejected).toEqual([
      { file: 'test/unit/nested/c.test.ts', reasons: ['spawns processes: child_process'] },
    ]);
    expect(result.acceptedWithBeforeAll).toEqual(['test/unit/hooks.test.ts']);
    expect(result.summary).toEqual({
      total: 3,
      accepted: 2,
      rejected: 1,
      byReason: { 'spawns processes: child_process': 1 },
      byCategory: { 'spawns processes': 1 },
    });
  });

  it('is deterministic across runs and renders a summary', () => {
    const repo = root();
    const first = classify({ repoRoot: repo, testRoot: 'test/unit' });
    expect(classify({ repoRoot: repo, testRoot: 'test/unit' })).toEqual(first);
    expect(renderSummary(first)).toContain('3 test files: 2 accepted, 1 rejected');
  });
});

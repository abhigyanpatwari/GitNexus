/**
 * Locks the advisory duplicate-test scan (tools/test-dupes/test-dupes.ts) that CI posts in the
 * sticky PR comment. The false-positive table pins every case the 2026-10 audit found
 * where an identical `it` body tested something different.
 */
import type { ExpressionStatement } from '@babel/types';
import { describe, it, expect } from 'vitest';
import {
  dupeOkReason,
  extract,
  extractCases,
  orphanBenchGates,
  parseUnifiedDiff,
  scan,
  suppressed,
  type Finding,
  type SourceFile,
  type Touched,
} from '../../tools/test-dupes/test-dupes.js';

const UNIT = 'gitnexus/test/unit';
const file = (path: string, ...lines: string[]): SourceFile => ({ path, source: lines.join('\n') });
const touch = (...paths: string[]): Touched => new Map(paths.map((p) => [p, 'all' as const]));
const summary = (findings: Finding[]): string[] =>
  findings.map(
    (f) =>
      `${f.kind} ${f.file}:${f.line} -> ${f.matches.map((m) => `${m.file}:${m.line}`).join(',')}`,
  );

/** One test file whose single case sits on line 3, inside `describe`. */
const suite = (path: string, header: string, body: string, title = 't'): SourceFile =>
  file(path, header, `describe('d', () => {`, `  it('${title}', () => { ${body} });`, `});`);

describe('same-test', () => {
  it('flags a case whose body and setup match a test in another file', () => {
    const header = `import { parseThing } from '../../src/thing.js';`;
    const body = `expect(parseThing('x').kind).toBe('y');`;
    const files = [
      suite(`${UNIT}/a.test.ts`, header, body, 'parses'),
      suite(`${UNIT}/b.test.ts`, header, body, 'parses x into y'),
    ];
    expect(summary(scan(files, touch(`${UNIT}/b.test.ts`)).findings)).toEqual([
      `same-test ${UNIT}/b.test.ts:3 -> ${UNIT}/a.test.ts:3`,
    ]);
  });

  it.each([
    [
      'file-local helpers differ (cfg snapshot serialize)',
      `function serialize(x) { return x.a; }`,
      `function serialize(x) { return x.b; }`,
      `expect(serialize(load())).toMatchSnapshot();`,
    ],
    [
      'imports resolve to different modules',
      `import { parseThing } from '../../src/a.js';`,
      `import { parseThing } from '../../src/b.js';`,
      `expect(parseThing('x').kind).toBe('y');`,
    ],
    [
      'describe-level constants differ (workflow fixture)',
      `const workflow = 'ci.yml';`,
      `const workflow = 'docker.yml';`,
      `expect(load(workflow).jobs).toBeDefined();`,
    ],
  ])('does not flag identical bodies when %s', (_name, headerA, headerB, body) => {
    const files = [
      suite(`${UNIT}/a.test.ts`, headerA, body),
      suite(`${UNIT}/b.test.ts`, headerB, body),
    ];
    expect(scan(files, touch(`${UNIT}/b.test.ts`)).findings).toEqual([]);
  });

  it.each([
    [
      'wrapper-call options differ (fts DB options)',
      `withDb('n', (db) => { it('t', () => { expect(db.count()).toBe(1); }); }, { fts: true });`,
      `withDb('n', (db) => { it('t', () => { expect(db.count()).toBe(1); }); }, { fts: false });`,
    ],
    [
      'describe-level env writes differ',
      `describe('d', () => { process.env.X = '1'; it('t', () => { expect(run()).toBe(1); }); });`,
      `describe('d', () => { process.env.X = '0'; it('t', () => { expect(run()).toBe(1); }); });`,
    ],
    [
      'loop heads differ',
      `for (const lang of ['ts']) { it('t', () => { expect(parse(lang)).toBeDefined(); }); }`,
      `for (const lang of ['py']) { it('t', () => { expect(parse(lang)).toBeDefined(); }); }`,
    ],
    [
      'each tables differ',
      `it.each([[1]])('t %s', (n) => { expect(double(n)).toBe(n * 2); });`,
      `it.each([[2]])('t %s', (n) => { expect(double(n)).toBe(n * 2); });`,
    ],
  ])('does not flag identical bodies when %s', (_name, a, b) => {
    const files = [file(`${UNIT}/a.test.ts`, a), file(`${UNIT}/b.test.ts`, b)];
    expect(scan(files, touch(`${UNIT}/b.test.ts`)).findings).toEqual([]);
  });

  it('reports only cases on touched lines', () => {
    const body = `expect(parseThing('x').kind).toBe('y');`;
    const files = [suite(`${UNIT}/a.test.ts`, '', body), suite(`${UNIT}/b.test.ts`, '', body)];
    const untouched = new Map([[`${UNIT}/b.test.ts`, new Set([1])]]);
    expect(scan(files, untouched).findings).toEqual([]);
  });

  it('honours `// dupe-ok:` on the line above the case', () => {
    const body = `expect(parseThing('x').kind).toBe('y');`;
    const files = [
      suite(`${UNIT}/a.test.ts`, '', body),
      file(
        `${UNIT}/b.test.ts`,
        `describe('d', () => {`,
        `  // dupe-ok: order-dependent control, must run after the opt-out cases`,
        `  it('t', () => { ${body} });`,
        `});`,
      ),
    ];
    expect(scan(files, touch(`${UNIT}/b.test.ts`)).findings).toEqual([]);
  });
});

describe('same-fixture-setup', () => {
  const helpers = file(
    'gitnexus/test/integration/resolvers/helpers.ts',
    `import path from 'path';`,
    `export const FIXTURES = path.resolve(__dirname, '..', '..', 'fixtures', 'lang');`,
    `export async function runPipeline(p: string) { return p; }`,
  );
  const describeWith = (hookBody: string, assertion: string, hook = 'beforeAll'): string[] => [
    `describe('d', () => {`,
    `  let r;`,
    `  ${hook}(async () => { ${hookBody} });`,
    `  it('t', () => { ${assertion} });`,
    `});`,
  ];

  it('matches a fixture path spelled locally against the same path imported from a helper', () => {
    const local = file(
      'gitnexus/test/integration/a.test.ts',
      `import path from 'path';`,
      `import { runPipeline } from './resolvers/helpers.js';`,
      `const FIXTURES = path.resolve(__dirname, '..', 'fixtures', 'lang');`,
      ...describeWith(
        `r = await runPipeline(path.join(FIXTURES, 'py'));`,
        `expect(r).toBeDefined();`,
      ),
    );
    const imported = file(
      'gitnexus/test/integration/resolvers/b.test.ts',
      `import path from 'path';`,
      `import { FIXTURES, runPipeline } from './helpers.js';`,
      ...describeWith(
        `r = await runPipeline(path.join(FIXTURES, 'py'));`,
        `expect(r).toBeTruthy();`,
      ),
    );
    expect(summary(scan([helpers, local, imported], touch(local.path)).findings)).toEqual([
      `same-fixture-setup ${local.path}:6 -> ${imported.path}:5`,
    ]);
  });

  it('keeps a beforeAll fixture apart from the same build in a beforeEach', () => {
    const suite = (path: string, hook: string): SourceFile =>
      file(
        path,
        `import path from 'path';`,
        `import { FIXTURES, runPipeline } from './helpers.js';`,
        ...describeWith(
          `r = await runPipeline(path.join(FIXTURES, 'py'));`,
          `expect(r).toBeDefined();`,
          hook,
        ),
      );
    const once = suite('gitnexus/test/integration/resolvers/a.test.ts', 'beforeAll');
    const each = suite('gitnexus/test/integration/resolvers/b.test.ts', 'beforeEach');
    expect(scan([helpers, once, each], touch(each.path)).findings).toEqual([]);
  });

  it('ignores temp dirs that are merely named fixture', () => {
    const tmp = (path: string, assertion: string): SourceFile =>
      file(
        path,
        `import { createTempDir } from '../helpers/test-db.js';`,
        ...describeWith(`fixture = await createTempDir();`, assertion),
      );
    const files = [
      tmp(`${UNIT}/a.test.ts`, `expect(1).toBe(1);`),
      tmp(`${UNIT}/b.test.ts`, `expect(2).toBe(2);`),
    ];
    expect(scan(files, touch(`${UNIT}/b.test.ts`)).findings).toEqual([]);
  });
});

describe('assertions-pinned', () => {
  it('flags a pure-expect case whose literal assertions another test already makes', () => {
    const header = `import { strip } from '../../src/strip.js';`;
    const pinned = file(
      `${UNIT}/a.test.ts`,
      header,
      `it('a', () => { expect(strip('User?')).toBe('User'); expect(strip('X')).toBe('X'); });`,
    );
    const fresh = file(
      `${UNIT}/b.test.ts`,
      header,
      `it('b', () => { expect(strip('X')).toBe('X'); });`,
      `it('c', () => { process.env.Y = '1'; expect(strip('X')).toBe('X'); });`,
      `it('d', () => { expect(strip('Z')).toBe('Z'); });`,
    );
    expect(summary(scan([pinned, fresh], touch(fresh.path)).findings)).toEqual([
      `assertions-pinned ${fresh.path}:2 -> ${pinned.path}:2`,
    ]);
  });
});

describe('copied-helper', () => {
  it('points a re-declared helper at the exported copy in test/helpers', () => {
    const fn = [
      `async function allocateFreePort(): Promise<number> {`,
      `  const server = net.createServer();`,
      `  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));`,
      `  const port = (server.address() as net.AddressInfo).port;`,
      `  await new Promise((resolve) => server.close(resolve));`,
      `  return port;`,
      `}`,
    ];
    const helper = file('gitnexus/test/helpers/net.ts', `export ${fn[0]}`, ...fn.slice(1));
    const copy = file(
      'gitnexus/test/integration/server.test.ts',
      `import net from 'node:net';`,
      ...fn,
    );
    const [finding] = scan([helper, copy], touch(copy.path)).findings;
    expect([finding.kind, finding.line, finding.detail]).toEqual([
      'copied-helper',
      2,
      'already exported from gitnexus/test/helpers/net.ts — import it',
    ]);
  });
});

describe('orphanBenchGates', () => {
  const bench = file(
    'gitnexus/bench/foo/measure.mjs',
    `import './lib.mjs';`,
    `const check = process.argv.includes('--check');`,
  );
  const lib = file('gitnexus/bench/foo/lib.mjs', `export const usage = 'measure.mjs [--check]';`);
  const touched = touch(bench.path, lib.path);

  it('flags a touched --check gate that no workflow or npm script runs', () => {
    const workflow = file(
      '.github/workflows/ci-tests.yml',
      'run: node bench/bar/measure.mjs --check',
    );
    expect(summary(orphanBenchGates([bench, lib, workflow], touched))).toEqual([
      'orphan-bench-gate gitnexus/bench/foo/measure.mjs:2 -> ',
    ]);
  });

  it.each([
    ['an unrelated line of the bench script', 1, []],
    ['the --check line itself', 2, ['orphan-bench-gate gitnexus/bench/foo/measure.mjs:2 -> ']],
  ])('reports an orphan gate only when the diff touches %s', (_label, line, expected) => {
    const workflow = file(
      '.github/workflows/ci-tests.yml',
      'run: node bench/bar/measure.mjs --check',
    );
    const lines: Touched = new Map([[bench.path, new Set([line])]]);
    expect(summary(orphanBenchGates([bench, lib, workflow], lines))).toEqual(expected);
  });

  it('accepts a gate a workflow runs and a library a sibling script imports', () => {
    const workflow = file(
      '.github/workflows/ci-tests.yml',
      'run: node bench/foo/measure.mjs --check',
    );
    expect(orphanBenchGates([bench, lib, workflow], touched)).toEqual([]);
  });
});

describe('parseUnifiedDiff', () => {
  it('collects new-side lines per file and skips pure deletions', () => {
    const diff = [
      'diff --git a/x.ts b/x.ts',
      '--- a/x.ts',
      '+++ b/x.ts',
      '@@ -1,0 +2,2 @@',
      '@@ -9 +11 @@',
      '@@ -20,3 +23,0 @@',
      '+++ /dev/null',
      '@@ -1,4 +0,0 @@',
    ].join('\n');
    expect([...parseUnifiedDiff(diff)].map(([f, lines]) => [f, [...lines]])).toEqual([
      ['x.ts', [2, 3, 11]],
    ]);
  });
});

describe('extractCases', () => {
  it('records the describe path, title, line and a setup-specific context hash per case', () => {
    const records = extractCases(
      file(
        `${UNIT}/a.test.ts`,
        `describe('outer', () => {`,
        `  beforeEach(() => { seed(1); });`,
        `  describe('inner', () => {`,
        `    beforeEach(() => { seed(2); });`,
        `    it('a', () => { expect(run()).toBe(1); });`,
        `  });`,
        `  it('b', () => { expect(run()).toBe(1); });`,
        `});`,
      ),
    );
    expect(records.map((r) => [r.file, r.describePath, r.title, r.line, r.body])).toEqual([
      [`${UNIT}/a.test.ts`, ['outer', 'inner'], 'a', 5, '{expect(run()).toBe(1);}'],
      [`${UNIT}/a.test.ts`, ['outer'], 'b', 7, '{expect(run()).toBe(1);}'],
    ]);
    expect(new Set(records.map((r) => r.contextHash)).size).toBe(2);
  });

  it('keeps the body out of the context hash: siblings under one setup share it', () => {
    const [a, b] = extractCases(
      file(
        `${UNIT}/a.test.ts`,
        `describe('d', () => {`,
        `  beforeEach(() => { seed(1); });`,
        `  it('a', () => { expect(run()).toBe(1); });`,
        `  it('b', () => { expect(run()).toBe(2); });`,
        `});`,
      ),
    );
    expect([a.contextHash === b.contextHash, a.key === b.key]).toEqual([true, false]);
  });

  it('reports a `// dupe-ok:` case as suppressed with its reason', () => {
    const records = extractCases(
      file(
        `${UNIT}/a.test.ts`,
        `describe('d', () => {`,
        `  // dupe-ok: order-dependent control`,
        `  it('t', () => { expect(run()).toBe(1); });`,
        `  it('u', () => { expect(run()).toBe(1); });`,
        `});`,
      ),
    );
    expect(records.map((r) => [r.title, r.suppressed])).toEqual([
      ['t', 'order-dependent control'],
      ['u', null],
    ]);
  });

  it.each([
    [
      'an it.each array table',
      `it.each([[1], [2]])('doubles %s', (n) => { expect(double(n)).toBe(n * 2); });`,
      { title: 'doubles %s', each: { type: 'ArrayExpression' }, loop: null },
    ],
    [
      'an it.each tagged-template table',
      "it.each`n\n${1}`('doubles $n', ({ n }) => { expect(double(n)).toBe(n * 2); });",
      { title: 'doubles $n', each: { type: 'TemplateLiteral' }, loop: null },
    ],
    [
      'a test.for table',
      `test.for([[1], [2]])('doubles %s', ([n]) => { expect(double(n)).toBe(n * 2); });`,
      { title: 'doubles %s', each: { type: 'ArrayExpression' }, loop: null },
    ],
    [
      'a skipIf condition, which is no table',
      `it.skipIf(slow)('doubles', () => { expect(double(1)).toBe(2); });`,
      { title: 'doubles', each: null, loop: null },
    ],
    [
      'an enclosing for-of loop',
      `for (const n of [1, 2]) { it('doubles', () => { expect(double(n)).toBe(n * 2); }); }`,
      { title: 'doubles', each: null, loop: { type: 'ForOfStatement' } },
    ],
  ])('returns one record with the instance source of %s', (_label, source, expected) => {
    expect(extractCases(file(`${UNIT}/a.test.ts`, source))).toMatchObject([expected]);
  });

  it('records a fixture *.case.ts file only when options.isTest accepts it, and keeps its AST', () => {
    const fixture = file('gitnexus/test/fixtures/mutation-x/a.case.ts', `it('t', () => {});`);
    const isTest = (path: string): boolean => path.endsWith('.case.ts');
    const corpus = extract([fixture], { isTest });
    expect([extractCases(fixture).length, corpus.records.length]).toEqual([0, 1]);
    const statement = corpus.asts.get(fixture.path)?.program.body[0] as
      | ExpressionStatement
      | undefined;
    expect(statement?.expression).toBe(corpus.records[0].call);
  });

  it('feeds Layer 0 exactly the unsuppressed, non-empty records under the same key', () => {
    const corpus = extract([
      file(
        `${UNIT}/a.test.ts`,
        `describe('d', () => {`,
        `  it('a', () => { expect(run()).toBe(1); });`,
        `  // dupe-ok: kept on purpose`,
        `  it('b', () => { expect(run()).toBe(1); });`,
        `  it('c', () => {});`,
        `  it('d', () => { expect(run()).toBe(2); });`,
        `});`,
      ),
    ]);
    expect(corpus.records.map((r) => r.title)).toEqual(['a', 'b', 'c', 'd']);
    expect(corpus.cases.map((c) => [c.line, c.key])).toEqual(
      corpus.records
        .filter((r) => r.suppressed === null && r.body !== '{}')
        .map((r) => [r.line, r.key]),
    );
  });
});

describe('dupeOkReason', () => {
  const lines = [
    `// dupe-ok: two lines up`,
    `const x = 1;`,
    `it('a', () => {});`,
    `// dupe-ok: shared fixture`,
    `it('b', () => {});`,
    `it('c', () => {}); // dupe-ok: trailing`,
    `it('d', () => {}); // dupe-ok:`,
  ];
  it.each([
    ['a comment two lines above, which does not count', 3, null, false],
    ['a comment on the line above', 5, 'shared fixture', true],
    ['a trailing comment on the reported line', 6, 'trailing', true],
    ['an empty trailing reason, which wins over the line above', 7, '', true],
  ])('reads %s', (_label, line, reason, isSuppressed) => {
    expect([dupeOkReason(lines, line), suppressed(lines, line)]).toEqual([reason, isSuppressed]);
  });
});

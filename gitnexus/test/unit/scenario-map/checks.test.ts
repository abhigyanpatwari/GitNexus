/**
 * Locks the Layer 2 checks of a test instance (U5, R5, KTD6, design §2 "Checks"): the shape of
 * each `expect(subject)[.not|.resolves|.rejects].matcher(args)` with literals abstracted and
 * selector literals in the subject kept exact; snapshot matchers carry the snapshot text's hash;
 * any other assertion form is unsupported with the form named; `it.each` rows and `for…of`
 * elements give per-instance checks; `checksContextKey` joins the checks with the context.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  checksContextKey,
  computeChecks,
  fsModuleReader,
  fsSnapshotReader,
  SUPPORTED_MATCHERS,
  type CheckSubject,
  type InstanceChecks,
  type ModuleReader,
  type SnapshotReader,
} from '../../../tools/scenario-map/facet/checks.js';
import { expandCases } from '../../../tools/scenario-map/inventory/cases.js';
import type { InventoryInstance, StaticCallSite } from '../../../tools/scenario-map/types.js';

const FILE = 'gitnexus/test/unit/a.test.ts';
const IMPORTS = [`import { build, fn, getNodesByLabel } from '../../src/m.js';`];

const sitesOf = (...lines: string[]): StaticCallSite[] =>
  expandCases([{ path: FILE, source: [...IMPORTS, ...lines].join('\n') }]).sites;

/** One subject per static instance, sites in walk order. */
const subjectsOf = (...lines: string[]): CheckSubject[] =>
  sitesOf(...lines).flatMap((site) =>
    (site.instances ?? []).map(
      (instance): CheckSubject => ({ record: site.record, instance, fullName: site.fullName }),
    ),
  );

const checksOf = (...lines: string[]): InstanceChecks[] =>
  subjectsOf(...lines).map((subject) => computeChecks(subject));

/** The checks of two tests written inside one describe. */
function pairChecks(first: string, second: string): [InstanceChecks, InstanceChecks] {
  const checks = checksOf(`describe('d', () => {`, first, second, `});`);
  expect(checks).toHaveLength(2);
  return [checks[0], checks[1]];
}

const shapes = (checks: InstanceChecks): string[] => checks.checks.map((check) => check.shape);

describe('computeChecks: shapes', () => {
  it.each([
    [
      'the input and expected literals',
      `it('a', () => { expect(fn('a')).toBe(1); });`,
      `it('b', () => { expect(fn('b')).toBe(2); });`,
    ],
    [
      'renamed locals',
      `it('a', () => { const graph = build(); expect(graph.size).toBe(1); });`,
      `it('b', () => { const g = build(); expect(g.size).toBe(2); });`,
    ],
    [
      'the quote style of a selector literal',
      `it('a', () => { const r = build(); expect(getNodesByLabel(r, 'Function')).toHaveLength(1); });`,
      `it('b', () => { const r = build(); expect(getNodesByLabel(r, "Function")).toHaveLength(1); });`,
    ],
    [
      'an expected value inside an asymmetric matcher',
      `it('a', () => { expect(fn('x')).toEqual(expect.objectContaining({ id: 1 })); });`,
      `it('b', () => { expect(fn('y')).toEqual(expect.objectContaining({ id: 2 })); });`,
    ],
    [
      'a thrown message',
      `it('a', () => { expect(() => fn('x')).toThrow('bad x'); });`,
      `it('b', () => { expect(() => fn('y')).toThrow('bad y'); });`,
    ],
  ])('gives the same checks to tests that differ only in %s', (_label, first, second) => {
    const [a, b] = pairChecks(first, second);
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.unsupported).toEqual([]);
  });

  it.each([
    [
      'a selector literal of the subject call',
      `it('a', () => { const r = build(); expect(getNodesByLabel(r, 'Function')).toHaveLength(1); });`,
      `it('b', () => { const r = build(); expect(getNodesByLabel(r, 'Class')).toHaveLength(1); });`,
    ],
    [
      'the not modifier',
      `it('a', () => { const x = fn('a'); expect(x).not.toBe(1); });`,
      `it('b', () => { const x = fn('a'); expect(x).toBe(1); });`,
    ],
    [
      'resolves against rejects',
      `it('a', async () => { await expect(fn('a')).resolves.toBe(1); });`,
      `it('b', async () => { await expect(fn('a')).rejects.toBe(1); });`,
    ],
    [
      'expect.soft against expect',
      `it('a', () => { expect.soft(fn('a')).toBe(1); });`,
      `it('b', () => { expect(fn('a')).toBe(1); });`,
    ],
    [
      'the matcher',
      `it('a', () => { expect(fn('a')).toBe(1); });`,
      `it('b', () => { expect(fn('a')).toEqual(1); });`,
    ],
    [
      'the called function',
      `it('a', () => { expect(fn('a')).toBe(1); });`,
      `it('b', () => { expect(build('a')).toBe(1); });`,
    ],
    [
      'a boolean expected value',
      `it('a', () => { expect(fn('a')).toBe(true); });`,
      `it('b', () => { expect(fn('a')).toBe(false); });`,
    ],
    [
      'a literal index into a local',
      `it('a', () => { const r = build(); expect(r[0]).toBe(1); });`,
      `it('b', () => { const r = build(); expect(r[1]).toBe(1); });`,
    ],
    [
      'a method selector on a local receiver',
      `it('a', () => { const r = build(); expect(r.get('a')).toBe(1); });`,
      `it('b', () => { const r = build(); expect(r.get('b')).toBe(1); });`,
    ],
  ])('gives different checks to tests that differ only in %s', (_label, first, second) => {
    const [a, b] = pairChecks(first, second);
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });

  it('renders literals as kinds, selectors exact and locals by first use', () => {
    const [checks] = checksOf(
      `it('t', async () => {`,
      `  const r = build();`,
      `  expect(getNodesByLabel(r, 'Function')).toHaveLength(1);`,
      `  expect(fn('a', 2)).not.toBe(null);`,
      `  await expect(fn(/x/)).rejects.toThrow(\`boom\`);`,
      `  expect.assertions(3);`,
      `});`,
    );
    expect(shapes(checks)).toEqual([
      'expect(getNodesByLabel(<v1>,"Function")).toHaveLength(<number>)',
      'expect(fn(<string>,<number>)).not.toBe(null)',
      'expect(fn(<regexp>)).rejects.toThrow(<string>)',
      'expect.assertions(3)',
    ]);
    expect(checks.checks.map((check) => [check.line, check.form, check.matcher])).toEqual([
      [4, 'expect', 'toHaveLength'],
      [5, 'expect', 'toBe'],
      [6, 'expect', 'toThrow'],
      [7, 'expect.assertions', ''],
    ]);
  });

  it('documents a supported matcher list with the snapshot matchers and without toSatisfy', () => {
    expect([...SUPPORTED_MATCHERS]).toEqual(
      expect.arrayContaining(['toBe', 'toEqual', 'toMatchInlineSnapshot', 'toMatchSnapshot']),
    );
    expect(SUPPORTED_MATCHERS.has('toSatisfy')).toBe(false);
  });
});

describe('computeChecks: unsupported forms', () => {
  it.each([
    ['assert.equal', `assert.equal(fn('a'), 1);`, 'assert.equal', 'not an expect assertion'],
    [
      'a node:assert function',
      `strictEqual(fn('a'), 1);`,
      'strictEqual',
      'not an expect assertion',
    ],
    ['a custom matcher', `expect(fn('a')).toBeValidThing();`, 'expect(...).toBeValidThing', ''],
    ['toSatisfy', `expect(fn('a')).toSatisfy((v) => v > 1);`, 'expect(...).toSatisfy', ''],
    ['a chai chain', `expect(fn('a')).to.equal(1);`, 'expect(...).to.equal', ''],
    ['expect.poll', `await expect.poll(() => fn('a')).toBe(1);`, 'expect.poll(...)', ''],
    ['expect without a matcher', `expect(fn('a'));`, 'expect(...)', 'no matcher'],
    [
      'expect in a loop',
      `for (const v of ['a', 'b']) expect(fn(v)).toBe(1);`,
      'expect(...).toBe',
      'loop',
    ],
    [
      'expect in a conditional',
      `if (fn('a')) expect(fn('b')).toBe(1);`,
      'expect(...).toBe',
      'conditional',
    ],
    [
      'expect in a callback',
      `['a'].forEach((v) => expect(fn(v)).toBe(1));`,
      'expect(...).toBe',
      'nested function',
    ],
    [
      'expect in a catch clause',
      `try { fn('a'); } catch (e) { expect(e).toBe(1); }`,
      'expect(...).toBe',
      'catch',
    ],
  ])('marks %s unsupported, naming the form', (_label, statement, form, reason) => {
    const [checks] = checksOf(
      `import { strictEqual } from 'node:assert';`,
      `it('t', async () => {`,
      `  ${statement}`,
      `});`,
    );
    expect(checks.unsupported).toEqual([
      expect.objectContaining({ form, reason: expect.stringContaining(reason), line: 4 }),
    ]);
  });

  it('marks expect inside a file-level helper the body calls', () => {
    const [checks] = checksOf(
      `function check(v: string) { expect(fn(v)).toBe(1); }`,
      `it('t', () => { check('a'); });`,
    );
    expect(checks.checks).toEqual([]);
    expect(checks.unsupported).toEqual([
      { line: 3, form: 'check', reason: 'assertion in helper check (expect)' },
    ]);
  });

  const HELPER = 'gitnexus/test/helpers/assertions';
  const reader = (source: string): ModuleReader => ({
    read: (key) => (key === HELPER ? { path: `${HELPER}.ts`, source } : null),
  });
  const helperTest = [
    `import { verify } from '../helpers/assertions.js';`,
    `it('t', () => { verify(fn('a')); expect(fn('a')).toBe(1); });`,
  ];

  it.each([
    [
      'an imported helper that asserts',
      reader(
        `export function verify(v: unknown) { inner(v); }\nfunction inner(v: unknown) { expect(v).toBeDefined(); }`,
      ),
      [{ line: 3, form: 'verify', reason: 'assertion in helper verify (expect)' }],
    ],
    [
      'an imported helper that cannot be read',
      reader(''),
      [{ line: 3, form: 'verify', reason: `helper verify (${HELPER}) not inspected` }],
    ],
    [
      'an imported helper that does not assert',
      reader(`export const verify = (v: unknown) => v;`),
      [],
    ],
  ])('inspects %s', (_label, modules, unsupported) => {
    const [subject] = subjectsOf(...helperTest);
    expect(computeChecks(subject, { modules }).unsupported).toEqual(unsupported);
  });

  it('reports an imported test helper as not inspected without a module reader', () => {
    const [checks] = checksOf(...helperTest);
    expect(checks.unsupported.map((entry) => entry.reason)).toEqual([
      `helper verify (${HELPER}) not inspected`,
    ]);
  });

  it('never inspects production imports', () => {
    const [checks] = checksOf(`it('t', () => { build(); expect(fn('a')).toBe(1); });`);
    expect(checks.unsupported).toEqual([]);
  });

  it('keeps unsupported forms in the fingerprint', () => {
    const [a, b] = pairChecks(
      `it('a', () => { assert.equal(fn('a'), 1); });`,
      `it('b', () => { assert.ok(fn('a')); });`,
    );
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });
});

describe('computeChecks: snapshots', () => {
  const inline = (text: string): string =>
    `it('t', () => { expect(fn('a')).toMatchInlineSnapshot(${text}); });`;

  it('hashes inline snapshot text: different text gives different checks', () => {
    const [a, b] = pairChecks(inline('`"x"`'), inline('`"y"`'));
    expect(a.checks[0].snapshot).not.toBeNull();
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });

  it('ignores the indentation of inline snapshot text', () => {
    const [a, b] = pairChecks(inline('`\n    "x"\n  `'), inline('`\n  "x"\n`'));
    expect(a.fingerprint).toBe(b.fingerprint);
  });

  it('marks an inline snapshot without text unsupported', () => {
    const [checks] = checksOf(inline(''));
    expect(checks.unsupported.map((entry) => entry.reason)).toEqual([
      'inline snapshot not written',
    ]);
  });

  /** A snapshot reader over in-memory entries that records the keys it was asked for. */
  function memoryReader(entries: Record<string, string>, files: Record<string, string> = {}) {
    const asked: string[] = [];
    const snapshots: SnapshotReader = {
      entry: (testFile, key) => {
        asked.push(`${testFile}|${key}`);
        return entries[key] ?? null;
      },
      file: (testFile, snapshotPath) => files[`${testFile}|${snapshotPath}`] ?? null,
    };
    return { snapshots, asked };
  }

  it('reads .snap entries by full name, hint and per-name counter', () => {
    const { snapshots, asked } = memoryReader({
      'd > t 1': 'one',
      'd > t 2': 'two',
      'd > t > hint 1': 'three',
    });
    const [subject] = subjectsOf(
      `describe('d', () => {`,
      `  it('t', () => {`,
      `    expect(fn('a')).toMatchInlineSnapshot('"x"');`,
      `    expect(fn('b')).toMatchSnapshot();`,
      `    expect(fn('c')).toMatchSnapshot('hint');`,
      `  });`,
      `});`,
    );
    const checks = computeChecks(subject, { snapshots });
    expect(asked).toEqual([`${FILE}|d > t 2`, `${FILE}|d > t > hint 1`]);
    expect(checks.checks.map((check) => check.snapshot === null)).toEqual([false, false, false]);
    expect(checks.unsupported).toEqual([]);
  });

  it.each([
    ['equal entries', 'same', 'same', true],
    ['different entries', 'one', 'two', false],
  ])('compares file snapshots with %s', (_label, first, second, equal) => {
    const { snapshots } = memoryReader({ 'd > a 1': first, 'd > b 1': second });
    const subjects = subjectsOf(
      `describe('d', () => {`,
      `  it('a', () => { expect(fn('a')).toMatchSnapshot(); });`,
      `  it('b', () => { expect(fn('a')).toMatchSnapshot(); });`,
      `});`,
    );
    const [a, b] = subjects.map((subject) => computeChecks(subject, { snapshots }));
    expect(a.fingerprint === b.fingerprint).toBe(equal);
  });

  it.each([
    ['a missing .snap entry', { snapshots: memoryReader({}).snapshots }, '.snap entry missing'],
    ['no snapshot reader', {}, 'snapshot file not read'],
  ])('marks a file snapshot unsupported on %s', (_label, options, reason) => {
    const [subject] = subjectsOf(`it('t', () => { expect(fn('a')).toMatchSnapshot(); });`);
    expect(computeChecks(subject, options).unsupported.map((entry) => entry.reason)).toEqual([
      reason,
    ]);
  });

  it.each([
    [
      'a property-matcher object',
      `expect(fn('a')).toMatchSnapshot({ id: expect.any(String) });`,
      [`${FILE}|t 1`],
      [],
    ],
    [
      'a hint that is not static',
      `const hint = fn('h'); expect(fn('a')).toMatchSnapshot(hint);`,
      [],
      ['snapshot hint not static'],
    ],
  ])('reads the .snap key of %s', (_label, statement, keys, reasons) => {
    const { snapshots, asked } = memoryReader({ 't 1': 'x' });
    const [subject] = subjectsOf(`it('t', () => { ${statement} });`);
    const checks = computeChecks(subject, { snapshots });
    expect(asked).toEqual(keys);
    expect(checks.unsupported.map((entry) => entry.reason)).toEqual(reasons);
  });

  it('marks a file snapshot unsupported when the test name is not known', () => {
    const [site] = sitesOf(`it.each([1])('t %i', (n) => { expect(fn(n)).toMatchSnapshot(); });`);
    const subject: CheckSubject = {
      record: site.record,
      instance: site.instances?.[0] ?? null,
      fullName: site.fullName,
    };
    const { snapshots } = memoryReader({});
    expect(computeChecks(subject, { snapshots }).unsupported.map((e) => e.reason)).toEqual([
      'test name unknown',
    ]);
  });

  it('hashes toMatchFileSnapshot from the file relative to the test', () => {
    const { snapshots } = memoryReader({}, { [`${FILE}|./out/a.txt`]: 'content' });
    const [subject] = subjectsOf(
      `it('t', async () => { await expect(fn('a')).toMatchFileSnapshot('./out/a.txt'); });`,
    );
    const checks = computeChecks(subject, { snapshots });
    expect(checks.unsupported).toEqual([]);
    expect(checks.checks[0].snapshot).not.toBeNull();
  });

  describe('fsSnapshotReader', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'scenario-map-checks-'));
    afterAll(() => rmSync(root, { recursive: true, force: true }));
    const dir = path.join(root, 'gitnexus/test/unit');
    mkdirSync(path.join(dir, '__snapshots__'), { recursive: true });
    writeFileSync(
      path.join(dir, '__snapshots__/a.test.ts.snap'),
      [
        '// Vitest Snapshot v1, https://vitest.dev/guide/snapshot.html',
        '',
        'exports[`d > t 1`] = `',
        '{',
        '  "a": 1,',
        '}',
        '`;',
        '',
      ].join('\n'),
    );
    writeFileSync(path.join(dir, 'out.txt'), 'file content');
    mkdirSync(path.join(root, 'gitnexus/test/helpers/lib'), { recursive: true });
    writeFileSync(path.join(root, 'gitnexus/test/helpers/h.ts'), 'export const h = 1;');
    writeFileSync(path.join(root, 'gitnexus/test/helpers/lib/index.ts'), 'export const l = 1;');
    const reader = fsSnapshotReader(root);
    const modules = fsModuleReader(root);

    it.each([
      ['an entry', () => reader.entry(FILE, 'd > t 1'), '\n{\n  "a": 1,\n}\n'],
      ['a missing entry', () => reader.entry(FILE, 'd > t 2'), null],
      ['a missing .snap file', () => reader.entry('gitnexus/test/unit/b.test.ts', 'x 1'), null],
      ['a file snapshot', () => reader.file(FILE, './out.txt'), 'file content'],
      ['a file outside the root', () => reader.file(FILE, '../../../../x.txt'), null],
    ])('reads %s', (_label, read, expected) => {
      expect(read()).toBe(expected);
    });

    it.each([
      [
        'a .ts module',
        'gitnexus/test/helpers/h',
        { path: 'gitnexus/test/helpers/h.ts', source: 'export const h = 1;' },
      ],
      [
        'an index module',
        'gitnexus/test/helpers/lib',
        { path: 'gitnexus/test/helpers/lib/index.ts', source: 'export const l = 1;' },
      ],
      ['a missing module', 'gitnexus/test/helpers/none', null],
      ['a module outside the root', '../outside', null],
    ])('fsModuleReader reads %s', (_label, key, expected) => {
      expect(modules.read(key)).toEqual(expected);
    });
  });
});

describe('computeChecks: instances', () => {
  it('keeps a selector that comes from an it.each row exact per instance', () => {
    const checks = checksOf(
      `it.each([['Function', 1], ['Class', 2]])('finds %s', (label, n) => {`,
      `  const r = build();`,
      `  expect(getNodesByLabel(r, label)).toHaveLength(n);`,
      `});`,
    );
    expect(checks.map(shapes)).toEqual([
      ['expect(getNodesByLabel(<v1>,"Function")).toHaveLength(<number>)'],
      ['expect(getNodesByLabel(<v1>,"Class")).toHaveLength(<number>)'],
    ]);
  });

  it.each([
    [
      'spread array rows',
      `it.each([['a', 1], ['b', 2]])('maps %s', (s, n) => { expect(fn(s)).toBe(n); });`,
    ],
    [
      'destructured object rows',
      `it.each([{ s: 'a', n: 1 }, { s: 'b', n: 2 }])('maps $s', ({ s, n }) => { expect(fn(s)).toBe(n); });`,
    ],
    [
      'row members',
      `it.each([{ s: 'a', n: 1 }, { s: 'b', n: 2 }])('maps $s', (row) => { expect(fn(row.s)).toBe(row.n); });`,
    ],
    [
      'test.for rows',
      `test.for([['a', 1], ['b', 2]])('maps %s', ([s, n]) => { expect(fn(s)).toBe(n); });`,
    ],
  ])('abstracts expected values from %s like literals', (_label, eachTest) => {
    const checks = checksOf(eachTest, `it('plain', () => { expect(fn('a')).toBe(1); });`);
    expect(checks).toHaveLength(3);
    expect(new Set(checks.map((check) => check.fingerprint)).size).toBe(1);
    expect(checks.map((check) => check.unresolved)).toEqual([[], [], []]);
  });

  it('binds a for…of element per instance', () => {
    const checks = checksOf(
      `for (const label of ['Function', 'Class']) {`,
      `  it(\`finds \${label}\`, () => { const r = build(); expect(getNodesByLabel(r, label)).toHaveLength(1); });`,
      `}`,
    );
    expect(checks.map(shapes)).toEqual([
      ['expect(getNodesByLabel(<v1>,"Function")).toHaveLength(<number>)'],
      ['expect(getNodesByLabel(<v1>,"Class")).toHaveLength(<number>)'],
    ]);
  });

  it('marks a selector unresolved when the instance is not known', () => {
    const [site] = sitesOf(
      `it.each([['Function']])('finds %s', (label) => { const r = build(); expect(getNodesByLabel(r, label)).toHaveLength(1); });`,
    );
    const checks = computeChecks({ record: site.record, instance: null, fullName: null });
    expect(shapes(checks)).toEqual([
      'expect(getNodesByLabel(<v1>,<unknown>)).toHaveLength(<number>)',
    ]);
    expect(checks.unresolved).toEqual(['selector label: instance value unknown']);
  });
});

describe('checksContextKey', () => {
  const inventory = (site: StaticCallSite | null): InventoryInstance => ({
    id: `test/unit/a.test.ts#t`,
    file: 'test/unit/a.test.ts',
    taskId: 'task-0',
    fullName: 't',
    location: null,
    row: null,
    notOracleValidated: false,
    site,
    instance: site?.instances?.[0] ?? null,
    anchor: null,
    unsupported: [],
    unresolved: [],
    dupeOk: null,
  });
  const keysOf = (...lines: string[]): (string | null)[] =>
    sitesOf(...lines).map((site) => checksContextKey(inventory(site)));

  it('gives tests with equal checks and context the same key', () => {
    const [a, b] = keysOf(
      `describe('d', () => {`,
      `  it('a', () => { expect(fn('a')).toBe(1); });`,
      `  it('b', () => { expect(fn('b')).toBe(2); });`,
      `});`,
    );
    expect(a).not.toBeNull();
    expect(a).toBe(b);
  });

  it('splits equal checks under different afterEach bodies', () => {
    const [a, b] = keysOf(
      `describe('a', () => {`,
      `  afterEach(() => { fn('reset'); });`,
      `  it('t', () => { expect(fn('a')).toBe(1); });`,
      `});`,
      `describe('b', () => {`,
      `  afterEach(() => { fn('clear'); });`,
      `  it('t', () => { expect(fn('a')).toBe(1); });`,
      `});`,
    );
    expect(a).not.toBe(b);
  });

  it.each([
    ['a test without checks', () => keysOf(`it('t', () => { fn('a'); });`)[0]],
    ['an instance without a call site', () => checksContextKey(inventory(null))],
  ])('gives no key to %s', (_label, key) => {
    expect(key()).toBeNull();
  });
});

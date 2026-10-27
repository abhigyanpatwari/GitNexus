/**
 * Locks Layer 1's record processing (U4, R3, R4, KTD4, KTD7, design §5.2) without running Vitest:
 * the worker-side pieces (records.ts: script paths, block keys, the attribution state machine,
 * the spawn wrappers) feed synthetic V8 windows into raw records, and run-coverage.ts
 * `buildWorkFile` turns them into the work file: module-load blocks are discarded, a suite's
 * `beforeAll` blocks reach only its own tests while its provenance reaches every test of the
 * outermost suite that started with it, the warm attempt gives the blocks and every attempt the
 * provenance, blocks are keyed by repo path and kept for production files only, native entries,
 * excluded candidates and spawns are flagged, and a concurrent or unrun test has unknown
 * provenance.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  CoverageAttributor,
  CoverageInterner,
  callSite,
  scriptPath,
  spawnTarget,
  wrapCall,
  type Callable,
  type RawCoverageRecord,
  type RuntimeEvents,
  type SpawnEvent,
  type V8Function,
  type V8Script,
} from '../../../tools/scenario-map/path-coverage/records.js';
import {
  buildWorkFile,
  candidateTestsOf,
  isNativeEntry,
  type CoverageTest,
  type CoverageWorkFile,
  type RuntimeModule,
  type RuntimeTest,
} from '../../../tools/scenario-map/path-coverage/run-coverage.js';

const PREPARED = '/prep';
const PKG = `${PREPARED}/gitnexus`;
const MODULES = '/repo/gitnexus/node_modules';
const TEST_FILE = 'test/unit/a.test.ts';
const BLOCK_ROOTS = [`${PKG}/src/`, `${PKG}/relocated/gitnexus-shared/src/`];
const SELF = new Set([
  `${PKG}/tools/scenario-map/path-coverage/coverage.setup.ts`,
  `${PKG}/tools/scenario-map/path-coverage/records.ts`,
]);
const NO_EVENTS: RuntimeEvents = { natives: [], spawns: [] };

const fn = (functionName: string, ...ranges: [number, number, number][]): V8Function => ({
  functionName,
  ranges: ranges.map(([startOffset, endOffset, count]) => ({ startOffset, endOffset, count })),
});
const script = (url: string, ...functions: V8Function[]): V8Script => ({ url, functions });
/** A script whose single function ran: listed as executed (and blocked under a block root). */
const ran = (url: string, name = 'f', start = 0): V8Script =>
  script(url, fn(name, [start, start + 9, 1]));

const rt = (taskId: string, fullName: string, line: number, extra: Partial<RuntimeTest> = {}) => ({
  taskId,
  fullName,
  location: { line, column: 3 },
  state: 'passed' as const,
  concurrent: false,
  ...extra,
});

/** Drives one file's windows through the worker-side pieces, as coverage.setup.ts does. */
class FileRun {
  readonly interner = new CoverageInterner(BLOCK_ROOTS, SELF);
  readonly attributor = new CoverageAttributor();

  #delta(scripts: readonly V8Script[], events: RuntimeEvents) {
    return this.interner.summarize(scripts, events);
  }

  load(...scripts: V8Script[]): this {
    this.attributor.load(this.#delta(scripts, NO_EVENTS));
    return this;
  }

  start(taskId: string, chain: string[], scripts: V8Script[] = [], concurrent = false): this {
    this.attributor.testStart(taskId, chain, concurrent, this.#delta(scripts, NO_EVENTS));
    return this;
  }

  end(taskId: string, scripts: V8Script[] = [], events: RuntimeEvents = NO_EVENTS): this {
    this.attributor.testEnd(taskId, this.#delta(scripts, events));
    return this;
  }

  finish(...scripts: V8Script[]): RawCoverageRecord {
    this.attributor.finish(this.#delta(scripts, NO_EVENTS));
    return this.attributor.record(`${PKG}/${TEST_FILE}`, this.interner);
  }
}

const work = (raws: RawCoverageRecord[], tests: RuntimeTest[]): CoverageWorkFile =>
  buildWorkFile({
    mode: { kind: 'normal' },
    preparedRoot: PREPARED,
    repeats: 1,
    modules: [{ file: TEST_FILE, errors: [], tests } satisfies RuntimeModule],
    raws,
    unhandledErrors: [],
  });

const blocksOf = (file: CoverageWorkFile, test: CoverageTest, which: 'blocks' | 'suiteBlocks') =>
  test[which].map((index) => file.blocks[index]);

const byName = (file: CoverageWorkFile, fullName: string): CoverageTest => {
  const found = file.tests.find((test) => test.fullName === fullName);
  if (found === undefined) throw new Error(`no test ${fullName}`);
  return found;
};

describe('scriptPath', () => {
  const absolute = path.resolve('/prep/x.ts');
  it.each([
    {
      name: 'a plain path, query dropped',
      url: `${PKG}/src/a.ts?v=12`,
      expected: `${PKG}/src/a.ts`,
    },
    {
      name: 'a file URL',
      url: pathToFileURL(absolute).href,
      expected: absolute.split(path.sep).join('/'),
    },
    { name: 'a Windows path', url: 'C:\\prep\\a.ts', expected: 'C:/prep/a.ts' },
    { name: 'a node: builtin', url: 'node:internal/fs/utils', expected: null },
    { name: 'evaluated code', url: 'evalmachine.<anonymous>', expected: null },
    { name: 'an empty URL', url: '', expected: null },
  ])('maps $name', ({ url, expected }) => {
    expect(scriptPath(url)).toBe(expected);
  });
});

describe('CoverageInterner', () => {
  it('keys executed functions and their nested ranges with a covered flag, blocks under block roots only', () => {
    const interner = new CoverageInterner(BLOCK_ROOTS, SELF);
    const delta = interner.summarize(
      [
        script(
          `${PKG}/src/a.ts`,
          fn('', [0, 100, 1]),
          fn('add', [10, 50, 2], [20, 30, 0], [30, 40, 1]),
          fn('unused', [60, 80, 0]),
        ),
        script(`${PKG}/src/b.ts`, fn('idle', [0, 10, 0])),
        ran(`${PKG}/${TEST_FILE}`),
        ran(`${PKG}/tools/scenario-map/path-coverage/records.ts`),
        ran('node:internal/process/task_queues'),
        ran(`${MODULES}/vitest/dist/index.js`),
      ],
      NO_EVENTS,
    );
    expect([...delta.blocks].map((index) => interner.blocks[index])).toEqual([
      '0#<anon>@0',
      '0#add@10',
      '0#add@10|20-30:0',
      '0#add@10|30-40:1',
    ]);
    expect([...delta.scripts].map((index) => interner.scripts[index])).toEqual([
      `${PKG}/src/a.ts`,
      `${PKG}/${TEST_FILE}`,
      `${MODULES}/vitest/dist/index.js`,
    ]);
  });

  it('carries the runtime events of the window', () => {
    const spawn: SpawnEvent = { api: 'child_process.spawn', target: 'git', site: null };
    const delta = new CoverageInterner(BLOCK_ROOTS, SELF).summarize([], {
      natives: ['/x/a.node'],
      spawns: [spawn],
    });
    expect([[...delta.natives], delta.spawns]).toEqual([['/x/a.node'], [spawn]]);
  });
});

describe('attribution (design §5.2)', () => {
  const S = 'suite-s';
  const F = 'file-f';
  const record = new FileRun()
    .load(ran(`${PKG}/src/module-load.ts`, 'atLoad'))
    // `describe('s')` with a beforeAll that calls production code, then t1 and t2; t3 is top-level.
    .start('t1', [F, S], [ran(`${PKG}/src/setup.ts`, 'buildGraph'), ran(`${PKG}/tools/x.ts`)])
    .end('t1', [
      ran(`${PKG}/src/a.ts`, 'first'),
      ran(`${PKG}/src/lazy.ts`, 'coldInit'),
      ran(`${PKG}/tools/cold.ts`),
    ])
    .start('t1', [F, S])
    .end('t1', [ran(`${PKG}/src/a.ts`, 'first')])
    .start('t2', [F, S])
    .end('t2', [ran(`${PKG}/src/a.ts`, 'second', 20)])
    .start('t3', [F], [ran(`${PKG}/src/teardown.ts`, 'afterAllOfS')])
    .end('t3', [ran(`${PKG}/src/b.ts`, 'third')])
    .finish(ran(`${PKG}/src/tail.ts`, 'afterAllOfFile'));
  const file = work([record], [rt('t1', 's > t1', 3), rt('t2', 's > t2', 4), rt('t3', 't3', 6)]);

  it.each([
    { name: 's > t1', blocks: ['gitnexus/src/a.ts#first@0', 'gitnexus/src/setup.ts#buildGraph@0'] },
    {
      name: 's > t2',
      blocks: ['gitnexus/src/a.ts#second@20', 'gitnexus/src/setup.ts#buildGraph@0'],
    },
    { name: 't3', blocks: ['gitnexus/src/b.ts#third@0'] },
  ])('gives $name its own and its suites’ blocks, never module-load blocks', ({ name, blocks }) => {
    expect(blocksOf(file, byName(file, name), 'blocks')).toEqual(blocks);
  });

  it('shows the beforeAll code in the suite blocks of the suite’s tests', () => {
    expect(blocksOf(file, byName(file, 's > t2'), 'suiteBlocks')).toEqual([
      'gitnexus/src/setup.ts#buildGraph@0',
    ]);
  });

  it('keeps the warm attempt’s blocks but the provenance of every attempt', () => {
    const t1 = byName(file, 's > t1');
    expect(t1.attempts).toBe(2);
    expect(blocksOf(file, t1, 'blocks')).not.toContain('gitnexus/src/lazy.ts#coldInit@0');
    expect(t1.provenance.executedFiles).toContain('gitnexus/src/lazy.ts');
    expect(t1.provenance.excludedCandidates).toEqual([
      'gitnexus/tools/cold.ts',
      'gitnexus/tools/x.ts',
    ]);
  });

  it('gives the provenance of a window that started the file and a suite to every test of the file', () => {
    expect(byName(file, 't3').provenance.excludedCandidates).toEqual(['gitnexus/tools/x.ts']);
  });

  it('keeps load, afterAll and tail provenance in the file’s unattributed bucket', () => {
    expect(file.files[0].unattributed.executedFiles).toEqual([
      'gitnexus/src/module-load.ts',
      'gitnexus/src/tail.ts',
      'gitnexus/src/teardown.ts',
    ]);
  });

  it('leaves blocks no test owns out of the block table', () => {
    expect(file.blocks).not.toContain('gitnexus/src/module-load.ts#atLoad@0');
    expect(file.blocks).not.toContain('gitnexus/src/tail.ts#afterAllOfFile@0');
  });
});

describe('buildWorkFile: block ids', () => {
  const record = new FileRun()
    .load()
    .start('t1', ['f'])
    .end('t1', [
      ran(`${PKG}/relocated/gitnexus-shared/src/lang.ts`, 'langOf', 4),
      ran(`${PKG}/src/core/x.ts`, 'run', 7),
      ran(`${PKG}/src/generated.js`, 'gen'),
    ])
    .finish();
  const file = work([record], [rt('t1', 't1', 3)]);

  it('keys blocks by repo path, keeps production files only and sorts the table', () => {
    expect(file.blocks).toEqual([
      'gitnexus-shared/src/lang.ts#langOf@4',
      'gitnexus/src/core/x.ts#run@7',
    ]);
    expect(file.tests[0].blocks).toEqual([0, 1]);
  });

  it('still lists the non-production file as executed', () => {
    expect(file.tests[0].provenance.executedFiles).toContain('gitnexus/src/generated.js');
  });

  it('gives Phase 0 ids, task ids and locations', () => {
    expect(file.tests[0]).toMatchObject({
      id: `${TEST_FILE}#t1`,
      taskId: 't1',
      file: TEST_FILE,
      location: { line: 3, column: 3 },
    });
  });
});

describe('buildWorkFile: provenance', () => {
  const record = new FileRun()
    .load()
    .start('t1', ['f'])
    .end(
      't1',
      [
        ran(`${PKG}/${TEST_FILE}`),
        ran(`${MODULES}/tree-sitter/index.js`),
        ran(`${MODULES}/vitest/dist/chunks/run.js`),
        ran(`${PKG}/tools/mutation/prepare/path-map.ts`),
        ran(`${PKG}/test/helpers/fixtures.ts`),
      ],
      {
        natives: [`${MODULES}/@ladybugdb/core/lbug.node`],
        spawns: [{ api: 'child_process.spawn', target: 'git', site: `${PKG}/src/git.ts:3:7` }],
      },
    )
    .finish();
  const file = work([record], [rt('t1', 't1', 3)]);

  it('lists executed files without harness packages', () => {
    expect(file.tests[0].provenance.executedFiles).toEqual([
      'gitnexus/test/helpers/fixtures.ts',
      'gitnexus/test/unit/a.test.ts',
      'gitnexus/tools/mutation/prepare/path-map.ts',
      'node_modules/tree-sitter/index.js',
    ]);
  });

  it('flags native-package entries, executed or loaded through dlopen', () => {
    expect(file.tests[0].provenance.nativeEntries).toEqual([
      'node_modules/@ladybugdb/core/lbug.node',
      'node_modules/tree-sitter/index.js',
    ]);
  });

  it('names executed package files that are neither tests nor production as excluded candidates', () => {
    expect(file.tests[0].provenance.excludedCandidates).toEqual([
      'gitnexus/tools/mutation/prepare/path-map.ts',
    ]);
  });

  it('records worker spawns with the call site as a repo path', () => {
    expect(file.tests[0].provenance.workerSpawns).toEqual([
      { api: 'child_process.spawn', target: 'git', site: 'gitnexus/src/git.ts:3:7' },
    ]);
  });

  it('marks the provenance of a test that ran alone as known', () => {
    expect(file.tests[0].provenance.known).toBe(true);
  });
});

describe('isNativeEntry', () => {
  it.each([
    { key: 'node_modules/tree-sitter/index.js', native: true },
    { key: 'node_modules/tree-sitter-python/bindings/node/index.js', native: true },
    { key: 'node_modules/@ladybugdb/core/index.js', native: true },
    { key: 'node_modules/onnxruntime-node/dist/index.js', native: true },
    { key: 'node_modules/a/node_modules/tree-sitter/x.js', native: true },
    { key: 'gitnexus/build/addon.node', native: true },
    { key: 'node_modules/lodash/index.js', native: false },
    { key: 'node_modules/@ladybugdb/other/index.js', native: false },
    { key: 'gitnexus/src/core/tree-sitter/parser.ts', native: false },
  ])('classifies $key', ({ key, native }) => {
    expect(isNativeEntry(key)).toBe(native);
  });
});

describe('buildWorkFile: concurrent and unrun tests', () => {
  it.each([
    { retry: undefined, expected: 0 },
    { retry: 0, expected: 0 },
    { retry: 1, expected: 1 },
    { retry: { count: 2 }, expected: 2 },
    { retry: {}, expected: 0 },
  ])(
    'records configured retries ($retry) independently of observed attempts',
    ({ retry, expected }) => {
      const file = work([], [rt('t', 't', 3, { retry })]);
      expect(file.tests[0]).toMatchObject({ state: 'passed', retry: expected, attempts: 0 });
    },
  );

  const record = new FileRun()
    .load()
    .start('c1', ['f'], [], true)
    .end('c1', [ran(`${PKG}/src/a.ts`)])
    .start('c2', ['f'])
    .end('c2', [ran(`${PKG}/src/a.ts`)])
    .finish();

  it.each([
    { name: 'concurrent in the worker', taskId: 'c1', runtime: false },
    { name: 'concurrent in the collected options', taskId: 'c2', runtime: true },
  ])(
    'marks a test $name as concurrent, with no path and unknown provenance',
    ({ taskId, runtime }) => {
      const file = work([record], [rt(taskId, 't', 3, { concurrent: runtime })]);
      const [test] = file.tests;
      expect([test.concurrent, test.blocks, test.provenance.known]).toEqual([true, [], false]);
    },
  );

  it('keeps a concurrent test that ran without a window of its own as a candidate input', () => {
    const file = work([record], [rt('c3', 'c3', 5, { concurrent: true })]);
    expect(candidateTestsOf(file, new Map([[`${TEST_FILE}#c3`, 'key']]))).toEqual([
      { id: `${TEST_FILE}#c3`, blocks: [], concurrent: true, checksContext: 'key' },
    ]);
  });

  it('leaves a test that did not run out of the candidate inputs', () => {
    const file = work([record], [rt('skipped', 'skipped', 9, { state: 'skipped' })]);
    expect(candidateTestsOf(file, new Map())).toEqual([]);
  });

  it('gives a test without a window no blocks and unknown provenance', () => {
    const file = work([record], [rt('skipped', 'skipped', 9, { state: 'skipped' })]);
    expect(file.tests[0]).toMatchObject({ attempts: 0, blocks: [], state: 'skipped' });
    expect(file.tests[0].provenance.known).toBe(false);
  });

  it('marks a file without a raw record as not recorded', () => {
    const file = work([], [rt('t', 't', 3)]);
    expect([file.files[0].recorded, file.tests[0].provenance.known]).toEqual([false, false]);
  });
});

describe('wrapCall and callSite', () => {
  it('passes calls through and reports them', () => {
    const notes: [string, readonly unknown[]][] = [];
    const original: Callable = function (this: unknown, ...args: unknown[]) {
      return [this, ...args];
    };
    const wrapped = wrapCall(original, 'child_process.spawn', (api, args) =>
      notes.push([api, args]),
    );
    const receiver = { tag: 'r' };
    expect(wrapped.call(receiver, 'git', ['status'])).toEqual([receiver, 'git', ['status']]);
    expect(notes).toEqual([['child_process.spawn', ['git', ['status']]]]);
  });

  it('wraps util.promisify.custom so promisified calls are seen and keep their shape', async () => {
    const notes: string[] = [];
    const original: Callable = () => undefined;
    Reflect.defineProperty(original, promisify.custom, {
      value: async (command: string) => ({ stdout: command, stderr: '' }),
    });
    const wrapped = wrapCall(original, 'child_process.exec', (api) => notes.push(api));
    const run = promisify(wrapped) as unknown as (command: string) => Promise<unknown>;
    await expect(run('ls')).resolves.toEqual({ stdout: 'ls', stderr: '' });
    expect(notes).toEqual(['child_process.exec']);
  });

  it('takes the first stack frame outside the hook', () => {
    const stack = [
      'Error',
      `    at wrapped (${PKG}/tools/scenario-map/path-coverage/records.ts:10:5)`,
      '    at node:internal/child_process:1:1',
      `    at runGit (${PKG}/src/git.ts:3:7)`,
      `    at ${PKG}/${TEST_FILE}:9:2`,
    ].join('\n');
    expect(callSite(stack, (file) => SELF.has(file))).toBe(`${PKG}/src/git.ts:3:7`);
  });

  it('returns no call site when every frame is the hook', () => {
    const stack = `Error\n    at x (${PKG}/tools/scenario-map/path-coverage/records.ts:1:1)`;
    expect(callSite(stack, (file) => SELF.has(file))).toBeNull();
  });

  it('cuts a long spawn target', () => {
    expect(spawnTarget(['x'.repeat(500)])).toHaveLength(201);
  });
});

/**
 * Locks the row-deletion operator (U9, R8, KTD10, design §5.4 "Row-deletion operator") without
 * spawning Vitest: a pair whose differing discarded values are keys of one supported production
 * table (an object literal, `new Set([...])`, `new Map([...])`) gets one planned deletion per
 * differing key, with a `RowDeletion` global id and a text splice of the entry and its trailing
 * comma; unsupported constructs make it inconclusive with the construct named; values in no common
 * supported table make it not applicable. The runs go through an injected `runVitest`: a control
 * run that must pass and load the edited file, then one run per deletion in a throwaway copy,
 * each a fresh call that sees its own edit, with the file restored afterwards.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse } from '@babel/parser';
import { afterEach, describe, expect, it } from 'vitest';
import { contentHash, formatGlobalId } from '../../../tools/mutation/prepare/mutant-identity.js';
import type { PrepareOptions, PrepareReport } from '../../../tools/mutation/prepare/prepare.js';
import type { OutcomeClass } from '../../../tools/mutation/runner/classify-outcome.js';
import {
  computeFacet,
  createFacetContext,
  type FacetSources,
  type FacetSubject,
} from '../../../tools/scenario-map/facet/input-facet.js';
import { expandCases } from '../../../tools/scenario-map/inventory/cases.js';
import {
  ROW_DELETION_MUTATOR,
  classifyControlRun,
  classifyDeletionRun,
  combineRowDeletion,
  pairTableSearch,
  planRowDeletion,
  runRowDeletion,
  type RowDeletionDeps,
  type RowDeletionPlan,
} from '../../../tools/scenario-map/mutation/row-deletion.js';
import { buildRunManifest } from '../../../tools/scenario-map/mutation/run-group.js';
import type {
  VitestRunOptions,
  VitestRunResult,
} from '../../../tools/scenario-map/mutation/vitest-run.js';

const TEST_FILE = 'gitnexus/test/unit/a.test.ts';
const PACKAGE_FILE = 'test/unit/a.test.ts';
const M = 'gitnexus/src/m.ts';
const N = 'gitnexus/src/n.ts';
const A = `${PACKAGE_FILE}#d > a`;
const B = `${PACKAGE_FILE}#d > b`;
const IMPORTS = `import { has, lookup } from '../../src/m.js';`;
const READ_OBJECT = `export const lookup = (k: string) => T[k];\nexport const has = (k: string) => k in T;`;
const READ_SET = `export const has = (v: string) => S.has(v);\nexport const lookup = has;`;
const READ_A = `it('a', () => { expect(lookup('a')).toBeDefined(); });`;
const READ_B = `it('b', () => { expect(lookup('b')).toBeDefined(); });`;
const HAS_X = `it('a', () => { expect(has('x')).toBe(true); });`;
const HAS_Y = `it('b', () => { expect(has('y')).toBe(true); });`;

const memorySources = (files: Record<string, string>): FacetSources => ({
  read: (file) => files[file] ?? null,
  list: (dir) =>
    Object.keys(files)
      .filter((file) => file.startsWith(`${dir}/`))
      .sort(),
});

interface World {
  /** Production sources by repo path. */
  files: Record<string, string>;
  /** Executed production files; default every file. */
  executed?: string[];
  /** The two tests; default {@link READ_A} and {@link READ_B}. */
  tests?: [string, string];
}

/** The row-deletion plan of two tests written inside one describe, with real U6 facets. */
async function planOf(world: World, first: string, second: string): Promise<RowDeletionPlan> {
  const source = [IMPORTS, `describe('d', () => {`, first, second, `});`].join('\n');
  const sites = expandCases([{ path: TEST_FILE, source }]).sites;
  const production = Object.keys(world.files).sort();
  const sources = memorySources({ ...world.files, [TEST_FILE]: source });
  const ctx = createFacetContext({
    sources,
    productionFiles: production,
    closures: new Map([[PACKAGE_FILE, [TEST_FILE, ...production]]]),
    builtinFiles: [],
  });
  const subjects: FacetSubject[] = sites.flatMap((site) =>
    (site.instances ?? []).map((instance) => ({
      id: `${PACKAGE_FILE}#d > ${site.record.title}`,
      file: PACKAGE_FILE,
      record: site.record,
      instance,
      executedFiles: world.executed ?? production,
    })),
  );
  expect(subjects).toHaveLength(2);
  const facets = await Promise.all(subjects.map((subject) => computeFacet(subject, ctx)));
  return planRowDeletion(
    { a: A, b: B, facets: [facets[0], facets[1]], search: pairTableSearch(ctx, subjects) },
    { tables: ctx.tables, read: (file) => sources.read(file) },
  );
}

const object = (table: string, tail = ''): World => ({
  files: { [M]: `${table}\n${READ_OBJECT}${tail}` },
});
const set = (table: string, tail = ''): World => ({
  files: { [M]: `${table}\n${READ_SET}${tail}` },
  tests: [HAS_X, HAS_Y],
});

/** The plan of a world's own two tests. */
const planWorld = (world: World): Promise<RowDeletionPlan> =>
  planOf(world, ...(world.tests ?? [READ_A, READ_B]));

/** What a deletion removes from the original text. */
const spliced = (source: string, plan: RowDeletionPlan): string[] =>
  plan.deletions.map((deletion) => source.slice(deletion.splice.start, deletion.splice.end));

const apply = (source: string, splice: { start: number; end: number }): string =>
  source.slice(0, splice.start) + source.slice(splice.end);

describe('planRowDeletion: supported tables', () => {
  it('plans one RowDeletion per differing key of an object table, with global ids', async () => {
    const world = object(`const T = { a: 1, b: 2, c: 3 };`);
    const plan = await planOf(world, READ_A, READ_B);
    const source = world.files[M];
    const identity = (start: number, end: number) => ({
      file: M,
      fileHash: contentHash(source),
      location: { start: { line: 1, column: start }, end: { line: 1, column: end } },
      mutatorName: ROW_DELETION_MUTATOR,
      replacement: '',
    });
    expect(plan.status).toBe('planned');
    expect(plan.deletions.map((deletion) => deletion.key)).toEqual(['s:a', 's:b']);
    expect(plan.deletions.map((deletion) => deletion.globalId)).toEqual([
      formatGlobalId(identity(13, 17)),
      formatGlobalId(identity(19, 23)),
    ]);
    expect(plan.deletions.map((deletion) => deletion.identity.mutatorName)).toEqual([
      'RowDeletion',
      'RowDeletion',
    ]);
    expect(spliced(source, plan)).toEqual(['a: 1,', 'b: 2,']);
    expect(plan.deletions[0].table).toEqual({ file: M, kind: 'object', binding: 'T', line: 1 });
  });

  it('splices only the deleted Set element, and the file still parses', async () => {
    const world = set(`const S = new Set(['x', 'y']);`);
    const plan = await planOf(world, HAS_X, HAS_Y);
    const source = world.files[M];
    const edits = plan.deletions.map((deletion) => apply(source, deletion.splice));
    expect(plan.deletions.map((deletion) => deletion.key)).toEqual(['s:x', 's:y']);
    expect(edits.map((edit) => edit.split('\n')[0])).toEqual([
      `const S = new Set([ 'y']);`,
      `const S = new Set(['x', ]);`,
    ]);
    expect(
      edits.map((edit) => parse(edit, { sourceType: 'module', plugins: ['typescript'] }).type),
    ).toEqual(['File', 'File']);
  });

  it.each([
    ['an object literal under `as const`', object(`const T = { a: 1, b: 2, c: 3 } as const;`)],
    [
      'an object literal under Object.freeze',
      object(`const T = Object.freeze({ a: 1, b: 2, c: 3 });`),
    ],
    ['an object literal with string keys', object(`const T = { 'a': 1, 'b': 2, c: 3 };`)],
    [
      'an object literal read in place',
      {
        files: {
          [M]: `export const lookup = (k: string) => ({ a: 1, b: 2, c: 3 } as Record<string, number>)[k];\nexport const has = lookup;`,
        },
      },
    ],
    ['a Map from literal entries', object(`const T = new Map([['a', 1], ['b', 2]]);`)],
  ])('plans two deletions in %s', async (_label, world) => {
    const plan = await planOf(world, READ_A, READ_B);
    expect(plan.status).toBe('planned');
    expect(plan.deletions.map((deletion) => deletion.key)).toEqual(['s:a', 's:b']);
  });

  it('deletes a Map entry with its key and value', async () => {
    const world = object(`const T = new Map([['a', 1], ['b', 2]]);`);
    const plan = await planOf(world, READ_A, READ_B);
    expect(spliced(world.files[M], plan)).toEqual([`['a', 1],`, `['b', 2]`]);
  });

  it('searches the executed files before the import closure', async () => {
    const files = {
      [M]: `import { U } from './n.js';\nconst T = { a: 1, b: 2, c: 3 };\n${READ_OBJECT}\nexport const u = U;`,
      [N]: `export const U = { a: 'x', b: 'y', c: 'z' };`,
    };
    const executedOnly = await planOf({ files, executed: [M] }, READ_A, READ_B);
    const closureOnly = await planOf({ files, executed: [] }, READ_A, READ_B);
    expect(executedOnly.deletions.map((deletion) => deletion.table.file)).toEqual([M, M]);
    expect([closureOnly.status, closureOnly.reasons]).toEqual([
      'inconclusive',
      ['ambiguous-table'],
    ]);
  });
});

describe('planRowDeletion: unsupported tables and no table', () => {
  it.each([
    ['spread', object(`const BASE = { z: 0 };\nconst T = { ...BASE, a: 1, b: 2 };`)],
    ['computed-key', object(`const K = 'c';\nconst T = { [K]: 0, a: 1, b: 2 };`)],
    ['object-assign', object(`const T = { a: 1, b: 2, c: 3 };`, `\nObject.assign(T, { d: 4 });`)],
    ['write', object(`const T: Record<string, number> = { a: 1, b: 2, c: 3 };`, `\nT.d = 4;`)],
    ['write', object(`const T: Record<string, number> = { a: 1, b: 2, c: 3 };`, `\ndelete T.c;`)],
    ['write', object(`let T: Record<string, number> = { a: 1, b: 2, c: 3 };`, `\nT = {};`)],
    ['write', set(`const S = new Set(['x', 'y']);`, `\nS.add('z');`)],
    ['getter', object(`const T = { get a() { return 1; }, b: 2, c: 3 };`)],
    ['proxy', object(`const T = new Proxy({ a: 1, b: 2, c: 3 }, {});`)],
    ['proxy', object(`const T = { a: 1, b: 2, c: 3 };`, `\nexport const P = new Proxy(T, {});`)],
    ['duplicate-key', object(`const T = { a: 1, b: 2, a: 3 };`)],
    ['duplicate-key', set(`const S = new Set(['x', 'y', 'x']);`)],
    [
      'untracked',
      set(`export const CONFIG = { kinds: new Set(['x', 'y']) };\nconst S = CONFIG.kinds;`),
    ],
  ])('is inconclusive for a table with %s (%#)', async (construct, world) => {
    const plan = await planWorld(world);
    expect([plan.status, plan.reasons, plan.deletions]).toEqual([
      'inconclusive',
      [`unsupported-table: ${construct}`],
      [],
    ]);
  });

  it.each([
    [
      'no-common-table',
      object(`const T = { a: 1, b: 2, c: 3 };`),
      READ_A,
      `it('b', () => { expect(lookup('q')).toBeDefined(); });`,
    ],
    [
      'no-supported-table',
      {
        files: {
          [M]: `const T = ['alpha', 'beta'];\nexport const lookup = (k: string) => T.includes(k);\nexport const has = lookup;`,
        },
      },
      `it('a', () => { expect(lookup('alpha')).toBe(true); });`,
      `it('b', () => { expect(lookup('beta')).toBe(true); });`,
    ],
    [
      'no-differing-values',
      object(`const T = { a: 1, b: 2, c: 3 };`),
      READ_A,
      READ_A.replace("'a', ()", "'b', ()"),
    ],
  ])('is not applicable with %s', async (reason, world, first, second) => {
    const plan = await planOf(world, first, second);
    expect([plan.status, plan.reasons, plan.deletions]).toEqual(['not-applicable', [reason], []]);
  });
});

// ── Classification ──────────────────────────────────────────────────────────

const KILL: OutcomeClass = 'killed-by-test:assertion';
const LOADED = ['src/m.ts'];

function vitestResult(
  outcomes: readonly [OutcomeClass | null, OutcomeClass | null],
  overrides: Partial<VitestRunResult> = {},
): VitestRunResult {
  const failing = outcomes.filter((outcome) => outcome !== 'survived' && outcome !== null);
  return {
    tests: [A, B].map((id, index) => ({
      id,
      taskId: `t_${index}`,
      fullName: id.split('#')[1],
      location: { line: index + 1, column: 3 },
      state:
        outcomes[index] === null ? 'missing' : outcomes[index] === 'survived' ? 'passed' : 'failed',
      outcome: outcomes[index],
      message: outcomes[index] === 'survived' ? null : 'boom',
    })),
    status: failing.length > 0 ? 'killed' : 'survived',
    outcome: failing[0] ?? 'survived',
    reason: null,
    outsideTest: [],
    problems: [],
    unhandledErrors: [],
    wallClockMs: 5,
    loadedFiles: LOADED,
    ...overrides,
  };
}

describe('classifyDeletionRun', () => {
  it.each([
    ['only A fails by assertion', vitestResult([KILL, 'survived']), 'asymmetric', null],
    ['only B fails by assertion', vitestResult(['survived', KILL]), 'asymmetric', null],
    ['both fail by assertion', vitestResult([KILL, KILL]), 'symmetric', null],
    ['neither fails', vitestResult(['survived', 'survived']), 'symmetric', null],
    [
      'a runtime error',
      vitestResult(['killed-by-test:runtime', 'survived']),
      'inconclusive',
      'killed-by-test:runtime',
    ],
    [
      'a timeout',
      vitestResult(['timeout', KILL], { status: 'timeout' }),
      'inconclusive',
      'timeout',
    ],
    [
      'a failing hook',
      vitestResult(['killed-by-test:hook', KILL]),
      'inconclusive',
      'killed-by-test:hook',
    ],
    [
      'an unhandled error',
      vitestResult([KILL, 'survived'], { status: 'error', outcome: 'infrastructure' }),
      'inconclusive',
      'infrastructure',
    ],
    [
      'a failing afterAll hook',
      vitestResult([KILL, 'survived'], {
        outsideTest: [
          {
            file: PACKAGE_FILE,
            suiteTaskId: undefined,
            outcome: 'killed-outside-test:hook',
            attributedTo: [],
            message: 'afterAll failed',
          },
        ],
      }),
      'inconclusive',
      'killed-outside-test:hook',
    ],
    [
      'a test that did not run',
      vitestResult([null, KILL], {
        status: 'error',
        outcome: 'invalid',
        problems: ['not collected'],
      }),
      'inconclusive',
      'invalid',
    ],
    [
      'an unloaded edit',
      vitestResult([KILL, 'survived'], { loadedFiles: [] }),
      'inconclusive',
      'edit-not-loaded',
    ],
  ])('classifies %s', (_label, run, outcome, reason) => {
    expect(classifyDeletionRun(run, [A, B], LOADED)).toEqual({ outcome, reason });
  });
});

describe('classifyControlRun', () => {
  it.each([
    ['two passing tests that loaded the file', vitestResult(['survived', 'survived']), null],
    ['a failing test', vitestResult(['survived', KILL]), 'control-failed'],
    [
      'a run that loaded no probe file',
      vitestResult(['survived', 'survived'], { loadedFiles: [] }),
      'edit-not-loaded',
    ],
    [
      'a run without probe results',
      vitestResult(['survived', 'survived'], { loadedFiles: undefined }),
      'edit-not-loaded',
    ],
  ])('classifies %s', (_label, run, problem) => {
    expect(classifyControlRun(run, [A, B], LOADED)).toBe(problem);
  });
});

describe('combineRowDeletion', () => {
  it.each([
    [['symmetric', 'asymmetric', 'inconclusive'], 'asymmetric'],
    [['symmetric', 'inconclusive'], 'inconclusive'],
    [['symmetric', 'symmetric', 'not-applicable'], 'symmetric'],
    [['not-applicable'], 'not-applicable'],
    [[], 'not-applicable'],
  ] as const)('combines %j into %s', (outcomes, expected) => {
    expect(combineRowDeletion(outcomes)).toBe(expected);
  });
});

// ── Runs ────────────────────────────────────────────────────────────────────

const temps: string[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'scenario-map-u9-'));
  temps.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const OBJECT_SOURCE = `const T = { a: 1, b: 2, c: 3 };\n${READ_OBJECT}\n`;

/** A prepared tree: the package sources plus the two tool versions under node_modules. */
function writeTree(root: string, source: string): void {
  const files: Record<string, string> = {
    'gitnexus/node_modules/vitest/package.json': JSON.stringify({ version: '5.0.5' }),
    'gitnexus/node_modules/@stryker-mutator/core/package.json': JSON.stringify({
      version: '10.0.0',
    }),
    [M]: source,
    [TEST_FILE]: `${IMPORTS}\n`,
  };
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  }
}

interface Call {
  workDir: string;
  testIds: readonly string[];
  probeFiles: readonly string[] | undefined;
  maxWorkers: number | undefined;
  /** The table file's text when the call started. */
  text: string;
}

interface FakeOptions {
  /** Keys whose absence fails each test by assertion. */
  reads: Record<string, readonly string[]>;
  /** The outcome class a failing test gets; default an assertion failure. */
  failure?: OutcomeClass;
  /** The control run fails test B. */
  controlFails?: boolean;
  /** The runs load no probe file. */
  loadsNothing?: boolean;
  /** The prepared copy differs from the run manifest. */
  foreignCopy?: boolean;
  /** The 1-based call that throws. */
  throwsOn?: number;
  /** The worker bound passed to runRowDeletion. */
  maxWorkers?: number;
}

function fakeDeps(options: FakeOptions): { deps: RowDeletionDeps; calls: Call[] } {
  const calls: Call[] = [];
  let clock = 0;
  const deps: RowDeletionDeps = {
    prepare: (prepareOptions: PrepareOptions): PrepareReport => {
      writeTree(prepareOptions.outDir, `${OBJECT_SOURCE}${options.foreignCopy ? '// x\n' : ''}`);
      return {
        version: 1,
        repoRoot: prepareOptions.repoRoot,
        outDir: prepareOptions.outDir,
        packageDir: path.join(prepareOptions.outDir, 'gitnexus'),
        relocatedShared: '',
        pathMap: [],
        copiedFiles: 2,
        blanked: [],
        failed: [],
      };
    },
    runVitest: async (runOptions: VitestRunOptions): Promise<VitestRunResult> => {
      const text = readFileSync(path.join(runOptions.packageDir, 'src/m.ts'), 'utf8');
      calls.push({
        workDir: runOptions.workDir,
        testIds: runOptions.testIds,
        probeFiles: runOptions.probeFiles,
        maxWorkers: runOptions.maxWorkers,
        text,
      });
      if (calls.length === options.throwsOn) throw new Error('vitest could not start');
      const control = calls.length === 1;
      const outcomeOf = (id: string): OutcomeClass => {
        if (control) return options.controlFails === true && id === B ? KILL : 'survived';
        const missing = (options.reads[id] ?? []).some((key) => !text.includes(`${key}: `));
        return missing ? (options.failure ?? KILL) : 'survived';
      };
      return vitestResult([outcomeOf(A), outcomeOf(B)], {
        loadedFiles: options.loadsNothing === true ? [] : [...(runOptions.probeFiles ?? [])],
      });
    },
    now: () => (clock += 1000),
  };
  return { deps, calls };
}

async function objectPlan(): Promise<RowDeletionPlan> {
  return planOf({ files: { [M]: OBJECT_SOURCE } }, READ_A, READ_B);
}

async function runWith(options: FakeOptions) {
  const manifestRoot = tempDir();
  writeTree(manifestRoot, OBJECT_SOURCE);
  const manifest = buildRunManifest({
    preparedRoot: manifestRoot,
    mode: { kind: 'normal' },
    tests: [A, B],
  });
  const workDir = tempDir();
  const { deps, calls } = fakeDeps(options);
  const [result] = await runRowDeletion(
    {
      repoRoot: tempDir(),
      workDir,
      manifest,
      plans: [await objectPlan()],
      maxWorkers: options.maxWorkers,
    },
    deps,
  );
  const copied = readFileSync(path.join(workDir, 'row-deletion', 'prepared', M), 'utf8');
  return { result, calls, copied };
}

describe('runRowDeletion', () => {
  it.each([
    [
      'only the test reading the deleted key fails',
      { [A]: ['a'], [B]: ['b'] },
      undefined,
      'asymmetric',
    ],
    ['both tests read both keys', { [A]: ['a', 'b'], [B]: ['a', 'b'] }, undefined, 'symmetric'],
    ['neither test reads a deleted key', { [A]: ['c'], [B]: ['c'] }, undefined, 'symmetric'],
    [
      'a deletion throws a runtime error',
      { [A]: ['a'], [B]: [] },
      'killed-by-test:runtime' as const,
      'inconclusive',
    ],
  ])('classifies a pair where %s', async (_label, reads, failure, outcome) => {
    const { result } = await runWith({ reads, failure });
    expect(result.outcome).toBe(outcome);
    expect(result.deletions).toHaveLength(2);
  });

  it('names the deletions a pair is asymmetric on', async () => {
    const { result } = await runWith({ reads: { [A]: ['a'], [B]: ['b'] } });
    expect(result.deletions.map((deletion) => [deletion.key, deletion.outcome])).toEqual([
      ['s:a', 'asymmetric'],
      ['s:b', 'asymmetric'],
    ]);
    expect(result.reasons).toEqual([]);
  });

  it('is inconclusive when the control run has a failing test, and runs no deletion', async () => {
    const { result, calls } = await runWith({ reads: { [A]: ['a'] }, controlFails: true });
    expect([result.outcome, result.reasons, calls.length]).toEqual([
      'inconclusive',
      ['control-failed'],
      1,
    ]);
  });

  it('is inconclusive when the control run never loads the edited file', async () => {
    const { result, calls } = await runWith({ reads: { [A]: ['a'] }, loadsNothing: true });
    expect([result.outcome, result.reasons, calls.length]).toEqual([
      'inconclusive',
      ['edit-not-loaded'],
      1,
    ]);
    expect(calls[0].probeFiles).toEqual(['src/m.ts']);
  });

  it('is inconclusive without any run when the copy differs from the run manifest', async () => {
    const { result, calls } = await runWith({ reads: { [A]: ['a'] }, foreignCopy: true });
    expect([result.outcome, result.reasons, calls.length]).toEqual([
      'inconclusive',
      ['manifest-mismatch'],
      0,
    ]);
  });

  it('keeps going after a deletion run throws, and restores the file', async () => {
    const { result, calls, copied } = await runWith({ reads: { [A]: ['a'] }, throwsOn: 2 });
    expect(
      result.deletions.map((deletion) => [deletion.key, deletion.outcome, deletion.reason]),
    ).toEqual([
      ['s:a', 'inconclusive', 'run-error'],
      ['s:b', 'symmetric', null],
    ]);
    expect([result.outcome, result.reasons, result.detail, calls.length]).toEqual([
      'inconclusive',
      ['deletion: run-error'],
      'vitest could not start',
      3,
    ]);
    expect(copied).toBe(OBJECT_SOURCE);
  });

  it('bounds every run by the worker bound it is given (the CLI --concurrency)', async () => {
    const { calls } = await runWith({ reads: { [A]: ['a'], [B]: ['b'] }, maxWorkers: 3 });
    expect(calls.map((call) => call.maxWorkers)).toEqual([3, 3, 3]);
  });

  it('gives each run a fresh call that sees its own edit, and restores the file', async () => {
    const { calls, copied } = await runWith({ reads: { [A]: ['a'], [B]: ['b'] } });
    expect(calls.map((call) => call.text.split('\n')[0])).toEqual([
      'const T = { a: 1, b: 2, c: 3 };',
      'const T = {  b: 2, c: 3 };',
      'const T = { a: 1,  c: 3 };',
    ]);
    expect(new Set(calls.map((call) => call.workDir)).size).toBe(3);
    expect(calls.map((call) => call.testIds)).toEqual([
      [A, B],
      [A, B],
      [A, B],
    ]);
    expect(copied).toBe(OBJECT_SOURCE);
  });

  it('returns a plan without deletions as it is, without preparing a copy', async () => {
    const plan = await planOf(
      object(`const T = { a: 1, b: 2, c: 3 };`),
      READ_A,
      READ_A.replace("'a', ()", "'b', ()"),
    );
    const { deps, calls } = fakeDeps({ reads: {} });
    const manifestRoot = tempDir();
    writeTree(manifestRoot, OBJECT_SOURCE);
    const manifest = buildRunManifest({
      preparedRoot: manifestRoot,
      mode: { kind: 'normal' },
      tests: [A, B],
    });
    const [result] = await runRowDeletion(
      { repoRoot: tempDir(), workDir: tempDir(), manifest, plans: [plan] },
      deps,
    );
    expect([result.outcome, result.reasons, calls.length]).toEqual([
      'not-applicable',
      ['no-differing-values'],
      0,
    ]);
  });
});

/**
 * Locks the oracle freeze's sampling and strata rules (U7, KTD11, KTD12): the seeded sample and
 * its top-ups, the per-scope strata requirements, strata counted across scopes, the strata
 * populations from baseline coverage, the resumable launch work dir and the manifest format.
 * Launches are synthetic: the injected launcher only writes launch.json files into a temporary
 * work dir; no process is spawned.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  combineStrata,
  computePopulations,
  eachRowTests,
  evaluateStrata,
  formatJson,
  launchKey,
  ordinalTests,
  parseManifest,
  runLaunches,
  sampleRank,
  selectSample,
  type OracleManifest,
  type PlannedLaunch,
  type Populations,
  type StrataInput,
  type StratumName,
  type StratumRecord,
} from '../../../tools/mutation/oracle/freeze.js';
import type { LaunchOptions, LaunchTarget } from '../../../tools/mutation/oracle/launch-single.js';

const FILE = 'test/unit/a.test.ts';
const MUTANTS = Array.from(
  { length: 40 },
  (_, i) =>
    `gitnexus/src/a.ts@0123456789abcdef:${i + 1}:1-${i + 1}:9:StringLiteral:fedcba9876543210`,
);
const byRank =
  (seed: string) =>
  (a: string, b: string): number =>
    sampleRank(seed, a).localeCompare(sampleRank(seed, b));

const populations = (entries: Partial<Record<StratumName, readonly string[]>>): Populations =>
  new Map(Object.entries(entries).map(([name, ids]) => [name as StratumName, new Set(ids)]));

const target = (name: string, line: number, column = 3, file = FILE): LaunchTarget => ({
  id: `${file}#${name}`,
  file,
  fullName: name,
  location: { line, column },
});

describe('seeded sample (U7 sampling)', () => {
  const sample = (seed: string, mutants: readonly string[] = MUTANTS): string[] =>
    selectSample({ mutants, seed, sampleSize: 10, topUpMin: 0, populations: new Map() }).selected;

  it('gives the same sample for the same seed', () => {
    expect(sample('seed-1')).toEqual(sample('seed-1'));
  });

  it('gives a different sample for a different seed', () => {
    expect(sample('seed-2')).not.toEqual(sample('seed-1'));
  });

  it('does not depend on the input order', () => {
    expect(sample('seed-1', [...MUTANTS].reverse())).toEqual(sample('seed-1'));
  });

  it('takes the lowest ranks of SHA-256(seed + newline + global id)', () => {
    expect(sample('seed-1')).toEqual([...MUTANTS].sort(byRank('seed-1')).slice(0, 10));
  });

  it('takes every mutant when the scope has fewer than the sample size', () => {
    const few = MUTANTS.slice(0, 4);
    expect(sample('seed-1', few).sort()).toEqual([...few].sort());
  });

  it('tops a stratum up with its lowest-ranked members outside the random sample', () => {
    const lastThree = [...MUTANTS].sort(byRank('s')).slice(-3);
    const selection = selectSample({
      mutants: MUTANTS,
      seed: 's',
      sampleSize: 10,
      topUpMin: 2,
      populations: populations({ static: lastThree }),
    });
    expect(selection.topUps).toEqual([
      { globalId: lastThree[0], stratum: 'static' },
      { globalId: lastThree[1], stratum: 'static' },
    ]);
    expect(selection.selected).toHaveLength(12);
  });

  it('adds no top-ups with --top-up-min 0', () => {
    const lastThree = [...MUTANTS].sort(byRank('s')).slice(-3);
    const selection = selectSample({
      mutants: MUTANTS,
      seed: 's',
      sampleSize: 10,
      topUpMin: 0,
      populations: populations({ static: lastThree }),
    });
    expect(selection.topUps).toEqual([]);
  });

  it('counts random members toward a stratum quota', () => {
    const firstTwo = [...MUTANTS].sort(byRank('s')).slice(0, 2);
    const selection = selectSample({
      mutants: MUTANTS,
      seed: 's',
      sampleSize: 10,
      topUpMin: 2,
      populations: populations({ survived: firstTwo }),
    });
    expect(selection.topUps).toEqual([]);
  });
});

const strataInput = (overrides: Partial<StrataInput>): StrataInput => ({
  populations: populations({}),
  selected: [],
  topUps: [],
  constructs: { beforeAll: false, each: false },
  affectedTests: { beforeAll: [], each: [] },
  notOracleValidated: new Set(),
  ...overrides,
});

const statusOf = (records: readonly StratumRecord[], name: StratumName): string | undefined =>
  records.find((record) => record.name === name)?.status;

describe('per-scope strata (KTD11)', () => {
  it('freezes a scope without hooks or it.each without a beforeAll or it.each stratum', () => {
    const records = evaluateStrata(
      strataInput({
        populations: populations({ static: [MUTANTS[0]], survived: [MUTANTS[1]] }),
        selected: [MUTANTS[0]],
      }),
    );
    expect(records.map((record) => [record.name, record.status, record.required])).toEqual([
      ['static', 'combined', false],
      ['hook-hit', 'construct-absent', false],
      ['multi-killer', 'empty-population', false],
      ['survived', 'combined', false],
      ['no-coverage', 'empty-population', false],
      ['each-row', 'construct-absent', false],
    ]);
  });

  it('fails a scope with beforeAll and a hook-hit population whose sample has none', () => {
    const records = evaluateStrata(
      strataInput({
        populations: populations({ 'hook-hit': [MUTANTS[2]] }),
        selected: [MUTANTS[0]],
        constructs: { beforeAll: true, each: false },
        affectedTests: { beforeAll: [`${FILE}#a`, `${FILE}#b`], each: [] },
      }),
    );
    expect(records.find((record) => record.name === 'hook-hit')).toMatchObject({
      required: true,
      status: 'unmet',
      population: 1,
      sampled: 0,
      affectedTests: 2,
    });
  });

  it('waives that stratum when every affected test is marked not oracle-validated', () => {
    const records = evaluateStrata(
      strataInput({
        populations: populations({ 'hook-hit': [MUTANTS[2]] }),
        constructs: { beforeAll: true, each: false },
        affectedTests: { beforeAll: [`${FILE}#a`, `${FILE}#b`], each: [] },
        notOracleValidated: new Set([`${FILE}#a`, `${FILE}#b`]),
      }),
    );
    expect(statusOf(records, 'hook-hit')).toBe('waived');
  });

  it('keeps it unmet when only some affected tests are marked', () => {
    const records = evaluateStrata(
      strataInput({
        populations: populations({ 'hook-hit': [MUTANTS[2]] }),
        constructs: { beforeAll: true, each: false },
        affectedTests: { beforeAll: [`${FILE}#a`, `${FILE}#b`], each: [] },
        notOracleValidated: new Set([`${FILE}#a`]),
      }),
    );
    expect(statusOf(records, 'hook-hit')).toBe('unmet');
  });

  it('records an empty population of a present construct without failing', () => {
    const records = evaluateStrata(
      strataInput({
        constructs: { beforeAll: true, each: true },
        affectedTests: { beforeAll: [`${FILE}#a`], each: [`${FILE}#r1`, `${FILE}#r2`] },
      }),
    );
    expect(
      records
        .filter((record) => record.construct !== null)
        .map((record) => [record.name, record.status, record.required, record.population]),
    ).toEqual([
      ['hook-hit', 'empty-population', false, 0],
      ['each-row', 'empty-population', false, 0],
    ]);
  });

  it('meets an it.each stratum with one sampled row mutant and counts its top-ups', () => {
    const records = evaluateStrata(
      strataInput({
        populations: populations({ 'each-row': [MUTANTS[3], MUTANTS[4]] }),
        selected: [MUTANTS[0], MUTANTS[3]],
        topUps: [{ globalId: MUTANTS[3], stratum: 'each-row' }],
        constructs: { beforeAll: false, each: true },
        affectedTests: { beforeAll: [], each: [`${FILE}#r1`, `${FILE}#r2`] },
      }),
    );
    expect(records.find((record) => record.name === 'each-row')).toMatchObject({
      status: 'met',
      required: true,
      sampled: 1,
      toppedUp: 1,
    });
  });
});

const record = (
  name: StratumName,
  status: StratumRecord['status'],
  population: number,
  sampled: number,
): StratumRecord => ({
  name,
  construct: null,
  constructPresent: null,
  population,
  sampled,
  toppedUp: 0,
  required: status === 'met' || status === 'unmet' || status === 'waived',
  status,
  affectedTests: 0,
});

describe('strata across the scopes combined (KTD11)', () => {
  const scopes = [
    {
      name: 'shared',
      strata: [
        record('static', 'combined', 245, 20),
        record('hook-hit', 'construct-absent', 0, 0),
        record('multi-killer', 'combined', 90, 0),
        record('each-row', 'construct-absent', 0, 0),
      ],
    },
    {
      name: 'schema-constants',
      strata: [
        record('static', 'combined', 72, 72),
        record('hook-hit', 'construct-absent', 0, 0),
        record('multi-killer', 'combined', 3, 2),
        record('each-row', 'empty-population', 0, 0),
      ],
    },
    {
      name: 'middleware',
      strata: [
        record('static', 'combined', 3, 3),
        record('hook-hit', 'empty-population', 0, 0),
        record('multi-killer', 'empty-population', 0, 0),
        record('each-row', 'met', 12, 4),
      ],
    },
  ];
  const combined = combineStrata(scopes);
  const byName = (name: StratumName) => combined.find((entry) => entry.name === name);

  it('sums populations and sampled members over the three scopes', () => {
    expect(byName('static')).toMatchObject({ population: 320, sampled: 95, status: 'met' });
    expect(byName('multi-killer')).toMatchObject({ population: 93, sampled: 2, status: 'met' });
  });

  it('records a stratum whose population is empty everywhere', () => {
    expect(byName('hook-hit')).toMatchObject({
      population: 0,
      sampled: 0,
      status: 'empty-population',
    });
  });

  it('meets a construct stratum one scope samples', () => {
    expect(byName('each-row')).toMatchObject({ population: 12, sampled: 4, status: 'met' });
  });

  it('lists every scope of a stratum', () => {
    expect(byName('static')?.scopes.map((entry) => entry.scope)).toEqual([
      'shared',
      'schema-constants',
      'middleware',
    ]);
  });

  it('fails a stratum with a population but no sampled member anywhere', () => {
    const unmet = combineStrata([
      { name: 'a', strata: [record('no-coverage', 'combined', 5, 0)] },
      { name: 'b', strata: [record('no-coverage', 'empty-population', 0, 0)] },
    ]);
    expect(unmet.find((entry) => entry.name === 'no-coverage')?.status).toBe('unmet');
  });

  it('fails a stratum one scope leaves unmet even when another samples it', () => {
    const unmet = combineStrata([
      { name: 'a', strata: [record('hook-hit', 'unmet', 2, 0)] },
      { name: 'b', strata: [record('hook-hit', 'met', 3, 1)] },
    ]);
    expect(unmet.find((entry) => entry.name === 'hook-hit')?.status).toBe('unmet');
  });
});

describe('strata populations from baseline coverage', () => {
  const ids = ['m0', 'm1', 'm2', 'm3', 'm4', 'm5'].map((id) => `gitnexus/src/a.ts@x:${id}`);
  const mutants = [
    { globalId: ids[0], localId: '0', oracleClass: 'survived' as const, killedBy: [] },
    {
      globalId: ids[1],
      localId: '1',
      oracleClass: 'killed-by-test:assertion' as const,
      killedBy: [`${FILE}#a`, `${FILE}#b`],
    },
    {
      globalId: ids[2],
      localId: '2',
      oracleClass: 'killed-by-test:runtime' as const,
      killedBy: [`${FILE}#a`],
    },
    { globalId: ids[3], localId: '3', oracleClass: 'survived' as const, killedBy: [] },
    { globalId: ids[4], localId: '4', oracleClass: 'survived' as const, killedBy: [] },
    { globalId: ids[5], localId: '5', oracleClass: 'timeout' as const, killedBy: [] },
  ];
  const baseline = [
    { testId: `${FILE}#a`, coverage: { loadAndCollection: ['0'], hook: [], test: ['1', '2'] } },
    { testId: `${FILE}#r1`, coverage: { loadAndCollection: ['0'], hook: ['3'], test: ['4'] } },
  ];
  const result = computePopulations(mutants, baseline, new Set([`${FILE}#r1`]));
  const members = (name: StratumName): string[] => [...(result.get(name) ?? [])].sort();

  it.each([
    ['static', [ids[0]]],
    ['hook-hit', [ids[3]]],
    ['multi-killer', [ids[1]]],
    ['survived', [ids[0], ids[3], ids[4]]],
    ['no-coverage', [ids[5]]],
    ['each-row', [ids[4]]],
  ] as const)('%s', (name, expected) => {
    expect(members(name)).toEqual([...expected].sort());
  });
});

describe('test inventory shapes (KTD3)', () => {
  const inventory = [
    target('S > one', 10),
    target('row 1', 20),
    target('row 2', 20),
    { ...target('dup', 30), id: `${FILE}#dup:30:3:0` },
    { ...target('dup', 30), id: `${FILE}#dup:30:3:1` },
    { ...target('title ends like 1:2:3', 40), id: `${FILE}#title ends like 1:2:3` },
  ];

  it('finds it.each rows by their shared file and location', () => {
    expect(eachRowTests(inventory)).toEqual([
      `${FILE}#row 1`,
      `${FILE}#row 2`,
      `${FILE}#dup:30:3:0`,
      `${FILE}#dup:30:3:1`,
    ]);
  });

  it('finds the tests whose id needed the row ordinal', () => {
    expect(ordinalTests(inventory)).toEqual([`${FILE}#dup:30:3:0`, `${FILE}#dup:30:3:1`]);
  });
});

describe('resumable launches (U7 work dir)', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'oracle-freeze-test-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const plans: PlannedLaunch[] = ['a', 'b', 'c', 'd'].map((name, i) => ({
    key: launchKey('7', `${FILE}#${name}`),
    target: target(name, 10 + i),
    mutantId: '7',
  }));

  const fakeLaunch =
    (calls: string[], validity: 'valid' | 'invalid' = 'valid') =>
    async (options: LaunchOptions): Promise<void> => {
      calls.push(path.relative(root, options.launchDir));
      mkdirSync(options.launchDir, { recursive: true });
      writeFileSync(
        path.join(options.launchDir, 'launch.json'),
        JSON.stringify({
          target: { id: options.target.id },
          mutantId: options.mutantId,
          observation: { validity, outcome: 'survived', reason: null, covering: false },
        }),
      );
    };

  const common = {
    sandboxDir: '/nowhere',
    scopeFile: '/nowhere/scope.json',
    wallClockMs: 1000,
    concurrency: 1,
  };

  it('stops on abort, then skips the done launches and redoes an unfinished one', async () => {
    const launchRoot = path.join(root, 'resume');
    const controller = new AbortController();
    const firstCalls: string[] = [];
    const writeLaunch = fakeLaunch(firstCalls);
    // The first launch finishes, then the freeze is interrupted.
    const first = await runLaunches(plans, {
      ...common,
      launchRoot,
      retryInvalid: false,
      signal: controller.signal,
      launch: async (options) => {
        await writeLaunch(options);
        controller.abort();
      },
    });
    // A launch killed mid-way leaves an attempt dir without launch.json.
    mkdirSync(path.join(launchRoot, plans[2].key, 'attempt-1'), { recursive: true });
    writeFileSync(path.join(launchRoot, plans[2].key, 'attempt-1', 'request.json'), '{}');

    const secondCalls: string[] = [];
    const second = await runLaunches(plans, {
      ...common,
      launchRoot,
      retryInvalid: false,
      launch: fakeLaunch(secondCalls),
    });
    expect({
      first: { aborted: first.aborted, launched: first.launched, calls: firstCalls },
      second: { aborted: second.aborted, launched: second.launched, reused: second.reused },
      secondCalls,
      done: second.completed.size,
      leftover: existsSync(path.join(launchRoot, plans[2].key, 'attempt-1', 'request.json')),
    }).toEqual({
      first: {
        aborted: true,
        launched: 1,
        calls: [path.join('resume', plans[0].key, 'attempt-1')],
      },
      second: { aborted: false, launched: 3, reused: 1 },
      secondCalls: [1, 2, 3].map((i) => path.join('resume', plans[i].key, 'attempt-1')),
      done: 4,
      leftover: false,
    });
  });

  it('gives a done invalid launch a new attempt only with --retry-invalid', async () => {
    const launchRoot = path.join(root, 'retry');
    const one = plans.slice(0, 1);
    await runLaunches(one, {
      ...common,
      launchRoot,
      retryInvalid: false,
      launch: fakeLaunch([], 'invalid'),
    });
    const skipped: string[] = [];
    await runLaunches(one, {
      ...common,
      launchRoot,
      retryInvalid: false,
      launch: fakeLaunch(skipped),
    });
    const retried: string[] = [];
    const result = await runLaunches(one, {
      ...common,
      launchRoot,
      retryInvalid: true,
      launch: fakeLaunch(retried),
    });
    expect({
      skipped,
      retried,
      attempts: readdirSync(path.join(launchRoot, one[0].key)).sort(),
      validity: result.completed.get(one[0].key)?.validity,
    }).toEqual({
      skipped: [],
      retried: [path.join('retry', one[0].key, 'attempt-2')],
      attempts: ['attempt-1', 'attempt-2'],
      validity: 'valid',
    });
  });

  it('refuses a work dir whose launch holds another test', async () => {
    const launchRoot = path.join(root, 'foreign');
    const dir = path.join(launchRoot, plans[0].key, 'attempt-1');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, 'launch.json'),
      JSON.stringify({
        target: { id: `${FILE}#other` },
        mutantId: '7',
        observation: { validity: 'valid', outcome: 'survived', reason: null, covering: null },
      }),
    );
    await expect(
      runLaunches(plans.slice(0, 1), {
        ...common,
        launchRoot,
        retryInvalid: false,
        launch: fakeLaunch([]),
      }),
    ).rejects.toThrow(/use a new work dir/);
  });
});

describe('manifest format (KTD12)', () => {
  const manifest: OracleManifest = {
    schemaVersion: 1,
    kind: 'gitnexus-mutation-oracle-manifest',
    name: 'tiny',
    description: 'a tiny manifest',
    refreeze: 'npm run test:mutation:oracle:freeze -- --from-manifest x --seed <s> --work <w>',
    scope: { testFiles: [FILE], mutate: ['gitnexus/src/a.ts'] },
    versions: { stryker: '10.0.0', vitest: '5.0.5', nodeMajor: 22 },
    operators: { mutator: null, names: ['StringLiteral'] },
    inputs: {
      closure: { 'gitnexus/src/a.ts': 'aa', [`gitnexus/${FILE}`]: 'bb' },
      vitestConfig: { 'gitnexus/vitest.config.ts': 'cc' },
      mutationConfig: { 'gitnexus-shared/package.json': 'dd' },
      prepareTool: { 'gitnexus/tools/mutation/prepare/prepare.ts': 'ee' },
    },
    sample: {
      seed: 's',
      method: 'sha256',
      size: 100,
      topUpMin: 3,
      random: 2,
      topUps: [{ globalId: MUTANTS[2], stratum: 'static' }],
    },
    strata: [record('static', 'combined', 3, 1)],
    baseline: { tests: 2, passedAlone: 2 },
    tests: [`${FILE}#a`, `${FILE}#b`],
    notOracleValidated: [],
    mutants: [
      [MUTANTS[0], 'survived'],
      [MUTANTS[1], 'killed-by-test:assertion'],
    ],
    sampled: [
      {
        id: MUTANTS[1],
        strata: ['multi-killer'],
        covering: 2,
        outcomes: [[1, 'killed-by-test:assertion']],
        invalid: [],
      },
    ],
    launches: { total: 4, valid: 2, invalid: 0, wallClockLimitMs: 180000 },
    warnings: [],
    problems: [],
  };

  it('round-trips through its JSON format', () => {
    expect(parseManifest(formatJson(manifest))).toEqual(manifest);
  });

  it('keeps each mutant row on one line', () => {
    expect(formatJson(manifest).split('\n')).toContain(
      `    ${JSON.stringify([MUTANTS[0], 'survived'])},`,
    );
  });

  it('rejects an outcome row that names a test outside the inventory', () => {
    const broken = {
      ...manifest,
      sampled: [{ ...manifest.sampled[0], outcomes: [[5, 'killed-by-test:assertion']] }],
    };
    expect(() => parseManifest(JSON.stringify(broken))).toThrow(/no test 5/);
  });
});

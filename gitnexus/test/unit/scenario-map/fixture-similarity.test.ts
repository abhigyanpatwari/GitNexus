import { beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  FixtureProfiler,
  compareFixtureProfiles,
  fixtureSimilarityReport,
} from '../../../tools/scenario-map/facet/fixture-profile.js';
import {
  FixtureInputs,
  withFixtureIdentity,
} from '../../../tools/scenario-map/facet/fixture-inputs.js';
import { expandCases } from '../../../tools/scenario-map/inventory/cases.js';
import { findCandidates } from '../../../tools/scenario-map/path-coverage/candidates.js';
import {
  computeFingerprints,
  type FingerprintTestInput,
} from '../../../tools/scenario-map/verdict/fingerprint.js';
import type {
  FacetSources,
  FacetSubject,
  InputFacet,
} from '../../../tools/scenario-map/facet/input-facet.js';
import { SupportedLanguages } from 'gitnexus-shared';
import { layer1Files } from '../../../tools/scenario-map/path-coverage/prefilter.js';
import { isLanguageAvailable } from '../../../src/core/tree-sitter/parser-loader.js';
import { loadPlSqlParser } from '../../../src/core/ingestion/plsql/facts-store.js';

// The PL/SQL parser loads lazily (its pipeline phase awaits it); vitest cannot
// take the synchronous require fallback for TypeScript sources, so preload it.
beforeAll(loadPlSqlParser);

const ROOT = 'gitnexus/test/fixtures';
const FILE = 'gitnexus/test/integration/example.test.ts';
const sources = (files: Record<string, string>): FacetSources => ({
  read: (file) => files[file] ?? null,
  list: (dir) =>
    Object.keys(files)
      .filter((file) => file.startsWith(`${dir}/`))
      .sort(),
});
const subjects = (source: string): FacetSubject[] =>
  expandCases([{ path: FILE, source }]).sites.flatMap((site) =>
    (site.instances ?? []).map((instance, index) => ({
      id: `${site.fullName}:${index}`,
      file: site.file,
      record: site.record,
      instance,
      executedFiles: [],
    })),
  );
const FIXTURES = {
  [`${ROOT}/ts/main.ts`]: 'export function double(x: number) { return x + x; }',
  [`${ROOT}/renamed/main.ts`]:
    '// renamed\nexport function twice(value: number) { return value + value; }',
  [`${ROOT}/py/main.py`]: 'def twice(value):\n    return value + value\n',
  [`${ROOT}/loop/main.ts`]:
    'export function twice(value: number) { while (value > 0) { value--; } return value; }',
};

// Exercise the real native providers, including standalone COBOL and PL/SQL and embedded Vue scripts.
const LANGUAGE_FIXTURES: Record<SupportedLanguages, [string, string]> = {
  typescript: ['ts', 'function twice(x: number) { return x + x; }'],
  javascript: ['js', 'function twice(x) { return x + x; }'],
  python: ['py', 'def twice(x):\n    return x + x\n'],
  go: ['go', 'package main\nfunc twice(x int) int { return x + x }'],
  rust: ['rs', 'fn twice(x: i32) -> i32 { return x + x; }'],
  java: ['java', 'class Sample { static int twice(int x) { return x + x; } }'],
  csharp: ['cs', 'class Sample { static int Twice(int x) { return x + x; } }'],
  c: ['c', 'int twice(int x) { return x + x; }'],
  cpp: ['cpp', 'int twice(int x) { return x + x; }'],
  kotlin: ['kt', 'fun twice(x: Int): Int { return x + x }'],
  php: ['php', '<?php function twice($x) { return $x + $x; }'],
  ruby: ['rb', 'def twice(x)\n  return x + x\nend'],
  swift: ['swift', 'func twice(_ x: Int) -> Int { return x + x }'],
  dart: ['dart', 'int twice(int x) { return x + x; }'],
  zig: ['zig', 'fn twice(x: i32) i32 { return x + x; }'],
  'objective-c': [
    'm',
    '@interface Sample\n- (int)twice:(int)x;\n@end\n@implementation Sample\n- (int)twice:(int)x { return x + x; }\n@end',
  ],
  vue: [
    'vue',
    '<script lang="ts">function twice(x: number) { return x + x; }</script><template><p>Hello</p></template>',
  ],
  cobol: [
    'cbl',
    '       IDENTIFICATION DIVISION.\n       PROGRAM-ID. SAMPLE.\n       PROCEDURE DIVISION.\n       MAIN-PARA.\n           DISPLAY "HI".\n           STOP RUN.\n',
  ],
  plsql: [
    'prc',
    'CREATE OR REPLACE FUNCTION twice(x NUMBER) RETURN NUMBER IS\nBEGIN\n  RETURN x + x;\nEND twice;\n/\n',
  ],
};

it.each(Object.entries(LANGUAGE_FIXTURES))(
  'profiles real %s fixtures with the ingestion provider',
  async (language, [extension, content]) => {
    const root = `${ROOT}/language-${language}`;
    const profiler = new FixtureProfiler(sources({ [`${root}/main.${extension}`]: content }));
    const result = await profiler.profile([root]);
    if (
      language !== SupportedLanguages.Cobol &&
      language !== SupportedLanguages.PlSql &&
      !isLanguageAvailable(language as SupportedLanguages, `main.${extension}`)
    ) {
      expect(result.contentKey).not.toBeNull();
      expect(result.unresolved.length).toBeGreaterThan(0);
      return;
    }
    expect(result.unresolved).toEqual([]);
    expect(result.languages).toEqual([language]);
    expect(result.features.some(([feature]) => feature.startsWith('def:'))).toBe(true);
    expect(result.contentKey).not.toBeNull();
  },
);

describe('fixture similarity', () => {
  it('retrieves renamed and cross-language fixtures, without conflating a loop with straight-line code', async () => {
    const profiler = new FixtureProfiler(sources(FIXTURES));
    const [ts, renamed, py, loop] = await Promise.all(
      ['ts', 'renamed', 'py', 'loop'].map((name) => profiler.profile([`${ROOT}/${name}`])),
    );
    expect(compareFixtureProfiles(ts, renamed)).toEqual({
      kind: 'structure',
      score: 1,
      crossLanguage: false,
    });
    expect(compareFixtureProfiles(ts, py)).toEqual({
      kind: 'structure',
      score: 1,
      crossLanguage: true,
    });
    expect(compareFixtureProfiles(ts, loop)).toBeNull();
    expect(new Set([ts.contentKey, renamed.contentKey, py.contentKey]).size).toBe(3);
    const candidate = (id: string, fixture: typeof ts, checks = 'assertion') => ({
      id,
      blocks: [id.charCodeAt(0)],
      concurrent: false,
      checksContext: id,
      bodyKey: id,
      checks,
      fixture,
    });
    const found = findCandidates([
      candidate('a', ts),
      candidate('b', py),
      candidate('c', loop),
      candidate('d', py, 'different'),
    ]);
    expect(found.pairs).toHaveLength(1);
    expect(found.pairs[0]).toMatchObject({
      a: 'a',
      b: 'b',
      sources: ['fixture'],
      fixtureSimilarity: { crossLanguage: true },
    });
    expect(found.stats.bySource.fixture).toBe(1);
    const report = fixtureSimilarityReport(
      [
        { id: 'a', fixture: ts },
        { id: 'b', fixture: py },
        { id: 'another', fixture: ts },
      ],
      found.pairs,
    );
    expect(report.summary).toMatchObject({
      tests: 3,
      profiles: 2,
      matches: 1,
      crossLanguageMatches: 1,
    });
    expect(report.profiles.find((entry) => entry.profile === ts)?.tests).toEqual(['a', 'another']);
    expect(findCandidates([candidate('a', ts), candidate('b', py)], () => false).pairs).toEqual([]);
  });

  it('keeps file multiplicity, layout, and non-source assets in exact input identity', async () => {
    const profiler = new FixtureProfiler(
      sources({
        [`${ROOT}/a/main.ts`]: FIXTURES[`${ROOT}/ts/main.ts`],
        [`${ROOT}/b/main.ts`]: FIXTURES[`${ROOT}/ts/main.ts`],
        [`${ROOT}/c/nested/main.ts`]: FIXTURES[`${ROOT}/ts/main.ts`],
        [`${ROOT}/d/main.ts`]: FIXTURES[`${ROOT}/ts/main.ts`],
        [`${ROOT}/d/package.json`]: '{"type":"module"}',
        [`${ROOT}/e/one.ts`]: FIXTURES[`${ROOT}/ts/main.ts`],
        [`${ROOT}/e/two.ts`]: FIXTURES[`${ROOT}/ts/main.ts`],
      }),
    );
    const [a, b, c, d, e] = await Promise.all(
      ['a', 'b', 'c', 'd', 'e'].map((name) => profiler.profile([`${ROOT}/${name}`])),
    );
    expect(compareFixtureProfiles(a, b)?.kind).toBe('content');
    expect(new Set([a.contentKey, c.contentKey, d.contentKey, e.contentKey]).size).toBe(4);
    expect(compareFixtureProfiles(a, e)).toBeNull();
  });

  it('reports missing, malformed, and oversized fixtures instead of matching partial profiles', async () => {
    const profiler = new FixtureProfiler(
      sources({
        ...FIXTURES,
        [`${ROOT}/broken/main.ts`]: 'export function () { return (',
        [`${ROOT}/large/main.ts`]: ' '.repeat(200_001),
      }),
    );
    const baseline = await profiler.profile([`${ROOT}/ts`]);
    for (const root of ['missing', 'broken', 'large']) {
      const result = await profiler.profile([`${ROOT}/${root}`]);
      if (root === 'broken') {
        expect(result.contentKey).not.toBeNull();
        expect(compareFixtureProfiles(result, result)?.kind).toBe('content');
      } else expect(result.contentKey).toBeNull();
      expect(result.unresolved.length).toBeGreaterThan(0);
      expect(compareFixtureProfiles(result, baseline)).toBeNull();
    }
  });
});

it('retains fixture partners in diff selection even when their setup and callbacks differ', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'fixture-similarity-'));
  try {
    const files = ['test/integration/a.test.ts', 'test/integration/b.test.ts'];
    files.forEach((file, i) => {
      const target = path.join(root, 'gitnexus', file);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(
        target,
        `import path from 'node:path';
        beforeAll(() => setup(${i}));
        it('test', () => { const content${i} = readFileSync(path.join(__dirname, '..', 'fixtures', '${i}.ts')); expect(content${i}).toBeDefined(); });`,
      );
      mkdirSync(path.join(root, 'gitnexus/test/fixtures'), { recursive: true });
      writeFileSync(
        path.join(root, `gitnexus/test/fixtures/${i}.ts`),
        `function f${i}() { return 1; }`,
      );
    });
    expect(layer1Files(root, files, new Set([files[0]]))).toEqual({ files, skipped: [] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('fixture input discovery', () => {
  it('does not resolve an unknown helper/callback argument using a shadowed outer constant', () => {
    const inputs = new FixtureInputs(sources(FIXTURES));
    const [subject] = subjects(`
      const root = '${ROOT}/ts';
      const load = (root) => runPipelineFromRepo(root);
      it('unknown', () => { load(dynamicRoot()); values.forEach((root) => readFileSync(root)); });
    `);
    expect(inputs.resolve(subject).roots).toEqual([]);
    expect(inputs.resolve(subject).unresolved).toHaveLength(2);
  });
  it('follows imported roots and local setup constants without collecting assertion strings', async () => {
    const inputs = new FixtureInputs(
      sources({
        ...FIXTURES,
        'gitnexus/test/integration/helpers.ts': `import path from 'node:path'; export const FIXTURES = path.resolve(__dirname, '..', 'fixtures');`,
      }),
    );
    const [subject] = subjects(`
      import path from 'node:path'; import { FIXTURES } from './helpers.js';
      describe('suite', () => {
        beforeAll(() => { const root = path.join(FIXTURES, 'ts'); runPipelineFromRepo(root); });
        it('one', () => { expect(result).toContain('${ROOT}/py'); });
      });
    `);
    expect(inputs.resolve(subject)).toEqual({ roots: [`${ROOT}/ts`], unresolved: [] });
    expect((await inputs.profile(subject))?.languages).toEqual(['typescript']);
  });

  it('resolves per-row directories and both calls to an imported helper', () => {
    const inputs = new FixtureInputs(
      sources({
        ...FIXTURES,
        'gitnexus/test/integration/helpers.ts': `import path from 'node:path'; export function analyzeFixture(name) { return runPipelineFromRepo(path.join(__dirname, '..', 'fixtures', name)); }`,
      }),
    );
    const rows = subjects(`import path from 'node:path'; it.each(['ts','py'])('row %s', (name) => {
      const root = path.join(__dirname, '..', 'fixtures', name); runPipelineFromRepo(root); expect(result).toBeDefined();
    });`);
    expect(rows.map((row) => inputs.resolve(row).roots)).toEqual([[`${ROOT}/ts`], [`${ROOT}/py`]]);
    const [helper] = subjects(`import { analyzeFixture } from './helpers.js'; it('both', () => {
      analyzeFixture('ts'); analyzeFixture('py'); expect(result).toBeDefined();
    });`);
    expect(inputs.resolve(helper)).toEqual({ roots: [`${ROOT}/py`, `${ROOT}/ts`], unresolved: [] });
  });

  it('handles file URL inputs and exposes dynamically chosen inputs', () => {
    const inputs = new FixtureInputs(sources(FIXTURES));
    const [known, unknown] =
      subjects(`it('url', () => { readFileSync(new URL('../fixtures/ts/main.ts', import.meta.url)); });
      it('dynamic', () => { runPipelineFromRepo(selectFixture()); });`);
    expect(inputs.resolve(known)).toEqual({ roots: [`${ROOT}/ts/main.ts`], unresolved: [] });
    expect(inputs.resolve(unknown).unresolved).toEqual([
      expect.stringContaining('unresolved fixture input'),
    ]);
  });

  it('does not crash on spread arguments and resolves aliased path and ingestion imports', () => {
    const inputs = new FixtureInputs(sources(FIXTURES));
    const [spread, alias] = subjects(`
      import { join as combine } from 'node:path'; import { runPipelineFromRepo as ingest } from '../../src/core/ingestion/pipeline.js';
      it('spread', () => { runPipelineFromRepo(...args); });
      it('alias', () => { ingest(combine(__dirname, '..', 'fixtures', 'ts')); });
    `);
    expect(inputs.resolve(spread).unresolved).toHaveLength(1);
    expect(inputs.resolve(alias)).toEqual({ roots: [`${ROOT}/ts`], unresolved: [] });
  });

  it('handles bigint rows and keeps hook constants separate from test-local shadowing', () => {
    const inputs = new FixtureInputs(sources(FIXTURES));
    const rows =
      subjects(`import path from 'node:path'; const root = path.join(__dirname, '..', 'fixtures', 'ts');
      beforeAll(() => runPipelineFromRepo(root));
      it.each([1n, 2n])('bigint %s', (n) => { const root = 'not-a-fixture'; expect(n).toBeDefined(); });`);
    expect(rows.map((row) => inputs.resolve(row))).toEqual([
      { roots: [`${ROOT}/ts`], unresolved: [] },
      { roots: [`${ROOT}/ts`], unresolved: [] },
    ]);
  });
});

it.each([
  ['ts', 'py', 'input-shape-differs'],
  ['broken', 'broken', 'input-unresolved'],
])(
  'does not confirm %s/%s fixtures despite equal paths, assertions, and clean traces',
  async (left, right, rule) => {
    const profiler = new FixtureProfiler(
      sources({ ...FIXTURES, [`${ROOT}/broken/main.ts`]: 'function () {' }),
    );
    const [a, b] = await Promise.all(
      [left, right].map((name) => profiler.profile([`${ROOT}/${name}`])),
    );
    const facet: InputFacet = {
      fingerprint: 'same',
      parts: { language: '-', source: [], fixtures: [], data: [], calls: [], order: [] },
      discarded: [],
      unresolved: [],
      skeleton: [],
    };
    const test = (id: string, profile: typeof a): FingerprintTestInput => ({
      id,
      fingerprintEligible: true,
      passed: true,
      dupeOk: null,
      joinProblems: [],
      inventoryUnresolved: [],
      provenance: { known: true, nativeEntries: [], workerSpawns: [] },
      concurrent: false,
      checksContext: 'same',
      checks: 'same',
      unsupportedForms: [],
      unresolvedSelectors: [],
      facet: withFixtureIdentity(facet, profile),
    });
    const result = computeFingerprints({
      tests: [test('a', a), test('b', b)],
      pairs: [
        {
          a: 'a',
          b: 'b',
          group: 'g',
          identicalBlocks: true,
          pathUnattributable: false,
          trace: { status: 'clean', reasons: [] },
        },
      ],
    });
    expect(result.pairs[0].verdict).not.toBe('duplicate');
    expect(result.pairs[0].rule).toBe(rule);
  },
);

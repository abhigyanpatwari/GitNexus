/**
 * Locks the scenario map report (U13, R12, KTD13, KTD15, design §5.5, §7, §8): mutant fingerprints
 * (span-free, operator, replacement, enclosing statement, fallbacks), KTD13 universe ids, evidence
 * hashes (an engine-version bump changes every one, regrouping keeps them), the seeded spot audit,
 * "N of M evaluated", completeness, the Layer 0 section, KTD15 provenance collection and the
 * markdown rendering.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { contentHash } from '../../../tools/mutation/prepare/mutant-identity.js';
import {
  fingerprintMutants,
  universeIdOf,
  type FingerprintFallback,
} from '../../../tools/scenario-map/report/anchors.js';
import { mdCode, renderMarkdown } from '../../../tools/scenario-map/report/markdown.js';
import {
  PRECISION_NOT_MEASURED,
  REDACTED,
  buildReport,
  collectProvenance,
  spotAudit,
  type SpotAuditPick,
} from '../../../tools/scenario-map/report/report.js';
import { SCENARIO_MAP_SCHEMA_VERSION } from '../../../tools/scenario-map/types.js';
import { A, B, C, FILE, M1, M2, M3, fingerprints, reportInput } from './report-fixtures.js';

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
const SRC = 'gitnexus/src/math.ts';
const idOf = (source: string, span: string, mutator: string, replacement: string): string =>
  `${SRC}@${contentHash(source).slice(0, 16)}:${span}:${mutator}:${sha256(replacement).slice(0, 16)}`;
const fingerprintIn = (source: string, id: string): string =>
  fingerprintMutants([id], () => source).get(id)?.fingerprint ?? '';

// ── Mutant fingerprints ────────────────────────────────────────────────────

const ADD = 'export function add(a: number, b: number): number {\n  return a + b;\n}\n';
const ADD_ID = idOf(ADD, '2:10-2:15', 'ArithmeticOperator', 'a - b');

describe('mutant fingerprint', () => {
  it('survives lines inserted above the mutant (no revision, no span)', () => {
    const shifted = `// header\n\n${ADD}`;
    const moved = idOf(shifted, '4:10-4:15', 'ArithmeticOperator', 'a - b');
    expect(fingerprintIn(shifted, moved)).toBe(fingerprintIn(ADD, ADD_ID));
    expect(fingerprintMutants([ADD_ID], () => ADD).get(ADD_ID)?.fallback).toBeNull();
  });

  it.each([
    ['operator', ADD, idOf(ADD, '2:10-2:15', 'StringLiteral', 'a - b')],
    ['replacement', ADD, idOf(ADD, '2:10-2:15', 'ArithmeticOperator', 'a * b')],
    [
      'enclosing statement',
      ADD.replace('a + b;', 'a + b + 0;'),
      idOf(ADD.replace('a + b;', 'a + b + 0;'), '2:10-2:15', 'ArithmeticOperator', 'a - b'),
    ],
  ])('changes with the %s', (_part, source, id) => {
    expect(fingerprintIn(source, id)).not.toBe(fingerprintIn(ADD, ADD_ID));
  });

  it('tells apart equal mutants of one statement by occurrence', () => {
    const source = "export const k = f('a') + f('a');\n";
    const first = idOf(source, '1:20-1:23', 'StringLiteral', '""');
    const second = idOf(source, '1:29-1:32', 'StringLiteral', '""');
    const result = fingerprintMutants([first, second], () => source);
    expect(result.get(first)?.fingerprint).not.toBe(result.get(second)?.fingerprint);
  });

  it('takes a class member, not the whole class, as the enclosing statement', () => {
    const before = "class K {\n  s = new Set(['a']);\n  m() { return 1; }\n}\n";
    const after = before.replace('return 1', 'return 2');
    const span = '2:16-2:19';
    expect(fingerprintIn(after, idOf(after, span, 'StringLiteral', '""'))).toBe(
      fingerprintIn(before, idOf(before, span, 'StringLiteral', '""')),
    );
  });

  it.each<[FingerprintFallback, string, string | null]>([
    ['malformed-id', 'not-a-global-id', ADD],
    ['unreadable', ADD_ID, null],
    ['content-changed', ADD_ID, ADD.replace('a + b', 'b + a')],
    [
      'unparsable',
      idOf('export const = ;\n', '1:1-1:2', 'StringLiteral', ''),
      'export const = ;\n',
    ],
    ['span-outside', idOf(ADD, '9:1-9:2', 'ArithmeticOperator', 'a - b'), ADD],
    ['no-statement', idOf('a;\nb;\n', '1:1-2:3', 'BlockStatement', '{}'), 'a;\nb;\n'],
  ])('falls back to the global id when %s', (fallback, id, source) => {
    expect(fingerprintMutants([id], () => source).get(id)?.fallback).toBe(fallback);
  });
});

describe('universeIdOf', () => {
  it('names a universe by its sorted fingerprints, whatever their order', () => {
    expect(universeIdOf(['m2', 'm1'])).toBe(universeIdOf(['m1', 'm2']));
    expect(universeIdOf(['m1'])).not.toBe(universeIdOf(['m1', 'm2']));
    expect(universeIdOf([])).toBeNull();
  });
});

// ── Evidence hashes (KTD13) ────────────────────────────────────────────────

describe('evidence hash', () => {
  it('changes for every item on a verdict-engine version bump alone', () => {
    const before = buildReport(reportInput());
    const bumped = buildReport(
      reportInput({
        verdicts: (report) => ({ ...report, engineVersion: report.engineVersion + 1 }),
      }),
    );
    const hashes = new Set(before.continuity.items.map((item) => item.evidenceHash));
    expect(bumped.continuity.items).toHaveLength(before.continuity.items.length);
    expect(bumped.continuity.items.filter((item) => hashes.has(item.evidenceHash))).toEqual([]);
  });

  it('stays when a regrouping leaves the common universe unchanged', () => {
    const before = buildReport(reportInput());
    const regrouped = buildReport(reportInput({ group: 'g-regrouped' }));
    expect(regrouped.pairs.map((pair) => pair.group)).toEqual(['g-regrouped', 'g-regrouped']);
    expect(regrouped.pairs[0].evidence.universeId).not.toBe(before.pairs[0].evidence.universeId);
    expect(regrouped.pairs.map((pair) => pair.universe)).toEqual(
      before.pairs.map((pair) => pair.universe),
    );
    expect(regrouped.continuity.items).toEqual(before.continuity.items);
  });

  it('changes when a mutant of the common universe changes', () => {
    const before = buildReport(reportInput());
    const renewed = fingerprints([M1, M2, M3]);
    renewed.set(M2, { fingerprint: 'm-renewed', fallback: null });
    const after = buildReport(reportInput({ overrides: { fingerprints: renewed } }));
    expect(after.pairs[0].universe.id).not.toBe(before.pairs[0].universe.id);
    expect(after.pairs[0].evidenceHash).not.toBe(before.pairs[0].evidenceHash);
  });

  it('is byte-identical for reordered observations', () => {
    const input = reportInput();
    const reordered = {
      ...input,
      evidence: {
        ...input.evidence,
        observations: {
          ...input.evidence.observations,
          explicit: [...input.evidence.observations.explicit].reverse(),
        },
      },
    };
    expect(JSON.stringify(buildReport(reordered))).toBe(JSON.stringify(buildReport(input)));
  });
});

// ── Spot audit (design §8) ─────────────────────────────────────────────────

const candidates = (count: number): SpotAuditPick[] =>
  Array.from({ length: count }, (_, i) => ({ key: `pair:k${i}`, a: `a${i}`, b: `b${i}` }));

describe('spot audit', () => {
  it('picks the same 10 strong candidates with seed s1 on two runs, in any input order', () => {
    const first = spotAudit(candidates(25), 's1');
    expect(first.picks).toHaveLength(10);
    expect(spotAudit(candidates(25), 's1')).toEqual(first);
    expect(spotAudit([...candidates(25)].reverse(), 's1')).toEqual(first);
    expect(spotAudit(candidates(25), 's2').picks).not.toEqual(first.picks);
  });

  it('picks every strong candidate when there are fewer than 10', () => {
    const audit = spotAudit(candidates(3), 's1');
    expect(audit.picks.map((pick) => pick.key).sort()).toEqual(['pair:k0', 'pair:k1', 'pair:k2']);
    expect(audit).toMatchObject({ seed: 's1', size: 10, candidates: 3 });
  });

  it('records the seed and samples the strong repeats of a report', () => {
    const report = buildReport(reportInput());
    expect(report.seed).toBe('s1');
    expect(report.spotAudit.picks).toEqual([{ key: report.pairs[0].key, a: A, b: B }]);
  });
});

// ── Report sections ────────────────────────────────────────────────────────

describe('buildReport', () => {
  it('carries the schema and engine versions, the verdicts and the limits', () => {
    const report = buildReport(reportInput());
    expect(report).toMatchObject({
      schemaVersion: SCENARIO_MAP_SCHEMA_VERSION,
      engineVersion: 1,
      summary: {
        byVerdict: { 'repeat-strong': 1, weak: 1 },
        testsByStatus: { killing: 2, weak: 1 },
        gapFiles: 1,
        survived: 1,
        uncovered: 1,
      },
    });
    expect(report.pairs.map((pair) => [pair.a, pair.b, pair.verdict])).toEqual([
      [A, B, 'repeat-strong'],
      [A, C, 'weak'],
    ]);
    expect(report.limits[0]).toBe(PRECISION_NOT_MEASURED);
    expect(report.provenance.operators).toEqual({
      mutator: null,
      names: ['ArithmeticOperator', 'BlockStatement', 'ConditionalExpression'],
    });
  });

  it('counts N of M eligible tests evaluated', () => {
    const other = 'test/unit/other.test.ts#other > runs alone';
    const report = buildReport(reportInput({ overrides: { eligibleTests: [A, B, C, other] } }));
    expect(report.summary.evaluated).toBe('3 of 4 eligible tests evaluated');
  });

  it.each([
    [
      'an incomplete shard',
      { planned: 2, complete: 1, incomplete: [{ shard: '1', reason: 'timeout' }] },
      false,
    ],
    ['every shard complete', { planned: 2, complete: 2, incomplete: [] }, true],
  ])('records completeness with %s', (_title, shards, complete) => {
    const report = buildReport(reportInput({ degraded: ['no-pdg-layer'], overrides: { shards } }));
    expect(report.completeness).toMatchObject({
      complete,
      partial: !complete,
      degraded: ['no-pdg-layer'],
    });
  });

  it('keeps the Layer 0 findings of eligible files only', () => {
    const finding = (file: string) => ({
      kind: 'same-test',
      file,
      line: 3,
      matches: [],
      detail: 'same body',
    });
    const layer0 = {
      version: 1,
      scanned: 2,
      skipped: [],
      findings: [
        finding('gitnexus/test/unit/other.test.ts'),
        finding('gitnexus/test/unit/add.test.ts'),
      ],
    };
    const report = buildReport(reportInput({ overrides: { layer0 } }));
    expect(report.layer0).toEqual({
      available: true,
      scanned: 2,
      findings: [finding('gitnexus/test/unit/add.test.ts')],
      skipped: [],
    });
  });

  it('gives a test without a static join an execution-identity anchor', () => {
    const report = buildReport(reportInput({ overrides: { anchors: new Map() } }));
    expect(report.tests.map((test) => test.anchor.key.startsWith('exec:'))).toEqual([
      true,
      true,
      true,
    ]);
    expect(report.tests.map((test) => test.anchor.rowFingerprint)).toEqual([null, null, null]);
  });
});

// ── Provenance (KTD15) ─────────────────────────────────────────────────────

const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'scenario-map-report-'));
afterAll(() => rmSync(tempRoot, { recursive: true, force: true }));

const writeRepoFile = (repoPath: string, text: string): void => {
  mkdirSync(path.dirname(path.join(tempRoot, repoPath)), { recursive: true });
  writeFileSync(path.join(tempRoot, repoPath), text);
};

describe('collectProvenance', () => {
  writeRepoFile('gitnexus/test/unit/a.test.ts', 'test text');
  writeRepoFile('gitnexus/src/x.ts', 'production text');
  writeRepoFile('gitnexus/package-lock.json', '{}');
  writeRepoFile('gitnexus/node_modules/vitest/package.json', '{"version":"5.0.1"}');
  writeRepoFile('gitnexus/tools/mutation/runner/plugin.ts', 'runner');
  const provenance = collectProvenance({
    repoRoot: tempRoot,
    testFiles: ['test/unit/a.test.ts'],
    productionFiles: ['gitnexus/src/x.ts'],
    fixtureFiles: ['gitnexus/test/fixtures/missing.json'],
    sourceRevision: 'abc',
    env: {
      GITNEXUS_HOME: '/h',
      GITNEXUS_API_KEY: 'secret',
      GITNEXUS_MCP_DEFAULT_MAX_TOKENS: '5',
      PATH: '/bin',
    },
    node: 'v24.1.0',
    os: 'linux test x64',
  });

  it('hashes test, production and fixture files and the lockfiles', () => {
    expect(provenance.files).toEqual({
      tests: { 'test/unit/a.test.ts': sha256('test text') },
      production: { 'gitnexus/src/x.ts': sha256('production text') },
      fixtures: { 'gitnexus/test/fixtures/missing.json': 'absent' },
    });
    expect(provenance.lockfiles).toEqual({
      'gitnexus-shared/package-lock.json': 'absent',
      'gitnexus/package-lock.json': sha256('{}'),
    });
  });

  it('records versions, runtime and only the GITNEXUS_ variables, secrets redacted', () => {
    expect(provenance.versions).toMatchObject({ vitest: '5.0.1', stryker: null, typescript: null });
    expect(provenance.versions.runner).toMatch(/^[0-9a-f]{64}$/);
    expect(provenance.runtime).toEqual({
      node: 'v24.1.0',
      os: 'linux test x64',
      env: {
        GITNEXUS_API_KEY: REDACTED,
        GITNEXUS_HOME: '/h',
        GITNEXUS_MCP_DEFAULT_MAX_TOKENS: '5',
      },
    });
    expect(provenance.sourceRevision).toBe('abc');
  });
});

// ── Markdown ───────────────────────────────────────────────────────────────

describe('renderMarkdown', () => {
  const markdown = renderMarkdown(buildReport(reportInput()));

  it.each([
    ['the title', '# Test scenario map'],
    ['N of M', '**3 of 3 eligible tests evaluated.**'],
    ['the precision statement', PRECISION_NOT_MEASURED],
    ['the baseline banner', 'first run, no baseline'],
    ['the strong repeats', '## Strong repeat candidates (1)'],
    ['the spot audit seed', '## Spot audit (seed `s1`'],
    ['the weak tests', '## Weak tests (1)'],
    ['the gap file', `| ${mdCode(FILE)} |`],
    ['a strong pair member', mdCode(A)],
  ])('shows %s', (_title, text) => {
    expect(markdown).toContain(text);
  });

  it.each([
    ['plain text', 'a > b', '`a > b`'],
    ['a pipe', 'a | b', '`a \\| b`'],
    ['a backtick', 'a `b`', '`` a `b` ``'],
    ['a newline', 'a\nb', '`a b`'],
  ])('renders %s as an inline code cell', (_title, text, expected) => {
    expect(mdCode(text)).toBe(expected);
  });
});

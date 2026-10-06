import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { EXPECTATIONS } from '../../bench/tool-accuracy/expectations.js';
import {
  formatAccuracyMarkdown,
  scoreAccuracy,
  type KnownGapManifest,
} from '../../bench/tool-accuracy/score.js';

const SOURCE = { sha: 'a'.repeat(40), dirty: false, fixtureSha: 'b'.repeat(64) };
const EMPTY: KnownGapManifest = { schemaVersion: 1, baselineSourceSha: SOURCE.sha, gaps: [] };
const perfect = () =>
  Object.fromEntries(EXPECTATIONS.map((entry) => [entry.id, [...entry.expected]]));
const known = (id: string, baselineActual: string[]): KnownGapManifest => ({
  ...EMPTY,
  gaps: [
    {
      id,
      issue: EXPECTATIONS.find((entry) => entry.id === id)!.issue,
      reason: 'Reviewed fixture repro',
      baselineActual,
    },
  ],
});

describe('deterministic tool-accuracy scoring and release gate', () => {
  it('accepts exactly the tracked reviewed baseline while openly counting its failures', () => {
    const manifest: KnownGapManifest = JSON.parse(
      readFileSync(new URL('../../bench/tool-accuracy/known-gaps.json', import.meta.url), 'utf8'),
    );
    const observations = {
      ...perfect(),
      ...Object.fromEntries(manifest.gaps.map((gap) => [gap.id, gap.baselineActual])),
    };
    const report = scoreAccuracy(observations, manifest, SOURCE);
    expect(report.gate.passed).toBe(true);
    expect(report.summary.failed).toBe(manifest.gaps.length);
    expect(
      report.cases.filter((entry) => entry.status === 'known-gap').map((entry) => entry.id),
    ).toEqual(manifest.gaps.map((gap) => gap.id));
  });

  it('scores desired answers independently and covers every linked public issue', () => {
    const report = scoreAccuracy(perfect(), EMPTY, SOURCE);
    expect(report.summary).toEqual({
      total: EXPECTATIONS.length,
      passed: EXPECTATIONS.length,
      failed: 0,
      accuracy: 1,
    });
    expect(report.gate.passed).toBe(true);
    expect(report.issueIds).toEqual([3486, 3487, 3488, 3489, 3490, 3491, 3497, 3498, 3499]);
  });

  it('reports a known failure as a failure even when the regression gate passes', () => {
    const actual = { ...perfect(), 'python.module-chain': [] };
    const report = scoreAccuracy(actual, known('python.module-chain', []), SOURCE);
    expect(report.gate.passed).toBe(true);
    expect(report.summary.failed).toBe(1);
    expect(report.cases.find((entry) => entry.id === 'python.module-chain')).toMatchObject({
      expected: ['pkg/facade.py:target'],
      actual: [],
      status: 'known-gap',
      passed: false,
      precision: 0,
      recall: 0,
    });
    const markdown = formatAccuracyMarkdown(report);
    expect(markdown).toContain('30/31 fixed answers pass');
    expect(markdown).toContain('1 fail');
    expect(markdown).toContain('Regression gate: **PASS**');
    expect(markdown).toContain(`Source SHA: \`${SOURCE.sha}\``);
    expect(markdown).toContain('#3497');
    expect(markdown).toContain('actual `[]`');
  });

  it('rejects every new failed check while preserving an existing known failure', () => {
    const actual = { ...perfect(), 'python.module-chain': [], 'api.literal-control': [] };
    const report = scoreAccuracy(actual, known('python.module-chain', []), SOURCE);
    expect(report.gate.passed).toBe(false);
    expect(report.gate.unexpectedFailures).toEqual(['api.literal-control']);
  });

  it('escapes existing backslashes before pipes in failed Markdown answers', () => {
    const report = scoreAccuracy(
      { ...perfect(), 'python.module-chain': ['path\\|column'] },
      EMPTY,
      SOURCE,
    );
    // JSON adds two backslashes; Markdown must escape both plus the pipe.
    expect(formatAccuracyMarkdown(report)).toContain('path' + '\\'.repeat(5) + '|column');
  });

  it.each([
    { label: 'missing', value: undefined },
    { label: 'null', value: null },
    { label: 'scalar string', value: 'exact' },
    { label: 'array containing null', value: [null] },
    { label: 'array containing a number', value: [1] },
  ])('cannot use an allowance to hide malformed/missing observations ($label)', ({ value }) => {
    const actual: Record<string, unknown> = { ...perfect(), 'python.module-chain': value };
    const report = scoreAccuracy(actual, known('python.module-chain', []), SOURCE);
    expect(report.gate.passed).toBe(false);
    expect(report.gate.errors).toContain('Missing or malformed observation: python.module-chain');
  });

  it('rejects tool execution errors even with known failures', () => {
    const report = scoreAccuracy(
      { ...perfect(), 'python.module-chain': [] },
      known('python.module-chain', []),
      SOURCE,
      ['explain returned truncated output'],
    );
    expect(report.gate.passed).toBe(false);
    expect(report.gate.errors).toContain('explain returned truncated output');
  });

  it('requires removal of an allowance in the PR that repairs its fixed answer', () => {
    const report = scoreAccuracy(perfect(), known('python.module-chain', []), SOURCE);
    expect(report.gate.passed).toBe(false);
    expect(report.gate.staleAllowances).toEqual(['python.module-chain']);
    expect(formatAccuracyMarkdown(report)).toContain(
      'Remove repaired allowances in this PR: python.module-chain',
    );
  });

  it('rejects lost correct facts and new wrong facts inside an already failing check', () => {
    const expected = EXPECTATIONS.find((entry) => entry.id === 'rename.references')!.expected;
    const manifest = known('rename.references', [expected[0], 'wrong-old']);
    expect(
      scoreAccuracy(
        { ...perfect(), 'rename.references': [expected[0], expected[1], 'wrong-old'] },
        manifest,
        SOURCE,
      ).gate.passed,
    ).toBe(true);
    expect(
      scoreAccuracy({ ...perfect(), 'rename.references': ['wrong-old'] }, manifest, SOURCE).gate
        .passed,
    ).toBe(false);
    expect(
      scoreAccuracy(
        { ...perfect(), 'rename.references': [expected[0], 'wrong-new'] },
        manifest,
        SOURCE,
      ).gate.passed,
    ).toBe(false);
  });

  it('counts duplicate answers instead of discarding unexpected repeated edits', () => {
    const expected = EXPECTATIONS.find((entry) => entry.id === 'api.literal-control')!.expected;
    const report = scoreAccuracy(
      { ...perfect(), 'api.literal-control': [...expected, ...expected] },
      EMPTY,
      SOURCE,
    );
    expect(report.gate.passed).toBe(false);
    expect(report.cases.find((entry) => entry.id === 'api.literal-control')).toMatchObject({
      precision: 0.5,
      recall: 1,
      unexpected: expected,
    });
  });

  it('rejects unknown, duplicated and malformed allowances', () => {
    const gap = known('python.module-chain', []).gaps[0];
    for (const gaps of [
      [{ ...gap, id: 'wildcard-all' }],
      [gap, gap],
      [{ ...gap, issue: 3486 }],
      [{ ...gap, reason: 1 }],
      [{ ...gap, baselineActual: [null] }],
      [{ ...gap, baselineActual: ['pkg/facade.py:target'] }],
    ]) {
      const report = scoreAccuracy(perfect(), { ...EMPTY, gaps } as KnownGapManifest, SOURCE);
      expect(report.gate.passed).toBe(false);
      expect(report.gate.errors.length).toBeGreaterThan(0);
    }
  });

  it('rejects unknown observation IDs and missing source/fixture provenance', () => {
    expect(scoreAccuracy({ ...perfect(), unknown: [] }, EMPTY, SOURCE).gate.errors).toContain(
      'Unknown observation: unknown',
    );
    expect(scoreAccuracy(perfect(), EMPTY, { ...SOURCE, sha: '' }).gate.passed).toBe(false);
    expect(scoreAccuracy(perfect(), EMPTY, { ...SOURCE, fixtureSha: '' }).gate.passed).toBe(false);
  });
});

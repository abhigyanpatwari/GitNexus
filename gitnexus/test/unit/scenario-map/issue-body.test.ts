/**
 * Locks the tracking issue body of the scenario map (U13, R13, KTD13): the header (run link, run
 * id marker, completeness, every degraded flag, "N of M evaluated", precision not measured), the
 * strong repeats, weak tests and per-file gaps in that order, truncation below 60,000 characters
 * with a count line, the "no findings" body and the freshness check an upsert runs.
 */
import { describe, expect, it } from 'vitest';
import {
  ISSUE_BODY_LIMIT,
  NO_FINDINGS,
  parseRunMarker,
  renderIssueBody,
  runMarker,
  shouldUpdateIssue,
} from '../../../tools/scenario-map/report/issue-body.js';
import { mdCode } from '../../../tools/scenario-map/report/markdown.js';
import { PRECISION_NOT_MEASURED, buildReport } from '../../../tools/scenario-map/report/report.js';
import type { DegradedFlag } from '../../../tools/scenario-map/value-flow/pdg-walk.js';
import type { FileGaps } from '../../../tools/scenario-map/verdict/verdict.js';
import { A, B, C, M2, M3, reportInput } from './report-fixtures.js';

const report = buildReport(reportInput());
const body = renderIssueBody(report);
/** The header: everything before the first section. */
const headerOf = (text: string): string => text.slice(0, text.indexOf('\n### '));

describe('issue body header', () => {
  it.each([
    ['the run link', '[run 1001](https://github.com/abhigyanpatwari/GitNexus/actions/runs/1001)'],
    ['completeness', '**Complete run**: 1 of 1 shards complete.'],
    ['N of M', '**3 of 3 eligible tests evaluated.**'],
    ['the precision statement', PRECISION_NOT_MEASURED],
    ['the baseline banner', 'first run, no baseline'],
    ['no degraded flag', '**Degraded**: none.'],
  ])('shows %s', (_title, text) => {
    expect(headerOf(body)).toContain(text);
  });

  it.each<DegradedFlag>(['no-pdg-layer', 'checker-version', 'checker-unavailable'])(
    'names the degraded flag %s',
    (flag) => {
      const degraded = renderIssueBody(buildReport(reportInput({ degraded: [flag] })));
      expect(headerOf(degraded)).toContain(`\`${flag}\``);
    },
  );

  it('names a partial run and its incomplete shards', () => {
    const shards = { planned: 2, complete: 1, incomplete: [{ shard: '1', reason: 'timeout' }] };
    const partial = renderIssueBody(buildReport(reportInput({ overrides: { shards } })));
    expect(headerOf(partial)).toContain(
      '**Partial run**: 1 of 2 shards complete; shard `1`: timeout.',
    );
  });
});

describe('run id marker', () => {
  it('opens the body with a marker a later upsert can compare', () => {
    expect(body.split('\n')[0]).toBe(runMarker(report.run));
    expect(parseRunMarker(body)).toEqual({ runId: '1001', attempt: 1 });
  });

  it('reads the marker from the first line only', () => {
    expect(parseRunMarker(`hello\n${runMarker({ id: '9999', attempt: 1 })}`)).toBeNull();
  });

  it.each([
    ['no existing body', null, true],
    ['a body without a marker', 'hand-written', true],
    ['an older run', runMarker({ id: '1000', attempt: 3 }), true],
    ['an earlier attempt of this run', runMarker({ id: '1001', attempt: 0 }), true],
    ['this very run', runMarker({ id: '1001', attempt: 1 }), true],
    ['a newer run', runMarker({ id: '1002', attempt: 1 }), false],
    ['a later attempt of this run', runMarker({ id: '1001', attempt: 2 }), false],
    ['a non-numeric run id', runMarker({ id: 'local', attempt: 1 }), false],
  ])('decides an update over %s', (_title, existing, expected) => {
    expect(shouldUpdateIssue(report, existing)).toBe(expected);
  });

  it.each([
    ['a partial run', { shards: { planned: 2, complete: 1, incomplete: [] } }],
    ['a run off the default branch', { run: { ...report.run, defaultBranch: false } }],
  ])('never updates the body from %s', (_title, overrides) => {
    expect(shouldUpdateIssue(buildReport(reportInput({ overrides })), null)).toBe(false);
  });
});

describe('issue body sections', () => {
  it('lists strong repeats, then weak tests, then gaps', () => {
    const strong = body.indexOf('### Strong repeat candidates (1)');
    const weak = body.indexOf('### Weak tests (1)');
    const gaps = body.indexOf('### Gaps per production file (1)');
    expect([strong > 0, weak > strong, gaps > weak]).toEqual([true, true, true]);
    expect(body).toContain(mdCode(A));
    expect(body).toContain(mdCode(B));
    expect(body.slice(weak, gaps)).toContain(mdCode(C));
  });

  it('truncates 5,000 gap rows below 60,000 characters, strong and weak first, with counts', () => {
    const gapRows: FileGaps[] = Array.from({ length: 5000 }, (_, i) => ({
      file: `gitnexus/src/gap-${String(i).padStart(4, '0')}.ts`,
      mutants: 3,
      killed: 1,
      survived: [M2],
      uncovered: [M3],
      inconclusive: [],
    }));
    const big = renderIssueBody(
      buildReport(reportInput({ verdicts: (verdicts) => ({ ...verdicts, gaps: gapRows }) })),
    );
    const lines = big.trimEnd().split('\n');
    const shownGaps = lines.filter((line) => line.startsWith('| `gitnexus/src/gap-')).length;
    expect(big.length).toBeLessThan(ISSUE_BODY_LIMIT);
    expect([big.includes(mdCode(A)), big.includes(mdCode(C)), shownGaps > 0]).toEqual([
      true,
      true,
      true,
    ]);
    expect(lines.at(-1)).toBe(
      'Truncated below 60,000 characters: ' +
        `${5000 - shownGaps} more rows not shown (0 strong repeat candidates, 0 weak tests, ` +
        `${5000 - shownGaps} gap files); the report artifact has every row.`,
    );
  });

  it('states that a complete run with no findings found none', () => {
    const clean = renderIssueBody(
      buildReport(
        reportInput({
          verdicts: (verdicts) => ({ ...verdicts, pairs: [], kept: [], tests: [], gaps: [] }),
        }),
      ),
    );
    expect(clean).toContain(`Complete run: ${NO_FINDINGS}.`);
    expect(clean).not.toContain('### Strong repeat candidates');
  });
});

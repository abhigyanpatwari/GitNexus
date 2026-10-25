/**
 * Locks the week-over-week comparison of the scenario map report (U13, R12, KTD13, design §5.5):
 * new, changed, unchanged and resolved items keyed by continuity anchors, the unique-only body
 * fallback for moved tests, the "first run, no baseline" and "incompatible baseline" banners (a
 * baseline that could not be read included), and
 * a report compared with itself and with a copy whose one evidence hash differs.
 */
import { describe, expect, it } from 'vitest';
import {
  BANNERS,
  UnreadableBaseline,
  compareWithBaseline,
  itemKey,
  type ContinuityItem,
  type ContinuitySection,
} from '../../../tools/scenario-map/report/baseline.js';
import { buildReport } from '../../../tools/scenario-map/report/report.js';
import { SCENARIO_MAP_SCHEMA_VERSION, type TestAnchor } from '../../../tools/scenario-map/types.js';
import { reportInput } from './report-fixtures.js';

const anchorOf = (key: string, body: string): TestAnchor => ({
  key,
  file: 'test/unit/p.test.ts',
  describePath: ['p'],
  title: key,
  rowFingerprint: 'row-0',
  bodyFingerprint: body,
});
const X = anchorOf('x', 'body-x');
const Y = anchorOf('y', 'body-y');

const pairItem = (members: readonly string[], evidenceHash: string): ContinuityItem => ({
  kind: 'pair',
  key: itemKey('pair', members),
  members: [...members].sort(),
  evidenceHash,
  label: members.join(' + '),
});
const P = (evidenceHash: string): ContinuityItem => pairItem(['x', 'y'], evidenceHash);
const section = (items: ContinuityItem[], anchors: TestAnchor[] = [X, Y]): ContinuitySection => ({
  anchors,
  items,
});
const previousReport = (
  continuity: ContinuitySection,
  schemaVersion: number = SCENARIO_MAP_SCHEMA_VERSION,
): unknown => ({ schemaVersion, run: { id: '1000' }, continuity });

describe('compareWithBaseline', () => {
  it('keeps a pair with the same evidence hash unchanged, out of "new or changed"', () => {
    const result = compareWithBaseline(section([P('h1')]), previousReport(section([P('h1')])));
    expect(result.changes).toEqual([
      { kind: 'pair', key: P('h1').key, status: 'unchanged', previous: P('h1').key },
    ]);
    expect(result.changes.filter((change) => change.status !== 'unchanged')).toEqual([]);
    expect(result.counts).toEqual({ new: 0, changed: 0, unchanged: 1, resolved: 0 });
  });

  it('marks a pair whose evidence hash differs as changed', () => {
    const result = compareWithBaseline(section([P('h2')]), previousReport(section([P('h1')])));
    expect(result.changes.map((change) => change.status)).toEqual(['changed']);
    expect(result.counts).toEqual({ new: 0, changed: 1, unchanged: 0, resolved: 0 });
  });

  it('counts a pair found only in the previous report as resolved', () => {
    const result = compareWithBaseline(section([]), previousReport(section([P('h1')])));
    expect(result.resolved).toEqual([
      { kind: 'pair', key: P('h1').key, label: 'x + y', evidenceHash: 'h1' },
    ]);
    expect(result.counts).toEqual({ new: 0, changed: 0, unchanged: 0, resolved: 1 });
  });

  it('marks every item new under the "first run, no baseline" banner without a baseline', () => {
    const gap: ContinuityItem = {
      kind: 'gap',
      key: itemKey('gap', [], 'gitnexus/src/a.ts'),
      members: [],
      evidenceHash: 'h3',
      label: 'gitnexus/src/a.ts',
    };
    const result = compareWithBaseline(section([P('h1'), gap]), null);
    expect(result).toMatchObject({
      state: 'first-run',
      banner: 'first run, no baseline',
      counts: { new: 2, changed: 0, unchanged: 0, resolved: 0 },
    });
    expect(result.changes.map((change) => change.status)).toEqual(['new', 'new']);
  });

  it('shows the "incompatible baseline" banner and no delta for an older schema version', () => {
    const older = previousReport(section([P('h1')]), SCENARIO_MAP_SCHEMA_VERSION - 1);
    expect(compareWithBaseline(section([P('h2')]), older)).toMatchObject({
      state: 'incompatible',
      banner: BANNERS.incompatible,
      counts: null,
      changes: [],
      resolved: [],
    });
  });

  it('treats a baseline without a readable continuity section as incompatible', () => {
    const broken = { schemaVersion: SCENARIO_MAP_SCHEMA_VERSION, continuity: { anchors: 'x' } };
    expect(compareWithBaseline(section([P('h1')]), broken)).toMatchObject({
      state: 'incompatible',
      reason: 'baseline has no readable continuity',
      counts: null,
    });
  });

  it('treats a baseline that could not be read as incompatible, with the read error', () => {
    const unreadable = new UnreadableBaseline('Unexpected end of JSON input');
    expect(compareWithBaseline(section([P('h1')]), unreadable)).toMatchObject({
      state: 'incompatible',
      banner: BANNERS.incompatible,
      reason: 'unreadable baseline: Unexpected end of JSON input',
      baseline: { runId: null, schemaVersion: null },
      counts: null,
      changes: [],
    });
  });

  it('follows a moved test through its unique body fingerprint', () => {
    const moved = anchorOf('x-moved', 'body-x');
    const current = section([pairItem(['x-moved', 'y'], 'h1')], [moved, Y]);
    const result = compareWithBaseline(current, previousReport(section([P('h1')])));
    expect(result.changes).toEqual([
      {
        kind: 'pair',
        key: itemKey('pair', ['x-moved', 'y']),
        status: 'unchanged',
        previous: P('h1').key,
      },
    ]);
    expect(result.counts?.resolved).toBe(0);
  });

  it('never follows a body that two current tests share', () => {
    const twinA = anchorOf('x-a', 'body-x');
    const twinB = anchorOf('x-b', 'body-x');
    const current = section(
      [pairItem(['x-a', 'y'], 'h1'), pairItem(['x-b', 'y'], 'h1')],
      [twinA, twinB, Y],
    );
    const result = compareWithBaseline(current, previousReport(section([P('h1')])));
    expect(result.counts).toEqual({ new: 2, changed: 0, unchanged: 0, resolved: 1 });
  });
});

describe('a built report against a baseline', () => {
  it('finds every item unchanged against itself', () => {
    const first = buildReport(reportInput());
    const again = buildReport(reportInput({ overrides: { baseline: first } }));
    expect(again.changes.counts).toEqual({
      new: 0,
      changed: 0,
      unchanged: first.continuity.items.length,
      resolved: 0,
    });
    expect(again.pairs.map((pair) => pair.change)).toEqual(['unchanged', 'unchanged']);
  });

  it('finds exactly the item whose evidence hash was altered changed', () => {
    const first = buildReport(reportInput());
    const altered = structuredClone(first);
    altered.continuity.items[0] = { ...altered.continuity.items[0], evidenceHash: 'e-altered' };
    const again = buildReport(reportInput({ overrides: { baseline: altered } }));
    expect(again.changes.counts).toEqual({
      new: 0,
      changed: 1,
      unchanged: first.continuity.items.length - 1,
      resolved: 0,
    });
    expect(again.changes.changes.filter((change) => change.status === 'changed')).toEqual([
      expect.objectContaining({ key: first.continuity.items[0].key }),
    ]);
  });
});

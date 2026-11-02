/**
 * Locks the static-to-runtime join and the continuity anchors (U3, R2, KTD3): runtime records
 * (as Layer 1 will feed them) get Phase 0 ids and join static instances by file, location and row
 * order; any join that is not one-to-one is unsupported with a named problem; anchors carry no
 * line, stay distinct by file, and follow a moved test only through a unique body fingerprint.
 */
import { describe, expect, it } from 'vitest';
import { expandCases } from '../../../tools/scenario-map/inventory/cases.js';
import { joinRuntime, matchAnchors } from '../../../tools/scenario-map/inventory/identity.js';
import type {
  InventoryJoin,
  RuntimeTestRecord,
  StaticInventory,
  TestAnchor,
} from '../../../tools/scenario-map/types.js';
import type { SourceFile } from '../../../tools/test-dupes/test-dupes.js';

const A = 'test/unit/a.test.ts';
const B = 'test/unit/b.test.ts';
const source = (file: string, ...lines: string[]): SourceFile => ({
  path: `gitnexus/${file}`,
  source: lines.join('\n'),
});
const statics = (...files: SourceFile[]): StaticInventory => expandCases(files);

let nextTask = 0;
/** A runtime record; task ids only need to be unique within a file. */
const rt = (file: string, fullName: string, line: number, column: number): RuntimeTestRecord => ({
  file,
  taskId: `task-${nextTask++}`,
  fullName,
  location: { line, column },
});

const outcome = (join: InventoryJoin): [string, number | null, string[]][] =>
  join.instances.map((instance) => [instance.id, instance.row, instance.unsupported]);

describe('joinRuntime', () => {
  const eachFile = source(A, `it.each([[1, 2], [3, 4]])('adds %i', (a, b) => {});`);

  it('joins it.each rows one-to-one by location and row order, with Phase 0 ids', () => {
    const join = joinRuntime(statics(eachFile), [rt(A, 'adds 1', 1, 26), rt(A, 'adds 3', 1, 26)]);
    expect(outcome(join)).toEqual([
      [`${A}#adds 1`, 0, []],
      [`${A}#adds 3`, 1, []],
    ]);
    expect(join.instances.map((instance) => instance.instance?.row)).toEqual([0, 1]);
    expect(join.summary).toMatchObject({ runtimeTests: 2, oneToOne: 2, joinMismatchSites: 0 });
  });

  it('makes every test at a location unsupported when the counts differ', () => {
    const join = joinRuntime(statics(eachFile), [
      rt(A, 'adds 1', 1, 26),
      rt(A, 'adds 3', 1, 26),
      rt(A, 'adds 5', 1, 26),
    ]);
    expect(join.instances.map((instance) => instance.unsupported)).toEqual([
      ['join-mismatch'],
      ['join-mismatch'],
      ['join-mismatch'],
    ]);
    expect(join.instances.map((instance) => instance.instance)).toEqual([null, null, null]);
    expect(join.summary).toMatchObject({ oneToOne: 0, joinMismatchSites: 1 });
  });

  it('keeps the runtime rows of an unresolved table, unsupported with the static reason', () => {
    const file = source(A, `it.each(buildRows())('row %s', (r) => {});`);
    const join = joinRuntime(statics(file), [rt(A, 'row a', 1, 21), rt(A, 'row b', 1, 21)]);
    expect(join.instances.map((instance) => instance.unsupported)).toEqual([
      ['join-count-unknown'],
      ['join-count-unknown'],
    ]);
    expect(join.instances[0].unresolved).toEqual(['each-table: not static: buildRows()']);
  });

  it('flags a runtime full name that differs from the static one', () => {
    const file = source(A, `describe('d', () => {`, `  it('t', () => {});`, `});`);
    expect(outcome(joinRuntime(statics(file), [rt(A, 'd > u', 2, 3)]))).toEqual([
      [`${A}#d > u`, 0, ['join-name-mismatch']],
    ]);
  });

  it.each([
    ['a record without a location', undefined, null, 'no-location'],
    ['a record at a line with no test call', { line: 9, column: 3 }, 0, 'no-static-case'],
  ])('reports %s', (_label, location, row, problem) => {
    const record: RuntimeTestRecord = { file: A, taskId: 'task', fullName: 't', location };
    expect(outcome(joinRuntime(statics(source(A, `it('t', () => {});`)), [record]))).toEqual([
      [`${A}#t`, row, [problem]],
    ]);
  });

  it('separates call sites sharing a line by column, and fails closed when none matches', () => {
    const file = source(A, `it('a', () => {}); it('b', () => {});`);
    const join = joinRuntime(statics(file), [
      rt(A, 'a', 1, 1),
      rt(A, 'b', 1, 20),
      rt(A, 'c', 1, 7),
    ]);
    expect(outcome(join)).toEqual([
      [`${A}#a`, 0, []],
      [`${A}#b`, 0, []],
      [`${A}#c`, 0, ['ambiguous-location']],
    ]);
  });

  it('lists static call sites that no runtime record reaches as not run', () => {
    const file = source(A, `it('a', () => {});`, `it.skip('b', () => {});`);
    const join = joinRuntime(statics(file), [rt(A, 'a', 1, 1)]);
    expect(join.notRun.map((site) => site.record.title)).toEqual(['b']);
    expect(join.summary.notRunSites).toBe(1);
  });

  it('carries a `// dupe-ok:` reason as the human keep (R15)', () => {
    const file = source(A, `// dupe-ok: covers the legacy path`, `it('a', () => {});`);
    expect(joinRuntime(statics(file), [rt(A, 'a', 2, 1)]).instances[0].dupeOk).toBe(
      'covers the legacy path',
    );
  });
});

describe('anchors', () => {
  const body = `it('parses', () => { expect(parse('x')).toBe(1); });`;

  it('gives identical bodies in different files equal body fingerprints and distinct anchors', () => {
    const join = joinRuntime(statics(source(A, body), source(B, body)), [
      rt(A, 'parses', 1, 1),
      rt(B, 'parses', 1, 1),
    ]);
    const [a, b] = join.instances.map((instance) => instance.anchor);
    expect([a?.bodyFingerprint === b?.bodyFingerprint, a?.key === b?.key]).toEqual([true, false]);
  });

  it('keeps the anchor key when only the line moves', () => {
    const before = joinRuntime(statics(source(A, body)), [rt(A, 'parses', 1, 1)]);
    const after = joinRuntime(statics(source(A, '', '', body)), [rt(A, 'parses', 3, 1)]);
    expect(after.instances[0].anchor?.key).toBe(before.instances[0].anchor?.key);
  });

  it('suffixes exact twins in declaration order and keys rows by their values', () => {
    const file = source(A, `it.each([1, 2, 1])('n %i', (n) => {});`);
    const join = joinRuntime(statics(file), [
      rt(A, 'n 1', 1, 19),
      rt(A, 'n 2', 1, 19),
      rt(A, 'n 1', 1, 19),
    ]);
    const [first, second, twin] = join.instances.map((instance) => instance.anchor?.key ?? '');
    expect([twin === `${first}~1`, first === second]).toEqual([true, false]);
  });
});

describe('matchAnchors', () => {
  const anchor = (key: string, bodyFingerprint: string, rowFingerprint: string | null = 'r') =>
    ({
      key,
      file: A,
      describePath: [],
      title: key,
      rowFingerprint,
      bodyFingerprint,
    }) satisfies TestAnchor;

  it('matches by key first, then a moved test by its unique body, else reports it new', () => {
    const previous = [anchor('same', 'b1'), anchor('old-name', 'b2'), anchor('dup-1', 'b3')];
    const current = [
      anchor('same', 'b1'),
      anchor('new-name', 'b2'),
      anchor('dup-2', 'b3'),
      anchor('dup-3', 'b3'),
    ];
    expect(matchAnchors(previous, current)).toEqual([
      { current: 'same', previous: 'same', via: 'key' },
      { current: 'new-name', previous: 'old-name', via: 'body' },
      { current: 'dup-2', previous: null, via: null },
      { current: 'dup-3', previous: null, via: null },
    ]);
  });

  it('never matches a moved row whose values are unknown', () => {
    expect(matchAnchors([anchor('old', 'b', null)], [anchor('new', 'b', null)])).toEqual([
      { current: 'new', previous: null, via: null },
    ]);
  });
});

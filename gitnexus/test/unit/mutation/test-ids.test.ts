/**
 * Locks the Stryker test identity of the vitest5 runner (KTD3): `<relative file>#<fullTestName>`,
 * parsed on the first `#`, with a `:<line>:<column>` suffix for duplicate full names and a
 * `:<line>:<column>:<row>` suffix for rows of one `it.each`/`test.for` call that still collide.
 * The dry run's `testIds` selection maps requested ids to task ids and checks the executed set.
 */
import { describe, expect, it } from 'vitest';
import {
  assignTestIds,
  formatTestId,
  parseTestId,
  selectRequestedTests,
  selectionProblems,
  type CollectedTest,
} from '../../../tools/mutation/runner/test-ids.js';

const FILE = 'test/unit/shared-type-extractors.test.ts';

const collected = (
  taskId: string,
  fullName: string,
  line: number,
  column: number,
): CollectedTest => ({ taskId, fullName, location: { line, column } });

describe('formatTestId and parseTestId', () => {
  it('joins the file and the full name with the first #', () => {
    expect(formatTestId(FILE, 'describe A > it b (#2415)')).toBe(
      `${FILE}#describe A > it b (#2415)`,
    );
  });

  it.each([
    ['a title with an issue reference', 'describe A > it b (#2415)'],
    ['a title that contains the separator twice', 'a # b > c#d'],
    ['a title containing " > "', 'outer > inner > maps a > b to c'],
    ['a title that ends with a location-like suffix', 'parses x:12:3'],
  ])('round-trips %s', (_label, name) => {
    const id = formatTestId(FILE, name);

    expect(parseTestId(id)).toEqual({ file: FILE, name });
  });

  it('splits on the first # only', () => {
    expect(parseTestId('test/a.test.ts#A > b (#1) and #2')).toEqual({
      file: 'test/a.test.ts',
      name: 'A > b (#1) and #2',
    });
  });

  it('rejects an id without a separator', () => {
    expect(() => parseTestId('test/a.test.ts')).toThrow(/no "#"/);
  });

  it('rejects a file path that contains the separator', () => {
    expect(() => formatTestId('test/a#b.test.ts', 'x')).toThrow(/contains "#"/);
  });
});

describe('assignTestIds', () => {
  it('uses the plain full name when it is unique in the file', () => {
    expect(
      assignTestIds(FILE, [collected('f_0', 'A > one', 3, 5), collected('f_1', 'A > two', 4, 5)]),
    ).toEqual([
      {
        taskId: 'f_0',
        fullName: 'A > one',
        location: { line: 3, column: 5 },
        id: `${FILE}#A > one`,
        notOracleValidated: false,
      },
      {
        taskId: 'f_1',
        fullName: 'A > two',
        location: { line: 4, column: 5 },
        id: `${FILE}#A > two`,
        notOracleValidated: false,
      },
    ]);
  });

  it('suffixes duplicate full names with their location', () => {
    const ids = assignTestIds(FILE, [
      collected('f_0', 'A > same', 3, 5),
      collected('f_1', 'A > same', 9, 7),
      collected('f_2', 'A > other', 12, 5),
    ]);

    expect(ids.map((test) => [test.id, test.notOracleValidated])).toEqual([
      [`${FILE}#A > same:3:5`, false],
      [`${FILE}#A > same:9:7`, false],
      [`${FILE}#A > other`, false],
    ]);
  });

  it('adds the row ordinal of the call when name and location collide, and flags those rows', () => {
    const ids = assignTestIds(FILE, [
      collected('f_0', 'each > truncated row title', 20, 3),
      collected('f_1', 'each > distinct row', 20, 3),
      collected('f_2', 'each > truncated row title', 20, 3),
    ]);

    expect(ids.map((test) => [test.id, test.notOracleValidated])).toEqual([
      [`${FILE}#each > truncated row title:20:3:0`, true],
      [`${FILE}#each > distinct row`, false],
      [`${FILE}#each > truncated row title:20:3:2`, true],
    ]);
  });

  it('keeps every assigned id parseable back to its file and suffixed name', () => {
    const [first] = assignTestIds(FILE, [
      collected('f_0', 'A > b (#2415)', 3, 5),
      collected('f_1', 'A > b (#2415)', 4, 5),
    ]);

    expect(parseTestId(first.id)).toEqual({ file: FILE, name: 'A > b (#2415):3:5' });
  });

  it('refuses a duplicate full name without a location', () => {
    expect(() =>
      assignTestIds(FILE, [
        { taskId: 'f_0', fullName: 'A > same', location: undefined },
        { taskId: 'f_1', fullName: 'A > same', location: undefined },
      ]),
    ).toThrow(/includeTaskLocation/);
  });

  it('refuses ids that still collide after suffixing', () => {
    expect(() =>
      assignTestIds(FILE, [
        collected('f_0', 'A > x:3:5', 1, 1),
        collected('f_1', 'A > x', 3, 5),
        collected('f_2', 'A > x', 4, 5),
      ]),
    ).toThrow(/not unique/);
  });

  it('refuses a task id listed twice', () => {
    expect(() =>
      assignTestIds(FILE, [collected('f_0', 'A > one', 3, 5), collected('f_0', 'A > two', 4, 5)]),
    ).toThrow(/task id f_0/);
  });
});

describe('selectRequestedTests (dry-run selection by testIds)', () => {
  const OTHER = 'test/unit/other.test.ts';
  const identified = new Map([
    [
      FILE,
      assignTestIds(FILE, [
        collected('f_0', 'A > one', 3, 5),
        collected('f_1', 'A > two', 4, 5),
        collected('f_2', 'A > three', 5, 5),
      ]),
    ],
    [OTHER, assignTestIds(OTHER, [collected('g_0', 'B > one', 3, 5)])],
  ]);

  it('maps the requested ids to task ids per file, in collection order, and leaves out files with none', () => {
    expect(selectRequestedTests(identified, [`${FILE}#A > three`, `${FILE}#A > one`])).toEqual({
      files: [{ file: FILE, taskIds: ['f_0', 'f_2'] }],
      unknown: [],
    });
  });

  it('reports every requested id that no collected test has', () => {
    expect(
      selectRequestedTests(identified, [`${OTHER}#B > one`, `${FILE}#A > four`, 'x.test.ts#y']),
    ).toEqual({
      files: [{ file: OTHER, taskIds: ['g_0'] }],
      unknown: [`${FILE}#A > four`, 'x.test.ts#y'],
    });
  });
});

describe('selectionProblems (the executed set must equal the request)', () => {
  const ONE = `${FILE}#A > one`;
  const TWO = `${FILE}#A > two`;

  it('accepts a run that executed exactly the requested tests, in any order', () => {
    expect(selectionProblems([ONE, TWO], [TWO, ONE])).toEqual([]);
  });

  it('names a requested test that did not run and a test that ran unrequested', () => {
    expect(selectionProblems([ONE], [TWO])).toEqual([
      `requested test ${JSON.stringify(ONE)} did not run (vitest5.testIds)`,
      `test ${JSON.stringify(TWO)} ran but vitest5.testIds does not request it`,
    ]);
  });
});

/**
 * Locks Layer 1 in slices (tools/scenario-map/path-coverage/slices.ts): the deterministic,
 * complete split of the test files, the merge of the slices' work files into one (block table
 * united, indices remapped, files and tests in file order, a missing slice's files unrecorded),
 * the merge's refusals, and the slice files read from a directory.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  WORK_FILE_SCHEMA_VERSION,
  unknownProvenance,
  type CoverageTest,
  type CoverageWorkFile,
} from '../../../tools/scenario-map/path-coverage/run-coverage.js';
import {
  COVERAGE_SLICE_SCHEMA_VERSION,
  coverageSliceName,
  coverageSlices,
  mergeCoverageSlices,
  readCoverageSlices,
  type CoverageSliceFile,
} from '../../../tools/scenario-map/path-coverage/slices.js';

const PACKAGE_DIR = fileURLToPath(new URL('../../../', import.meta.url));

// Sequential files with measured CI seconds in test/helpers/shard-balance.ts: 488, 173 and 147.
const ORCHESTRATION = 'test/unit/incremental-orchestration.test.ts';
const RENAME_TS = 'test/integration/rename-provider-typescript.test.ts';
const LIFECYCLE = 'test/integration/parse-cache-identity-lifecycle.test.ts';
const SEQUENTIAL = new Set([ORCHESTRATION, RENAME_TS, LIFECYCLE]);
const FILES = [
  'test/unit/scenario-map/slices.test.ts',
  ORCHESTRATION,
  RENAME_TS,
  'test/unit/scenario-map/partitions.test.ts',
  LIFECYCLE,
];

describe('coverageSlices', () => {
  const slices = coverageSlices(FILES, 2, PACKAGE_DIR, (file) => SEQUENTIAL.has(file));

  it('assigns every file to exactly one slice, each slice sorted', () => {
    expect([slices.flat().sort(), slices.map((slice) => [...slice].sort()), slices.length]).toEqual(
      [[...FILES].sort(), slices, 2],
    );
  });

  it('keeps the heaviest sequential file apart from the next two', () => {
    const slowest = slices.findIndex((slice) => slice.includes(ORCHESTRATION));
    expect([
      slices[slowest].filter((file) => SEQUENTIAL.has(file)),
      slices[1 - slowest].filter((file) => SEQUENTIAL.has(file)),
    ]).toEqual([[ORCHESTRATION], [LIFECYCLE, RENAME_TS]]);
  });

  it('splits the same way every time', () => {
    expect(coverageSlices(FILES, 2, PACKAGE_DIR, (file) => SEQUENTIAL.has(file))).toEqual(slices);
  });
});

const test = (file: string, name: string, blocks: number[]): CoverageTest => ({
  id: `${file}#${name}`,
  taskId: `${file}-${name}`,
  file,
  fullName: name,
  location: { line: 1, column: 1 },
  state: 'passed',
  concurrent: false,
  attempts: 2,
  blocks,
  suiteBlocks: blocks.slice(0, 1),
  provenance: unknownProvenance(),
});

const work = (
  blocks: string[],
  files: string[],
  tests: CoverageTest[],
  overrides: Partial<CoverageWorkFile> = {},
): CoverageWorkFile => ({
  schemaVersion: WORK_FILE_SCHEMA_VERSION,
  mode: 'normal',
  extraRoots: [],
  repeats: 1,
  blocks,
  files: files.map((file) => ({
    file,
    recorded: true,
    errors: [],
    unattributed: unknownProvenance(),
  })),
  tests,
  unhandledErrors: [],
  ...overrides,
});

const A = 'test/unit/a.test.ts';
const B = 'test/unit/b.test.ts';
const C = 'test/unit/c.test.ts';
const D = 'test/unit/d.test.ts';
const ASSIGNMENT = [[B], [A, C], [D]];

const slice = (index: number, body: CoverageWorkFile): CoverageSliceFile => ({
  schemaVersion: COVERAGE_SLICE_SCHEMA_VERSION,
  index,
  of: 3,
  layer1: [A, B, C, D],
  mutation: 'none',
  changed: null,
  revision: 'abc',
  work: body,
});

const SLICE_0 = slice(
  0,
  work(['src/x.ts#f@1', 'src/z.ts#h@3'], [B], [test(B, 'one', [0, 1])], {
    unhandledErrors: ['boom'],
  }),
);
const SLICE_1 = slice(
  1,
  work(['src/y.ts#g@2', 'src/z.ts#h@3'], [A, C], [test(A, 'one', [1]), test(C, 'two', [0, 1])]),
);

describe('mergeCoverageSlices', () => {
  const merged = mergeCoverageSlices(ASSIGNMENT, [SLICE_1, SLICE_0]);
  const ids = (entry: CoverageTest): string[] => entry.blocks.map((index) => merged.blocks[index]);

  it('unites the block tables and remaps every test to the same block ids', () => {
    expect([
      merged.blocks,
      merged.tests.map((entry) => [entry.id, ids(entry)]),
      merged.tests.map((entry) => entry.suiteBlocks.map((index) => merged.blocks[index])),
    ]).toEqual([
      ['src/x.ts#f@1', 'src/y.ts#g@2', 'src/z.ts#h@3'],
      [
        [`${A}#one`, ['src/z.ts#h@3']],
        [`${B}#one`, ['src/x.ts#f@1', 'src/z.ts#h@3']],
        [`${C}#two`, ['src/y.ts#g@2', 'src/z.ts#h@3']],
      ],
      [['src/z.ts#h@3'], ['src/x.ts#f@1'], ['src/y.ts#g@2']],
    ]);
  });

  it('lists the files of a slice that did not report as unrecorded, with an error', () => {
    expect([
      merged.files.map((entry) => [entry.file, entry.recorded, entry.errors]),
      merged.unhandledErrors,
    ]).toEqual([
      [
        [A, true, []],
        [B, true, []],
        [C, true, []],
        [D, false, ['coverage slice 2 of 3 did not report']],
      ],
      ['boom'],
    ]);
  });

  it.each([
    { name: 'no slice', reported: [], message: /no slice reported/ },
    { name: 'a slice twice', reported: [SLICE_0, SLICE_0], message: /reported twice/ },
    {
      name: 'a slice that ran other files',
      reported: [{ ...SLICE_0, work: work([], [A], []) }],
      message: /ran other files/,
    },
    {
      name: 'another number of slices',
      reported: [{ ...SLICE_0, of: 2 }],
      message: /slice 0 of 2, expected 3/,
    },
    {
      name: 'slices of different repeats',
      reported: [SLICE_0, { ...SLICE_1, work: { ...SLICE_1.work, repeats: 0 } }],
      message: /is not the run of slice 0/,
    },
    {
      name: 'slices of different mutation scopes',
      reported: [SLICE_0, { ...SLICE_1, mutation: 'all' as const }],
      message: /is not the run of slice 0/,
    },
    {
      name: 'slices of different diff scopes',
      reported: [SLICE_0, { ...SLICE_1, changed: [A] }],
      message: /is not the run of slice 0/,
    },
    {
      name: 'slices of different revisions',
      reported: [SLICE_0, { ...SLICE_1, revision: 'def' }],
      message: /is not the run of slice 0/,
    },
  ])('refuses $name', ({ reported, message }) => {
    expect(() => mergeCoverageSlices(ASSIGNMENT, reported)).toThrow(message);
  });
});

describe('readCoverageSlices', () => {
  const temps: string[] = [];
  afterEach(() => {
    for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const dirWith = (entries: Record<string, unknown>): string => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'scenario-map-slices-'));
    temps.push(dir);
    for (const [name, value] of Object.entries(entries)) {
      writeFileSync(path.join(dir, name), JSON.stringify(value));
    }
    return dir;
  };

  it('reads the slice files in name order and ignores other files', () => {
    const dir = dirWith({
      [coverageSliceName(1)]: SLICE_1,
      [coverageSliceName(0)]: SLICE_0,
      'plan.json': {},
    });
    expect(readCoverageSlices(dir).map((entry) => entry.index)).toEqual([0, 1]);
  });

  it('throws on a malformed slice file', () => {
    const dir = dirWith({ [coverageSliceName(0)]: { ...SLICE_0, index: 3 } });
    expect(() => readCoverageSlices(dir)).toThrow(/is not a coverage slice file/);
  });
});

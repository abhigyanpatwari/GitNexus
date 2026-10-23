/**
 * Locks the global mutant identity (origin §2, KTD12): a mutant is named by its original repo
 * path, the content hash of the original file, its 1-based end-exclusive span, its mutator and
 * its replacement, so the same mutant gets the same id in Stryker runs whose local ids differ.
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  contentHash,
  identifyMutants,
  parseMutationReport,
  type MutationReport,
  type ReportMutant,
} from '../../../tools/mutation/prepare/mutant-identity.js';

const PACKAGE_DIR = path.join(path.sep, 'prepared', 'gitnexus');
const SHARED_KEY = 'relocated/gitnexus-shared/src/lbug/schema-constants.ts';
const SHARED_REPO = 'gitnexus-shared/src/lbug/schema-constants.ts';
const SRC_KEY = 'src/core/example.ts';
const SRC_REPO = 'gitnexus/src/core/example.ts';

const ORIGINAL = "export const KINDS = ['a', 'b'] as const;\n";
/** What the prepare step writes for {@link ORIGINAL}: ` as const` blanked to spaces. */
const PREPARED = "export const KINDS = ['a', 'b']         ;\n";

const ORIGINALS: Readonly<Record<string, string>> = {
  [SHARED_REPO]: ORIGINAL,
  [SRC_REPO]: 'const a = 1;\n',
};

const missing = (repoPath: string): never => {
  throw new Error(`no original for ${repoPath}`);
};

const readOriginal = (repoPath: string): string => ORIGINALS[repoPath] ?? missing(repoPath);

/** StringLiteral on `'a'` of {@link ORIGINAL}: columns 23-26, 1-based and end exclusive. */
const mutant = (overrides: Partial<ReportMutant> = {}): ReportMutant => ({
  id: '0',
  mutatorName: 'StringLiteral',
  replacement: '""',
  status: 'Survived',
  location: { start: { line: 1, column: 23 }, end: { line: 1, column: 26 } },
  ...overrides,
});

const report = (files: Record<string, readonly ReportMutant[]>): MutationReport => ({
  schemaVersion: '1.0',
  files: Object.fromEntries(
    Object.entries(files).map(([file, mutants]) => [
      file,
      { language: 'typescript', source: PREPARED, mutants: [...mutants] },
    ]),
  ),
});

const identify = (files: Record<string, readonly ReportMutant[]>) =>
  identifyMutants(report(files), { packageDir: PACKAGE_DIR, readOriginal });

describe('identifyMutants', () => {
  it('gives two mutants on the same span with different replacements different identities', () => {
    const run = identify({
      [SHARED_KEY]: [mutant({ id: '0' }), mutant({ id: '1', replacement: '"Stryker was here!"' })],
    });
    const [first, second] = run.mutants;
    expect(first.globalId).not.toBe(second.globalId);
    expect({ ...first.identity, replacement: '' }).toEqual({ ...second.identity, replacement: '' });
  });

  it('gives the same mutant the same global id in two runs with different local ids', () => {
    const runA = identify({ [SHARED_KEY]: [mutant({ id: '3' })] });
    const runB = identify({
      [SRC_KEY]: [mutant({ id: '16', mutatorName: 'BooleanLiteral' })],
      [SHARED_KEY]: [mutant({ id: '17' })],
    });
    expect(runA.localToGlobal.get('3')).toBe(runB.localToGlobal.get('17'));
    expect(runB.localToGlobal.get('16')).not.toBe(runB.localToGlobal.get('17'));
  });

  it('maps every local id of a run to its global id', () => {
    const run = identify({
      [SHARED_KEY]: [mutant({ id: '0' }), mutant({ id: '9', replacement: 'x' })],
    });
    expect([...run.localToGlobal]).toEqual(run.mutants.map((m) => [m.localId, m.globalId]));
  });

  it('names the mutant by its original repo path and the hash of the original file', () => {
    const [identified] = identify({ [SHARED_KEY]: [mutant()] }).mutants;
    expect(identified.identity).toEqual({
      file: SHARED_REPO,
      fileHash: contentHash(ORIGINAL),
      location: { start: { line: 1, column: 23 }, end: { line: 1, column: 26 } },
      mutatorName: 'StringLiteral',
      replacement: '""',
    });
    expect(identified.identity.fileHash).not.toBe(contentHash(PREPARED));
    expect(identified.reportFile).toBe(SHARED_KEY);
  });

  it('formats the global id as path@file-hash:span:mutator:replacement-hash', () => {
    const [identified] = identify({ [SRC_KEY]: [mutant()] }).mutants;
    expect(identified.globalId).toBe(
      `${SRC_REPO}@${contentHash('const a = 1;\n').slice(0, 16)}:1:23-1:26:StringLiteral:` +
        contentHash('""').slice(0, 16),
    );
  });

  it('changes the global id when the original file content changes', () => {
    const before = identify({ [SRC_KEY]: [mutant()] }).mutants[0].globalId;
    const after = identifyMutants(report({ [SRC_KEY]: [mutant()] }), {
      packageDir: PACKAGE_DIR,
      readOriginal: () => 'const a = 2;\n',
    }).mutants[0].globalId;
    expect(after).not.toBe(before);
  });

  it('maps an absolute report path under the package dir like a relative one', () => {
    const absolute = identify({ [path.join(PACKAGE_DIR, SHARED_KEY)]: [mutant()] });
    const relative = identify({ [SHARED_KEY]: [mutant()] });
    expect(absolute.mutants[0].globalId).toBe(relative.mutants[0].globalId);
  });

  it.each([
    ['a test file', 'test/unit/schema.test.ts'],
    ['a tooling file', 'tools/mutation/scope-file.ts'],
    ['a file above the package dir', '../gitnexus-shared/src/index.ts'],
  ])('throws for a mutant in %s, outside the mapped roots', (_label, file) => {
    expect(() => identify({ [file]: [mutant()] })).toThrow(
      /outside the mapped roots|not a relative path/,
    );
  });

  it('throws when two local mutants share one global identity', () => {
    expect(() => identify({ [SHARED_KEY]: [mutant({ id: '0' }), mutant({ id: '1' })] })).toThrow(
      /local ids 0 and 1 have the same global identity/,
    );
  });

  it('throws when a local id appears twice', () => {
    expect(() =>
      identify({ [SHARED_KEY]: [mutant({ id: '4' }), mutant({ id: '4', replacement: 'x' })] }),
    ).toThrow(/local id 4 appears twice/);
  });
});

describe('contentHash', () => {
  it('is the sha256 hex digest of the UTF-8 text', () => {
    expect(contentHash('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

/** A report in Stryker's JSON shape, as `JSON.parse` sees it. */
const rawReport = (mutantOverrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  schemaVersion: '1.0',
  projectRoot: PACKAGE_DIR,
  thresholds: { high: 80, low: 60, break: null },
  files: {
    [SHARED_KEY]: {
      language: 'typescript',
      source: PREPARED,
      mutants: [
        {
          id: '7',
          mutatorName: 'StringLiteral',
          replacement: '""',
          status: 'Killed',
          static: true,
          statusReason: 'expected',
          testsCompleted: 3,
          coveredBy: [],
          killedBy: ['2', '5'],
          location: { end: { column: 26, line: 1 }, start: { column: 23, line: 1 } },
          ...mutantOverrides,
        },
      ],
    },
  },
});

describe('parseMutationReport', () => {
  it('reads the fields the identity and the outcome comparison consume', () => {
    const parsed = parseMutationReport(JSON.stringify(rawReport()));
    expect(parsed.projectRoot).toBe(PACKAGE_DIR);
    expect(parsed.files[SHARED_KEY]).toEqual({
      language: 'typescript',
      source: PREPARED,
      mutants: [
        {
          id: '7',
          mutatorName: 'StringLiteral',
          replacement: '""',
          status: 'Killed',
          static: true,
          statusReason: 'expected',
          testsCompleted: 3,
          coveredBy: [],
          killedBy: ['2', '5'],
          location: { start: { line: 1, column: 23 }, end: { line: 1, column: 26 } },
        },
      ],
    });
  });

  const position = (line: unknown, column: unknown) => ({ line, column });

  it.each([
    ['a missing replacement', { replacement: undefined }, /replacement/],
    ['a numeric id', { id: 7 }, /\.id/],
    ['a mutator name with a colon', { mutatorName: 'String:Literal' }, /mutatorName/],
    ['an unknown status', { status: 'Exploded' }, /status/],
    ['a non-string killedBy entry', { killedBy: [2] }, /killedBy/],
    [
      'a zero column',
      { location: { start: position(1, 0), end: position(1, 26) } },
      /location\.start/,
    ],
    [
      'a fractional line',
      { location: { start: position(1.5, 23), end: position(1, 26) } },
      /location\.start/,
    ],
    [
      'an end before the start',
      { location: { start: position(2, 1), end: position(1, 26) } },
      /ends before it starts/,
    ],
  ])('rejects a mutant with %s', (_label, overrides, message) => {
    expect(() => parseMutationReport(JSON.stringify(rawReport(overrides)))).toThrow(message);
  });

  it.each([
    ['schema version 2', { ...rawReport(), schemaVersion: '2' }, /schemaVersion/],
    ['files that are not an object', { ...rawReport(), files: [] }, /files/],
    [
      'a file without source',
      { schemaVersion: '1.0', files: { a: { language: 'typescript', mutants: [] } } },
      /source/,
    ],
  ])('rejects a report with %s', (_label, raw, message) => {
    expect(() => parseMutationReport(JSON.stringify(raw))).toThrow(message);
  });
});

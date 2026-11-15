/**
 * Locks the vitest5 runner's run manifest (KTD16): the dry-run process writes it atomically to the
 * run directory, every other runner process loads it before its first mutant run, and test
 * selection (KTD4) accepts only manifest test ids.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  RUN_MANIFEST_FILE,
  RunManifestMissingError,
  TestFilterError,
  parseRunManifest,
  readRunManifest,
  selectTests,
  writeRunManifest,
  type RunManifest,
} from '../../../tools/mutation/runner/run-manifest.js';

const MODULE_URL = new URL('../../../tools/mutation/runner/run-manifest.ts', import.meta.url).href;

const manifest: RunManifest = {
  schemaVersion: 1,
  project: 'mutation',
  vitestVersion: '5.0.5',
  files: [
    {
      file: 'test/unit/a.test.ts',
      tests: [
        {
          id: 'test/unit/a.test.ts#A > one (#2415)',
          taskId: 'h1_0_0',
          fullName: 'A > one (#2415)',
          location: { line: 4, column: 5 },
          notOracleValidated: false,
        },
        {
          id: 'test/unit/a.test.ts#A > two',
          taskId: 'h1_0_1',
          fullName: 'A > two',
          location: { line: 8, column: 5 },
          notOracleValidated: false,
        },
      ],
      skipped: [
        {
          id: 'test/unit/a.test.ts#A > later',
          taskId: 'h1_0_2',
          fullName: 'A > later',
          location: { line: 12, column: 5 },
          notOracleValidated: false,
        },
      ],
    },
    {
      file: 'test/unit/b.test.ts',
      tests: [
        {
          id: 'test/unit/b.test.ts#row:3:1:0',
          taskId: 'h2_0',
          fullName: 'row',
          location: { line: 3, column: 1 },
          notOracleValidated: true,
        },
      ],
      skipped: [],
    },
  ],
};

let runDir: string;

beforeEach(() => {
  runDir = mkdtempSync(path.join(os.tmpdir(), 'gitnexus-run-manifest-'));
});

afterEach(() => {
  rmSync(runDir, { recursive: true, force: true });
});

describe('writeRunManifest and readRunManifest', () => {
  it('loads, in this process, a manifest written by another process', () => {
    const script = [
      `const { writeRunManifest } = await import(${JSON.stringify(MODULE_URL)});`,
      `writeRunManifest(process.argv[1], JSON.parse(process.argv[2]));`,
    ].join('\n');
    execFileSync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', script, runDir, JSON.stringify(manifest)],
      { stdio: 'pipe' },
    );

    const loaded = readRunManifest(runDir);
    const taskIdByStrykerId = new Map(
      loaded.files.flatMap((file) => file.tests.map((test) => [test.id, test.taskId] as const)),
    );

    expect(loaded).toEqual(manifest);
    expect(Object.fromEntries(taskIdByStrykerId)).toEqual({
      'test/unit/a.test.ts#A > one (#2415)': 'h1_0_0',
      'test/unit/a.test.ts#A > two': 'h1_0_1',
      'test/unit/b.test.ts#row:3:1:0': 'h2_0',
    });
  });

  it('leaves only the final manifest file in the run directory', () => {
    writeRunManifest(runDir, manifest);
    writeRunManifest(runDir, manifest);

    expect(readdirSync(runDir)).toEqual([RUN_MANIFEST_FILE]);
  });

  it('refuses to load when the dry run left no manifest', () => {
    expect(() => readRunManifest(runDir)).toThrow(RunManifestMissingError);
    expect(() => readRunManifest(runDir)).toThrow(/no run manifest .*dry run/);
  });

  it('refuses a relative run directory', () => {
    expect(() => writeRunManifest('relative/run', manifest)).toThrow(/absolute/);
  });

  it('refuses a corrupt manifest file', () => {
    writeFileSync(path.join(runDir, RUN_MANIFEST_FILE), '{"schemaVersion":1');

    expect(() => readRunManifest(runDir)).toThrow(/not valid JSON/);
  });
});

describe('parseRunManifest', () => {
  const withFiles = (files: unknown): string => JSON.stringify({ ...manifest, files });

  it.each([
    ['an unknown schema version', JSON.stringify({ ...manifest, schemaVersion: 2 }), /schema/],
    ['a missing project', JSON.stringify({ ...manifest, project: '' }), /project/],
    [
      'a Stryker id listed twice',
      withFiles([manifest.files[0], { ...manifest.files[0], file: 'test/unit/c.test.ts' }]),
      /listed twice/,
    ],
    [
      'an absolute test file',
      withFiles([{ ...manifest.files[1], file: '/abs/b.test.ts' }]),
      /package-relative/,
    ],
    [
      'a test without a task id',
      withFiles([{ ...manifest.files[1], tests: [{ ...manifest.files[1].tests[0], taskId: '' }] }]),
      /taskId/,
    ],
  ])('rejects %s', (_label, text, message) => {
    expect(() => parseRunManifest(text, 'run-manifest.json')).toThrow(message);
  });
});

describe('selectTests', () => {
  it('selects the filtered tests per file by Vitest task id', () => {
    expect(
      selectTests(manifest, ['test/unit/b.test.ts#row:3:1:0', 'test/unit/a.test.ts#A > two']),
    ).toEqual({
      files: [
        { file: 'test/unit/a.test.ts', tests: [manifest.files[0].tests[1]] },
        { file: 'test/unit/b.test.ts', tests: [manifest.files[1].tests[0]] },
      ],
    });
  });

  it("selects the manifest's full test set, without skipped tests, when there is no filter", () => {
    expect(selectTests(manifest, undefined)).toEqual({
      files: [
        { file: 'test/unit/a.test.ts', tests: manifest.files[0].tests },
        { file: 'test/unit/b.test.ts', tests: manifest.files[1].tests },
      ],
    });
  });

  it('rejects a filter that holds a test file path instead of a test id', () => {
    expect(() => selectTests(manifest, ['test/unit/a.test.ts'])).toThrow(TestFilterError);
    expect(() => selectTests(manifest, ['/sandbox/test/unit/a.test.ts'])).toThrow(/testFiles/);
  });

  it.each([
    ['an unknown test id', 'test/unit/a.test.ts#A > three'],
    ['a test that was skipped in the dry run', 'test/unit/a.test.ts#A > later'],
  ])('rejects %s', (_label, id) => {
    expect(() => selectTests(manifest, [id])).toThrow(/not a test id of the run manifest/);
  });
});

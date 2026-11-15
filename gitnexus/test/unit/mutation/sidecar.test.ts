/**
 * Locks the vitest5 runner's sidecar files (KTD6): one record per local mutant id, attempt and
 * worker, written under a temporary name and published under its final name only when complete.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunClassification } from '../../../tools/mutation/runner/classify-outcome.js';
import {
  SIDECAR_SCHEMA_VERSION,
  readSidecars,
  sidecarFileName,
  writeSidecar,
  type SidecarDraft,
} from '../../../tools/mutation/runner/sidecar.js';

const survived: RunClassification = {
  status: 'survived',
  outcome: 'survived',
  reason: undefined,
  killedBy: [],
  failureMessage: undefined,
  nrOfTests: 1,
  hitCount: 0,
  tests: [{ id: 'test/unit/a.test.ts#A > one', outcome: 'survived', message: undefined }],
  outsideTest: [],
};

const draft = (worker: string): SidecarDraft => ({
  kind: 'mutant',
  mutantId: '42',
  worker,
  mutantActivation: 'runtime',
  hitLimit: 100,
  requestedTestIds: ['test/unit/a.test.ts#A > one'],
  hookAttributedTests: null,
  result: survived,
});

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'gitnexus-sidecar-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('sidecarFileName', () => {
  it.each([
    ['a mutant run', 'mutant', '42', '3', 1, 'mutant-42.worker-3.attempt-1.json'],
    ['the dry run', 'dry-run', null, '1', 2, 'dry-run.worker-1.attempt-2.json'],
    ['an unsafe worker id', 'mutant', '7', '../x', 1, 'mutant-7.worker-___x.attempt-1.json'],
  ] as const)('names %s', (_label, kind, mutantId, worker, attempt, expected) => {
    expect(sidecarFileName(kind, mutantId, worker, attempt)).toBe(expected);
  });
});

describe('writeSidecar', () => {
  it('keeps the records of two workers for the same mutant and attempt apart', () => {
    const first = writeSidecar(dir, draft('1'));
    const second = writeSidecar(dir, draft('2'));

    expect([first.attempt, second.attempt]).toEqual([1, 1]);
    expect(readdirSync(dir).sort()).toEqual([
      'mutant-42.worker-1.attempt-1.json',
      'mutant-42.worker-2.attempt-1.json',
    ]);
    expect(readSidecars(dir).map((record) => [record.worker, record.attempt])).toEqual([
      ['1', 1],
      ['2', 1],
    ]);
  });

  it('gives a repeated run of the same mutant in the same worker the next attempt', () => {
    writeSidecar(dir, draft('1'));
    const retry = writeSidecar(dir, draft('1'));

    expect(retry.attempt).toBe(2);
    expect(readdirSync(dir).sort()).toEqual([
      'mutant-42.worker-1.attempt-1.json',
      'mutant-42.worker-1.attempt-2.json',
    ]);
  });

  it('never overwrites a record already published under the final name', () => {
    const taken = path.join(dir, 'mutant-42.worker-1.attempt-1.json');
    writeFileSync(taken, 'published by another process');

    const written = writeSidecar(dir, draft('1'));

    expect(readFileSync(taken, 'utf8')).toBe('published by another process');
    expect(path.basename(written.file)).toBe('mutant-42.worker-1.attempt-2.json');
  });

  it('never shows a half-written record under the final name', () => {
    const finalName = path.join(dir, 'mutant-42.worker-1.attempt-1.json');
    const seenDuringWrite: boolean[] = [];

    expect(() =>
      writeSidecar(dir, draft('1'), {
        writeFile: (file, data) => {
          writeFileSync(file, data.slice(0, 10));
          seenDuringWrite.push(existsSync(finalName));
          throw new Error('disk full');
        },
      }),
    ).toThrow(/disk full/);
    expect(seenDuringWrite).toEqual([false]);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('writes the complete record, with pid and schema version, as JSON', () => {
    const written = writeSidecar(dir, draft('5'));

    expect(JSON.parse(readFileSync(written.file, 'utf8'))).toEqual({
      schemaVersion: SIDECAR_SCHEMA_VERSION,
      attempt: 1,
      pid: process.pid,
      ...draft('5'),
    });
  });

  it('keeps the dry-run hook marker: per mutant, the tests a suite hook attributed it to', () => {
    const marker = { '3': ['test/unit/a.test.ts#A > one', 'test/unit/a.test.ts#A > two'] };
    const written = writeSidecar(dir, {
      ...draft('1'),
      kind: 'dry-run',
      mutantId: null,
      mutantActivation: null,
      hitLimit: null,
      hookAttributedTests: marker,
    });

    expect(readSidecars(dir)).toEqual([
      expect.objectContaining({ schemaVersion: 2, kind: 'dry-run', hookAttributedTests: marker }),
    ]);
    expect(path.basename(written.file)).toBe('dry-run.worker-1.attempt-1.json');
  });

  it('refuses a relative sidecar directory', () => {
    expect(() => writeSidecar('relative/sidecars', draft('1'))).toThrow(/absolute/);
  });
});

describe('readSidecars', () => {
  it('ignores temporary files that a crashed writer left behind', () => {
    writeSidecar(dir, draft('1'));
    writeFileSync(path.join(dir, '.mutant-42.worker-9.attempt-1.json.123.tmp'), '{"half":');

    expect(readSidecars(dir).map((record) => record.worker)).toEqual(['1']);
  });
});

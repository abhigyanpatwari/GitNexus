import { describe, expect, it } from 'vitest';
import { coverageInventory } from '../../../tools/scenario-map/inventory/coverage-inventory.js';
import type { CoverageWorkFile } from '../../../tools/scenario-map/path-coverage/run-coverage.js';

const provenance = {
  known: false,
  executedFiles: [],
  nativeEntries: [],
  workerSpawns: [],
  excludedCandidates: [],
};
const work = (
  state: 'passed' | 'skipped',
  recorded: boolean,
  errors: string[] = [],
): CoverageWorkFile => ({
  schemaVersion: 1,
  mode: 'normal',
  extraRoots: [],
  repeats: 1,
  blocks: [],
  unhandledErrors: [],
  files: [{ file: 'a.test.ts', recorded, errors, unattributed: provenance }],
  tests: [
    {
      id: 'a.test.ts#a',
      taskId: 'a',
      file: 'a.test.ts',
      fullName: 'a',
      location: null,
      state,
      concurrent: false,
      attempts: recorded ? 2 : 0,
      blocks: [],
      suiteBlocks: [],
      provenance,
    },
  ],
});

describe('runtime inventory accounting', () => {
  it('does not certify collection after an unhandled runner error', () => {
    const input = work('passed', true);
    input.unhandledErrors.push('worker exited unexpectedly');
    expect(coverageInventory(input, ['a.test.ts']).collectionComplete).toBe(false);
  });

  it('counts cases independently of files and exposes prefilter omissions', () => {
    const result = coverageInventory(work('passed', true), ['a.test.ts', 'b.test.ts']);
    expect(result.tests).toEqual({ collected: 1, passed: 1, failed: 0, skipped: 0, pending: 0 });
    expect(result.files.notScheduled).toEqual(['b.test.ts']);
    expect(result.collectionComplete).toBe(false);
  });

  it('accounts for fully skipped benchmarks without pretending they executed', () => {
    const result = coverageInventory(work('skipped', false), ['a.test.ts']);
    expect(result.collectionComplete).toBe(true);
    expect(result.tests).toMatchObject({ collected: 1, passed: 0, skipped: 1 });
  });

  it.each([
    { state: 'passed' as const, errors: [] },
    { state: 'skipped' as const, errors: ['collection failed'] },
  ])('does not hide missing records or collection errors: $state $errors', ({ state, errors }) => {
    const result = coverageInventory(work(state, false, errors), ['a.test.ts']);
    expect(result.files.unrecorded).toEqual(['a.test.ts']);
    expect(result.collectionComplete).toBe(false);
  });
});

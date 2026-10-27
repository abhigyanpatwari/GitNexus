import type { CoverageWorkFile, TestState } from '../path-coverage/run-coverage.js';
import { sortedUnique } from '../util.js';

/** Runtime counts, separate from file counts and from the subset that forms candidate pairs. */
export interface CoverageInventory {
  files: {
    inScope: number;
    scheduled: number;
    notScheduled: string[];
    unrecorded: string[];
    errors: string[];
  };
  tests: { collected: number } & Record<TestState, number>;
  /** False when some files may contain cases that the runtime inventory never saw. */
  collectionComplete: boolean;
}

export function coverageInventory(
  work: CoverageWorkFile,
  scope: readonly string[],
): CoverageInventory {
  const scheduled = new Set(work.files.map((file) => file.file));
  const testsByFile = new Map<string, typeof work.tests>();
  const tests = { collected: work.tests.length, passed: 0, failed: 0, skipped: 0, pending: 0 };
  for (const test of work.tests) {
    tests[test.state]++;
    const bucket = testsByFile.get(test.file) ?? [];
    bucket.push(test);
    testsByFile.set(test.file, bucket);
  }
  const files = {
    inScope: new Set(scope).size,
    scheduled: scheduled.size,
    notScheduled: sortedUnique(scope.filter((file) => !scheduled.has(file))),
    unrecorded: work.files
      .filter((file) => {
        if (file.recorded) return false;
        const own = testsByFile.get(file.file) ?? [];
        // Vitest does not invoke aroundAll for a fully skipped module (e.g. opt-in benchmarks).
        return !(
          file.errors.length === 0 &&
          own.length > 0 &&
          own.every((test) => test.state === 'skipped')
        );
      })
      .map((file) => file.file)
      .sort(),
    errors: work.files
      .filter((file) => file.errors.length > 0)
      .map((file) => file.file)
      .sort(),
  };
  return {
    files,
    tests,
    collectionComplete:
      files.notScheduled.length + files.unrecorded.length + files.errors.length === 0 &&
      work.unhandledErrors.length === 0,
  };
}

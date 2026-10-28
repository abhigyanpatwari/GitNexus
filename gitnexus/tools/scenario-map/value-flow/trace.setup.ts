/**
 * Worker setup file of the value-flow trace run (U11, R9, KTD11 "Trace", design §5.3a step 4).
 * trace.ts adds it through vitest-run.ts `runVitest` (`setupFiles`, after the vitest5 runner's
 * own setup file) and provides its context (`inject`, trace-records.ts `TraceContext`). With the
 * forks pool and default isolation every test file runs in a fresh fork, so this file starts
 * before the test file and the production modules load, and its record covers one test file.
 *
 *  - It wraps every entry of the context's wrap list (builtins.ts) on the global object with
 *    trace-records.ts `TraceRecorder`: pass-through proxies that record calls from production
 *    frames per current test (`TestRunner.getCurrentTest()`), and never change what the wrapped
 *    function does. Nothing is restored: the fork ends with the file.
 *  - The file-level `aroundEach` is the outermost wrapper of every attempt (repeat or retry): each
 *    attempt starts the test's calls over, and a test that ran is listed even with no call.
 *  - The file-level `aroundAll` writes the raw record when the file's run ends, after every
 *    `afterAll` hook, even a failing one.
 *
 * Vitest parses the second parameter of the around hooks as a fixture pattern, so it must be
 * written `{}`.
 */
import { createHash } from 'node:crypto';
import { TestRunner, aroundAll, aroundEach, inject, type RunnerTestCase } from 'vitest';
import { FIXTURE_CAPTURE_KEY } from '../path-coverage/fixture-capture.js';
import { TraceFixtureRoots } from './trace-fixtures.js';
import {
  TRACE_KEY,
  TraceRecorder,
  productionResolver,
  rawTraceName,
  writeRawTrace,
  type CurrentTest,
} from './trace-records.js';

const context = inject(TRACE_KEY);
if (context === undefined || context === null) {
  throw new Error('scenario-map trace: no context was provided (run it through trace.ts)');
}

const currentTest = (): CurrentTest | null => {
  const test = TestRunner.getCurrentTest<RunnerTestCase | undefined>();
  return test === undefined ? null : { id: test.id, concurrent: test.concurrent === true };
};

const fixtures = new TraceFixtureRoots();
Reflect.set(globalThis, FIXTURE_CAPTURE_KEY, (root: unknown) => fixtures.capture(root));
const recorder = new TraceRecorder({
  currentTest,
  production: productionResolver(context.preparedRoot, context.extraRoots),
  fixtureRoots: fixtures.roots,
});
recorder.install(globalThis, context.wrap);

// The `{}` is required: Vitest parses this parameter as a fixture pattern.
aroundAll(async (runSuite, {}, suite) => {
  try {
    await runSuite();
  } finally {
    const file = suite.file.filepath;
    const digest = createHash('sha256').update(file).digest('hex').slice(0, 16);
    writeRawTrace(context.outDir, rawTraceName(file, process.pid, digest), recorder.record(file));
  }
});

// The `{}` is required: Vitest parses this parameter as a fixture pattern.
aroundEach(async (runTest, {}) => {
  fixtures.clear();
  const test = currentTest();
  if (test !== null) recorder.testStarted(test);
  await runTest();
});

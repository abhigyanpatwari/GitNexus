/**
 * Worker setup file of the vitest5 runner. The runner prepends it to the project's setup files,
 * so with the forks pool and default isolation it runs in every fresh worker before the test file
 * (and anything the test file imports) loads.
 *
 * - It resets Stryker's instrumenter namespace and removes `__STRYKER_ACTIVE_MUTANT__` from the
 *   worker's environment, so only the runner decides which mutant is active (KTD5).
 * - Mutant run, static activation: the mutant is active from module load. Runtime activation: it
 *   becomes active when collection has ended. The hit count starts at module load either way.
 * - Dry run: coverage is recorded through {@link CoverageRecorder} (KTD4): load and collection
 *   hits stay static, test hits are per test, and a hit with no current test after collection is
 *   a hook hit of the deepest running suite.
 *
 * The file-level `aroundAll` marks the end of collection when it starts (it runs before every
 * `beforeAll` hook) and writes the {@link FileMeta} after the suite finished, after every
 * `afterAll` hook, even a failing one. Vitest parses the second parameter of the hook as a
 * fixture pattern, so it must be written `{}`.
 */
import type { InstrumenterContext } from '@stryker-mutator/api/core';
import {
  TestRunner,
  aroundAll,
  inject,
  type RunnerTask,
  type RunnerTestCase,
  type RunnerTestFile,
  type RunnerTestSuite,
} from 'vitest';
import { CoverageRecorder, attributeHookHits, type HitContext } from './coverage-attribution.js';
import { HOOK_NAMES, PROTOCOL_KEY, type FileMeta, type HookName } from './protocol.js';

const context = inject(PROTOCOL_KEY);
if (context === undefined || context === null) {
  throw new Error('vitest5 runner setup: no runner context was provided (wrong Vitest copy?)');
}

const globals = globalThis as unknown as Record<string, InstrumenterContext | undefined>;
const ns: InstrumenterContext = (globals[context.namespace] ??= {});
delete process.env[context.activeMutantEnv];
ns.activeMutant = undefined;
ns.currentTestId = undefined;
ns.mutantCoverage = undefined;
ns.hitCount = undefined;
ns.hitLimit = undefined;

let file: RunnerTestFile | undefined;
let recorder: CoverageRecorder | undefined;

const isRunningSuite = (task: RunnerTask): task is RunnerTestSuite =>
  task.type === 'suite' &&
  task.result !== undefined &&
  task.result.duration === undefined &&
  (task.result.state === 'run' || task.result.state === 'fail');

/** The file, then each started-but-unfinished suite down to the deepest unambiguous one. */
function runningSuiteChain(root: RunnerTestFile): string[] {
  const chain = [root.id];
  let current: RunnerTestSuite = root;
  for (;;) {
    const running = current.tasks.filter(isRunningSuite);
    if (running.length !== 1) return chain;
    current = running[0];
    chain.push(current.id);
  }
}

const NO_SUITES: readonly string[] = Object.freeze([]);

/** The suite chain is walked only for a hit with no current test, the one bucket that reads it. */
function hitContext(): HitContext {
  if (file === undefined) return { phase: 'collection' };
  const testId = TestRunner.getCurrentTest<RunnerTestCase | undefined>()?.id;
  return {
    phase: 'run',
    testId,
    runningSuiteIds: testId === undefined ? runningSuiteChain(file) : NO_SUITES,
  };
}

if (context.mode === 'mutant') {
  ns.hitCount = 0;
  ns.hitLimit = context.hitLimit ?? undefined;
  if (context.mutantActivation === 'static') ns.activeMutant = context.activeMutant ?? undefined;
} else {
  recorder = new CoverageRecorder(hitContext);
  ns.mutantCoverage = recorder.instrumenterView;
}

function buildFileMeta(root: RunnerTestFile): FileMeta {
  const testsBySuite: Record<string, string[]> = {};
  const failedHooks: Record<string, HookName[]> = {};
  const visit = (task: RunnerTask, ancestors: readonly string[]): void => {
    const hooks = task.result?.hooks ?? {};
    const failed = HOOK_NAMES.filter((name) => hooks[name] === 'run');
    if (failed.length > 0) failedHooks[task.id] = failed;
    if (task.type === 'test') {
      for (const suiteId of ancestors) testsBySuite[suiteId].push(task.id);
      return;
    }
    if (task.type === 'suite') {
      testsBySuite[task.id] = [];
      for (const child of task.tasks) visit(child, [...ancestors, task.id]);
    }
  };
  visit(root, []);
  return {
    hitCount: context.mode === 'mutant' ? (ns.hitCount ?? 0) : null,
    coverage: recorder === undefined ? null : attributeHookHits(recorder.snapshot(), testsBySuite),
    failedHooks,
  };
}

// The `{}` is required: Vitest parses this parameter as a fixture pattern.
aroundAll(async (runSuite, {}, suite) => {
  const root = suite.file;
  file = root;
  if (context.mode === 'mutant' && context.mutantActivation === 'runtime') {
    ns.activeMutant = context.activeMutant ?? undefined;
  }
  try {
    await runSuite();
  } finally {
    root.meta[PROTOCOL_KEY] = buildFileMeta(root);
  }
});

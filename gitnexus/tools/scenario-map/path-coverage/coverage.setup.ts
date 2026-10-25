/**
 * Layer 1 coverage hook of the scenario map (U4, R3, R4, KTD4, design §5.2): per-test V8 block
 * coverage in the vitest5 runner's hook pattern. run-coverage.ts puts it
 * first among the project's setup files and provides its context (`inject`, records.ts
 * `CoverageContext`). With the forks pool and default isolation every test file runs in a fresh
 * fork, so this file starts before the test file (and anything it imports) loads, and its record
 * covers exactly one test file.
 *
 *  - V8 precise coverage (`node:inspector`, call counts, block detail) starts here. Each take
 *    returns what ran since the previous take, and records.ts turns it into a window.
 *  - The file-level `aroundAll` starts before every `beforeAll` hook: its first take is the module
 *    load and collection window, whose blocks are discarded. When the file's run ends (after every
 *    `afterAll` hook, even a failing one) it takes the tail and writes the raw record.
 *  - The file-level `aroundEach` is the outermost wrapper of every test attempt (repeat or retry):
 *    the take before `runTest()` closes the window that holds the `beforeAll` work of the suites
 *    starting with this test, the take after it closes the test's own window, from before its
 *    `beforeEach` hooks to after its `afterEach` hooks, cleanups and `onTestFinished` callbacks.
 *    The test comes from `TestRunner.getCurrentTest()`; its suite chain and `concurrent` flag go
 *    with the window.
 *  - Pass-through wrappers record worker spawns (`worker_threads.Worker`, `child_process` spawn,
 *    spawnSync, fork, exec, execSync, execFile, execFileSync) and native loads (`process.dlopen`)
 *    with the first stack frame outside the hook; the next take carries them.
 *
 * This file and records.ts run inside every window, so their scripts are never listed. Vitest
 * parses the second parameter of the around hooks as a fixture pattern, so it must be written
 * `{}`.
 */
import { createHash } from 'node:crypto';
import { Session } from 'node:inspector/promises';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { WorkerOptions } from 'node:worker_threads';
import {
  TestRunner,
  aroundAll,
  aroundEach,
  inject,
  type RunnerTestCase,
  type RunnerTestSuite,
} from 'vitest';
import {
  COVERAGE_KEY,
  CoverageAttributor,
  CoverageInterner,
  callSite,
  isCallable,
  rawRecordName,
  scriptPath,
  spawnTarget,
  wrapCall,
  writeRawRecord,
  type RuntimeEvents,
  type WindowDelta,
} from './records.js';

const context = inject(COVERAGE_KEY);
if (context === undefined || context === null) {
  throw new Error(
    'scenario-map coverage: no context was provided (run it through run-coverage.ts)',
  );
}

const self = new Set(
  [import.meta.url, new URL('./records.ts', import.meta.url).href].map(
    (url) => scriptPath(url) ?? fileURLToPath(url),
  ),
);
const isSelf = (file: string): boolean => self.has(file);

// ── Spawns and native loads ────────────────────────────────────────────────

const events: RuntimeEvents = { natives: [], spawns: [] };
const drainEvents = (): RuntimeEvents => ({
  natives: events.natives.splice(0),
  spawns: events.spawns.splice(0),
});
const noteSpawn = (api: string, args: readonly unknown[]): void => {
  events.spawns.push({ api, target: spawnTarget(args), site: callSite(new Error().stack, isSelf) });
};

const CHILD_PROCESS_APIS = [
  'spawn',
  'spawnSync',
  'fork',
  'exec',
  'execSync',
  'execFile',
  'execFileSync',
] as const;
const childProcess = process.getBuiltinModule('node:child_process');
for (const name of CHILD_PROCESS_APIS) {
  const original: unknown = Reflect.get(childProcess, name);
  if (isCallable(original)) {
    Reflect.set(childProcess, name, wrapCall(original, `child_process.${name}`, noteSpawn));
  }
}

const workerThreads = process.getBuiltinModule('node:worker_threads');
const OriginalWorker = workerThreads.Worker;
class RecordedWorker extends OriginalWorker {
  constructor(filename: string | URL, options?: WorkerOptions) {
    noteSpawn('worker_threads.Worker', [filename]);
    super(filename, options);
  }
}
Object.defineProperty(workerThreads, 'Worker', {
  value: RecordedWorker,
  writable: true,
  configurable: true,
  enumerable: true,
});
syncBuiltinESMExports();

const originalDlopen = process.dlopen.bind(process);
process.dlopen = (module: object, filename: string, flags?: number): void => {
  events.natives.push(filename);
  if (flags === undefined) originalDlopen(module, filename);
  else originalDlopen(module, filename, flags);
};

// ── Coverage windows ───────────────────────────────────────────────────────

const session = new Session();
session.connect();
await session.post('Profiler.enable');
await session.post('Profiler.startPreciseCoverage', { callCount: true, detailed: true });

const interner = new CoverageInterner(context.blockRoots, self);
const attributor = new CoverageAttributor();

async function take(): Promise<WindowDelta> {
  const { result } = await session.post('Profiler.takePreciseCoverage');
  return interner.summarize(result, drainEvents());
}

/** Suite task ids from the file down to the test's parent, each once. */
function suiteChain(test: RunnerTestCase): string[] {
  const chain: string[] = [];
  for (let suite: RunnerTestSuite | undefined = test.suite; suite; suite = suite.suite) {
    chain.push(suite.id);
  }
  chain.push(test.file.id);
  return [...new Set(chain.reverse())];
}

// The `{}` is required: Vitest parses this parameter as a fixture pattern.
aroundAll(async (runSuite, {}, suite) => {
  attributor.load(await take());
  try {
    await runSuite();
  } finally {
    attributor.finish(await take());
    const file = suite.file.filepath;
    const digest = createHash('sha256').update(file).digest('hex').slice(0, 16);
    writeRawRecord(
      context.outDir,
      rawRecordName(file, process.pid, digest),
      attributor.record(file, interner),
    );
  }
});

// The `{}` is required: Vitest parses this parameter as a fixture pattern.
aroundEach(async (runTest, {}) => {
  const test = TestRunner.getCurrentTest<RunnerTestCase | undefined>();
  if (test === undefined) {
    await runTest();
    return;
  }
  attributor.testStart(test.id, suiteChain(test), test.concurrent === true, await take());
  try {
    await runTest();
  } finally {
    attributor.testEnd(test.id, await take());
  }
});

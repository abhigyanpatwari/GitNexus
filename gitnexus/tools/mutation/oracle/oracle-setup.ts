/**
 * The oracle's worker setup file (U12, KTD15). launch-single.ts puts it first among the mutation
 * project's setup files, so with the forks pool and default isolation it runs in the launch's
 * fresh worker before the test file, and anything the test file imports, is loaded.
 *
 * 1. Activation: before any test-file import it compares the mutant id installed through
 *    `__STRYKER_ACTIVE_MUTANT__` with the id the launcher intended ({@link INTENDED_MUTANT_ENV})
 *    and checks that no instrumented code ran yet. It writes the probe file at once; on a
 *    mismatch it throws, so no test runs and the launcher classifies the launch invalid.
 * 2. It installs the id in Stryker's namespace itself, the value the instrumented code would read
 *    from the environment, and counts the installed mutant's hits through an accessor on the
 *    namespace's `hitCount` (the instrumenter increments it on every hit of the active mutant; no
 *    hit limit is set, the launch's wall clock bounds a hang).
 * 3. Each hit lands in one bucket (probe.ts): load and collection until the file-level
 *    `aroundAll` starts (it runs before every `beforeAll`), per test while
 *    `TestRunner.getCurrentTest()` names one, and hook otherwise.
 * 4. The `aroundAll` teardown, which runs after every `afterAll` hook and `beforeAll` cleanup,
 *    failing ones included, rewrites the probe file with the hits.
 *
 * It imports nothing from the vitest5 runner. Vitest parses the second parameter of `aroundAll`
 * as a fixture pattern, so it must be written `{}`.
 */
import { renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { INSTRUMENTER_CONSTANTS } from '@stryker-mutator/api/core';
import { TestRunner, aroundAll, type RunnerTask, type RunnerTestCase } from 'vitest';
import {
  INTENDED_MUTANT_ENV,
  PROBE_FILE_ENV,
  PROBE_SCHEMA_VERSION,
  checkActivation,
  mutantIdFromEnv,
  type OracleProbe,
  type ProbeHits,
  type ProbeTestHits,
} from './probe.js';

interface Namespace {
  activeMutant?: string;
  hitCount?: number;
  hitLimit?: number;
}

const probeFile = process.env[PROBE_FILE_ENV];
if (probeFile === undefined || !path.isAbsolute(probeFile)) {
  throw new Error(`oracle setup: ${PROBE_FILE_ENV} must name an absolute probe file`);
}

const writeProbe = (probe: OracleProbe): void => {
  const temporary = path.join(
    path.dirname(probeFile),
    `.${path.basename(probeFile)}.${process.pid}.tmp`,
  );
  writeFileSync(temporary, `${JSON.stringify(probe)}\n`);
  renameSync(temporary, probeFile);
};

const globals = globalThis as unknown as Record<string, Namespace | undefined>;
const existing = globals[INSTRUMENTER_CONSTANTS.NAMESPACE];
const activation = checkActivation({
  intended: mutantIdFromEnv(process.env[INTENDED_MUTANT_ENV]),
  installed: mutantIdFromEnv(process.env[INSTRUMENTER_CONSTANTS.ACTIVE_MUTANT_ENV_VARIABLE]),
  namespaceExists: existing !== undefined,
  namespaceActiveMutant: existing?.activeMutant ?? null,
});
writeProbe({
  schemaVersion: PROBE_SCHEMA_VERSION,
  pid: process.pid,
  activation,
  hits: null,
  complete: false,
});
if (!activation.matches) {
  throw new Error(
    `oracle setup: installed mutant ${JSON.stringify(activation.installed)} differs from the ` +
      `intended ${JSON.stringify(activation.intended)}` +
      (activation.instrumentedBeforeSetup ? ' or instrumented code ran before the setup file' : ''),
  );
}

const ns: Namespace = existing ?? {};
globals[INSTRUMENTER_CONSTANTS.NAMESPACE] = ns;
ns.activeMutant = activation.installed ?? undefined;
ns.hitLimit = undefined;

let runStarted = false;
let total = 0;
let loadAndCollection = 0;
let hook = 0;
const perTest = new Map<string, { task: RunnerTestCase; count: number }>();

const recordHit = (): void => {
  if (!runStarted) {
    loadAndCollection++;
    return;
  }
  const test = TestRunner.getCurrentTest<RunnerTestCase | undefined>();
  if (test === undefined) {
    hook++;
    return;
  }
  const entry = perTest.get(test.id) ?? { task: test, count: 0 };
  entry.count++;
  perTest.set(test.id, entry);
};

// The instrumenter runs `++ns.hitCount` for every hit of the active mutant.
Object.defineProperty(ns, INSTRUMENTER_CONSTANTS.HIT_COUNT, {
  configurable: true,
  enumerable: true,
  get: (): number => total,
  set: (value: number): void => {
    recordHit();
    total = value;
  },
});

const testHits = (task: RunnerTask, count: number): ProbeTestHits => ({
  taskId: task.id,
  fullName: task.fullTestName ?? task.name,
  location:
    task.location === undefined ? null : { line: task.location.line, column: task.location.column },
  count,
});

const snapshot = (): ProbeHits => ({
  loadAndCollection,
  hook,
  perTest: [...perTest.values()].map((entry) => testHits(entry.task, entry.count)),
});

// The `{}` is required: Vitest parses this parameter as a fixture pattern.
aroundAll(async (runSuite, {}) => {
  runStarted = true;
  try {
    await runSuite();
  } finally {
    writeProbe({
      schemaVersion: PROBE_SCHEMA_VERSION,
      pid: process.pid,
      activation,
      hits: snapshot(),
      complete: true,
    });
  }
});

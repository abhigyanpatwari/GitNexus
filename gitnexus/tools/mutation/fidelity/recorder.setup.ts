/**
 * Gate 1 recorder (U6, KTD19): a Vitest setup file that both gate 1 runs load. The base run adds
 * it to the `default` project's setup files; the Stryker run gets it from
 * vitest.fidelity.config.ts. With the forks pool and default isolation every test file runs in a
 * fresh fork, so this file starts before the test file (and anything it imports) loads, and the
 * record covers exactly one test file. It observes and never changes what the file does:
 *
 *  - every Node resolution after it starts (`module.registerHooks`): builtins and externalized
 *    packages, including what package code imports (the U5 classifier does not walk packages);
 *  - native addons (`process.dlopen`), `worker_threads` Worker construction and
 *    `process.getBuiltinModule` lookups, through pass-through wrappers;
 *  - when the file ends, every module the Vite module runner evaluated (inlined test and
 *    production modules, and the externals they import directly) with its first importer;
 *  - environment variables read by name while the file loads and collects, through a
 *    pass-through proxy on `process.env` that is removed when collection ends;
 *  - the values of the compared environment variables (record.ts `isComparedEnv`) at load.
 *
 * Each load carries its phase (`load` until the file-level `aroundAll` starts, then `run`) and the
 * running test's full name. The record is written atomically to the directory named by
 * GITNEXUS_MUTATION_FIDELITY_DIR when the file's run ends (record.ts `WorkerRecord`). A file whose
 * collection fails writes no record; gate 1 reports it as missing. Vitest parses the second
 * parameter of the `aroundAll` hook as a fixture pattern, so it must be written `{}`.
 */
import { createHash } from 'node:crypto';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import type { WorkerOptions } from 'node:worker_threads';
import { TestRunner, aroundAll, type RunnerTestCase, type WorkerGlobalState } from 'vitest';
import {
  FIDELITY_DIR_ENV,
  RECORD_SCHEMA_VERSION,
  WORKER_RECORD_PREFIX,
  firstForeignFrame,
  isComparedEnv,
  keepsEnvValue,
  writeRecordFile,
  type EnvRead,
  type LoadEvent,
  type LoadSource,
  type Phase,
  type WorkerRecord,
} from './record.js';

const recordDir = process.env[FIDELITY_DIR_ENV];
if (recordDir === undefined || recordDir === '') {
  throw new Error(`gate 1 recorder: ${FIDELITY_DIR_ENV} is not set`);
}
if (typeof registerHooks !== 'function') {
  throw new Error('gate 1 recorder: module.registerHooks is missing (Node >= 22.15 required)');
}

let phase: Phase = 'load';
const loads: LoadEvent[] = [];
const seen = new Set<string>();

const currentTest = (): string | null =>
  TestRunner.getCurrentTest<RunnerTestCase | undefined>()?.fullName ?? null;

function note(source: LoadSource, module: string, parent: string | null, at?: Phase): void {
  const key = `${source}\u0000${module}`;
  if (seen.has(key)) return;
  seen.add(key);
  loads.push({
    source,
    module,
    parent,
    phase: at ?? phase,
    test: at === undefined ? currentTest() : null,
  });
}

// ── Environment ───────────────────────────────────────────────────────────

const originalEnv = process.env;
const env: Record<string, string | null> = Object.fromEntries(
  Object.keys(originalEnv)
    .filter((name) => isComparedEnv(name) && name !== FIDELITY_DIR_ENV)
    .sort()
    .map((name) => [name, originalEnv[name] ?? null]),
);
const envReads = new Map<string, EnvRead>();

function noteEnvRead(name: string): void {
  if (envReads.has(name)) return;
  const value = originalEnv[name];
  envReads.set(name, {
    name,
    value: keepsEnvValue(name) ? (value ?? null) : null,
    set: value !== undefined,
    reader: firstForeignFrame(new Error().stack),
  });
}

const envProxy = new Proxy(originalEnv, {
  get(target, key) {
    if (typeof key === 'string') noteEnvRead(key);
    return Reflect.get(target, key);
  },
  has(target, key) {
    if (typeof key === 'string') noteEnvRead(key);
    return Reflect.has(target, key);
  },
  set(target, key, value) {
    return Reflect.set(target, key, value);
  },
});

// ── Native addons, workers, builtin lookups ───────────────────────────────

const workerThreads = process.getBuiltinModule('node:worker_threads');
const OriginalWorker = workerThreads.Worker;
class RecordedWorker extends OriginalWorker {
  constructor(filename: string | URL, options?: WorkerOptions) {
    note('worker', String(filename), firstForeignFrame(new Error().stack));
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
  note('dlopen', filename, firstForeignFrame(new Error().stack));
  if (flags === undefined) originalDlopen(module, filename);
  else originalDlopen(module, filename, flags);
};

const originalGetBuiltinModule = process.getBuiltinModule.bind(process);
Object.defineProperty(process, 'getBuiltinModule', {
  value: (id: string): unknown => {
    note('builtin-getter', id, firstForeignFrame(new Error().stack));
    return originalGetBuiltinModule(id);
  },
  writable: true,
  configurable: true,
});

registerHooks({
  resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context);
    note('node-resolve', result.url, context.parentURL ?? null);
    return result;
  },
});

process.env = envProxy;

// ── The file's record ─────────────────────────────────────────────────────

const workerState = (): WorkerGlobalState => {
  const state = (globalThis as { __vitest_worker__?: WorkerGlobalState }).__vitest_worker__;
  if (state === undefined) throw new Error('gate 1 recorder: no Vitest worker state');
  return state;
};

function writeRecord(file: string, loadedAtStart: ReadonlySet<string>): void {
  const state = workerState();
  for (const [id, node] of state.evaluatedModules.idToModuleMap) {
    const importer: string | undefined = node.importers.values().next().value;
    note('module-runner', id, importer ?? null, loadedAtStart.has(id) ? 'load' : 'run');
  }
  const record: WorkerRecord = {
    schemaVersion: RECORD_SCHEMA_VERSION,
    pid: process.pid,
    ppid: process.ppid,
    file,
    root: state.config.root,
    project: state.config.name ?? '',
    loads,
    envReadsAtLoad: [...envReads.values()].sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    ),
    env,
  };
  const digest = createHash('sha256').update(file).digest('hex').slice(0, 16);
  writeRecordFile(recordDir ?? '', `${WORKER_RECORD_PREFIX}${process.pid}-${digest}.json`, record);
}

// The `{}` is required: Vitest parses this parameter as a fixture pattern.
aroundAll(async (runSuite, {}, suite) => {
  phase = 'run';
  if (process.env === envProxy) process.env = originalEnv;
  const loadedAtStart = new Set(workerState().evaluatedModules.idToModuleMap.keys());
  try {
    await runSuite();
  } finally {
    writeRecord(suite.file.filepath, loadedAtStart);
  }
});

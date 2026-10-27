/**
 * Worker side of the Layer 1 coverage hook (U4, R3, R4, KTD4, design §5.2): the raw per-file record
 * coverage.setup.ts writes, and the pure pieces it is built from. run-coverage.ts reads the records
 * and turns them into the work file.
 *
 *  - {@link CoverageInterner} turns one `Profiler.takePreciseCoverage` result (a window) into
 *    interned block keys and executed scripts. A block key is `<script index>#<function or
 *    <anon>>@<function start>` for an executed function, plus
 *    `<script index>#<function>@<function start>|<start>-<end>:<1|0>` for each of its nested
 *    ranges (covered or not in the window). Blocks are kept only for scripts under
 *    the block roots (the prepared copy's production roots); every other executed script is listed
 *    by path only. `node:` scripts and the hook's own modules (this file and the setup file) are
 *    never listed: the hook runs inside every window.
 *  - {@link CoverageAttributor} applies design §5.2: the window before the first test (module load
 *    and collection) is discarded; the window that ends when a test's first attempt starts holds
 *    the `beforeAll` work of the suites of its chain that start there, and is kept once as a
 *    {@link RawSuiteWindow} with those suites (outermost first). run-coverage.ts gives its blocks
 *    to the tests of the deepest of them (the suite whose first test it is, design §5.2) and its
 *    provenance to the tests of the outermost (fail-closed: when a file-level and a nested
 *    `beforeAll` run back to back, the split between them is unknown). A test's own window runs
 *    from before its `beforeEach` hooks to after its `afterEach` hooks and cleanups. A window
 *    outside any test that starts no suite (an `afterAll`, the tail after the last test) and the
 *    load window go to the file's `unattributed` bucket, which keeps their provenance. With
 *    repeats or retries the last attempt is the `warm` window; `all` is the union of every
 *    attempt.
 *  - {@link wrapCall} and {@link callSite} record worker spawns and native loads with the first
 *    stack frame outside the hook.
 *
 * Self-contained on purpose: this module runs inside every window, so it imports only `node:`
 * builtins and the hook can leave exactly two files out of the provenance it records.
 */
import { renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

/** provide/inject key of the hook's context (run-coverage.ts provides it). */
export const COVERAGE_KEY = 'gitnexusScenarioCoverage';
export const RAW_RECORD_SCHEMA_VERSION = 1;
/** File name prefix of the raw records in {@link CoverageContext.outDir}. */
export const RAW_RECORD_PREFIX = 'coverage-';

export interface CoverageContext {
  /** Absolute directory the raw records are written to. */
  outDir: string;
  /** Absolute POSIX directories, each with a trailing `/`, whose scripts keep their blocks. */
  blockRoots: string[];
}

declare module 'vitest' {
  interface ProvidedContext {
    gitnexusScenarioCoverage: CoverageContext;
  }
}

// ── V8 precise coverage (the subset of node:inspector's Profiler types read here) ──

export interface V8Range {
  startOffset: number;
  endOffset: number;
  count: number;
}

export interface V8Function {
  functionName: string;
  ranges: V8Range[];
}

export interface V8Script {
  url: string;
  functions: V8Function[];
}

// ── Records ────────────────────────────────────────────────────────────────

/** A worker spawn seen by a wrapped API, with its target and first non-hook stack frame. */
export interface SpawnEvent {
  /** `worker_threads.Worker`, `child_process.spawn`, `child_process.execSync` … */
  api: string;
  /** The module, file or command, as passed (at most {@link MAX_TARGET} characters). */
  target: string;
  /** `<absolute path or URL>:<line>:<column>` of the calling frame; null when none is found. */
  site: string | null;
}

/** Spawns and native loads observed by the wrappers since the last take. */
export interface RuntimeEvents {
  /** Absolute file names passed to `process.dlopen`. */
  natives: string[];
  spawns: SpawnEvent[];
}

/** One window, interned: indices into the record's `blocks` and `scripts` tables, ascending. */
export interface RawWindow {
  blocks: number[];
  scripts: number[];
  natives: string[];
  spawns: SpawnEvent[];
}

/** A window that ended when a test's first attempt started, and the suites that started in it. */
export interface RawSuiteWindow {
  /** Suite task ids, outermost first; never empty. */
  suites: string[];
  window: RawWindow;
}

export interface RawTestCoverage {
  taskId: string;
  /** Suite task ids from the file down to the test's parent. */
  suiteChain: string[];
  /** The task ran concurrently (`test.concurrent`, `describe.concurrent`). */
  concurrent: boolean;
  /** Windows observed: one per repeat and retry. */
  attempts: number;
  /** The last attempt's window. */
  warm: RawWindow;
  /** The union of every attempt's window. */
  all: RawWindow;
}

/** One test file's raw record, written by coverage.setup.ts when the file's run ends. */
export interface RawCoverageRecord {
  schemaVersion: typeof RAW_RECORD_SCHEMA_VERSION;
  /** Absolute test file path. */
  file: string;
  /** Interned absolute POSIX script paths. */
  scripts: string[];
  /** Interned block keys (see the module header). */
  blocks: string[];
  /** `beforeAll` windows, in the order they ended. */
  suiteWindows: RawSuiteWindow[];
  /** Load window, windows that start no suite, and the tail. */
  unattributed: RawWindow;
  tests: RawTestCoverage[];
}

/** Longest spawn target kept; a Worker with `eval: true` passes its whole source. */
export const MAX_TARGET = 200;

// ── Paths ──────────────────────────────────────────────────────────────────

const toPosix = (file: string): string => file.replace(/\\/g, '/');

/**
 * The absolute POSIX path of a V8 script URL (a `file:` URL or an absolute path; a query is
 * dropped); null for `node:` builtins, evaluated code and anything else without a file.
 */
export function scriptPath(url: string): string | null {
  if (url.startsWith('file://')) {
    try {
      return toPosix(fileURLToPath(url));
    } catch {
      return null;
    }
  }
  const bare = url.replace(/\?.*$/, '');
  if (bare.startsWith('/') || /^[A-Za-z]:[\\/]/.test(bare)) return toPosix(path.normalize(bare));
  return null;
}

/** A frame's location: after `at ` or `(`, so `node:internal/x:1:1` never matches its `/x` part. */
const FRAME = /(?:^|[\s(])((?:file:\/\/|\/|[A-Za-z]:[\\/])[^()]*?):(\d+):(\d+)\)?$/;

/**
 * `<file>:<line>:<column>` of the first stack frame whose file `skip` rejects; `node:` frames
 * never match. null when no frame qualifies.
 */
export function callSite(
  stack: string | undefined,
  skip: (file: string) => boolean,
): string | null {
  for (const line of (stack ?? '').split('\n').slice(1)) {
    const match = FRAME.exec(line.trim());
    if (match === null) continue;
    const file = scriptPath(match[1]);
    if (file !== null && !skip(file)) return `${file}:${match[2]}:${match[3]}`;
  }
  return null;
}

// ── Windows ────────────────────────────────────────────────────────────────

/** One take: interned blocks and executed scripts, plus the runtime events since the last take. */
export interface WindowDelta {
  blocks: Set<number>;
  scripts: Set<number>;
  natives: Set<string>;
  spawns: SpawnEvent[];
}

const emptyWindow = (): WindowDelta => ({
  blocks: new Set(),
  scripts: new Set(),
  natives: new Set(),
  spawns: [],
});

function mergeInto(target: WindowDelta, delta: WindowDelta): void {
  for (const block of delta.blocks) target.blocks.add(block);
  for (const script of delta.scripts) target.scripts.add(script);
  for (const native of delta.natives) target.natives.add(native);
  target.spawns.push(...delta.spawns);
}

const ascending = (a: number, b: number): number => a - b;

const toRaw = (window: WindowDelta): RawWindow => ({
  blocks: [...window.blocks].sort(ascending),
  scripts: [...window.scripts].sort(ascending),
  natives: [...window.natives].sort(),
  spawns: [...window.spawns],
});

/** Interns the scripts and block keys of one test file's windows. */
export class CoverageInterner {
  readonly scripts: string[] = [];
  readonly blocks: string[] = [];
  readonly #scriptIndex = new Map<string, number>();
  readonly #blockIndex = new Map<string, number>();
  readonly #blockRoots: readonly string[];
  readonly #ignored: ReadonlySet<string>;

  /** `ignored`: absolute POSIX paths never listed (the hook's own modules). */
  constructor(blockRoots: readonly string[], ignored: ReadonlySet<string>) {
    this.#blockRoots = blockRoots.map(toPosix);
    this.#ignored = new Set([...ignored].map(toPosix));
  }

  #script(file: string): number {
    let index = this.#scriptIndex.get(file);
    if (index === undefined) {
      index = this.scripts.length;
      this.scripts.push(file);
      this.#scriptIndex.set(file, index);
    }
    return index;
  }

  #block(key: string): number {
    let index = this.#blockIndex.get(key);
    if (index === undefined) {
      index = this.blocks.length;
      this.blocks.push(key);
      this.#blockIndex.set(key, index);
    }
    return index;
  }

  #keepsBlocks(file: string): boolean {
    return !file.includes('/node_modules/') && this.#blockRoots.some((r) => file.startsWith(r));
  }

  /** One window: what ran since the previous take (V8 resets its counters at each take). */
  summarize(result: readonly V8Script[], events: RuntimeEvents): WindowDelta {
    const window = emptyWindow();
    for (const native of events.natives) window.natives.add(native);
    window.spawns.push(...events.spawns);
    for (const script of result) {
      const file = scriptPath(script.url);
      if (file === null || this.#ignored.has(file)) continue;
      const executed = script.functions.filter(
        (fn) => fn.ranges.length > 0 && fn.ranges[0].count > 0,
      );
      if (executed.length === 0) continue;
      const index = this.#script(file);
      window.scripts.add(index);
      if (!this.#keepsBlocks(file)) continue;
      for (const fn of executed) {
        const [head, ...nested] = fn.ranges;
        const id = `${index}#${fn.functionName || '<anon>'}@${head.startOffset}`;
        window.blocks.add(this.#block(id));
        for (const range of nested) {
          const covered = range.count > 0 ? 1 : 0;
          window.blocks.add(
            this.#block(`${id}|${range.startOffset}-${range.endOffset}:${covered}`),
          );
        }
      }
    }
    return window;
  }
}

interface TestState {
  suiteChain: string[];
  concurrent: boolean;
  attempts: number;
  warm: WindowDelta;
  all: WindowDelta;
}

/** Applies the design §5.2 attribution rules to one test file's windows (module header). */
export class CoverageAttributor {
  readonly #started = new Set<string>();
  readonly #suiteWindows: { suites: string[]; window: WindowDelta }[] = [];
  readonly #tests = new Map<string, TestState>();
  readonly #unattributed: WindowDelta = emptyWindow();

  /** The window before the first test: module load and collection. Its blocks are discarded. */
  load(delta: WindowDelta): void {
    mergeInto(this.#unattributed, delta);
  }

  /** The window that ended when an attempt of a test started. */
  testStart(
    taskId: string,
    suiteChain: readonly string[],
    concurrent: boolean,
    delta: WindowDelta,
  ): void {
    // Outer suites start before inner ones, so the fresh suites are a tail of the chain.
    const fresh = suiteChain.filter((suite) => !this.#started.has(suite));
    for (const suite of fresh) this.#started.add(suite);
    if (fresh.length === 0) mergeInto(this.#unattributed, delta);
    else this.#suiteWindows.push({ suites: fresh, window: delta });
    if (!this.#tests.has(taskId)) {
      this.#tests.set(taskId, {
        suiteChain: [...suiteChain],
        concurrent,
        attempts: 0,
        warm: emptyWindow(),
        all: emptyWindow(),
      });
    }
  }

  /** The window of one attempt, taken when it ended. */
  testEnd(taskId: string, delta: WindowDelta): void {
    const test = this.#tests.get(taskId);
    if (test === undefined) {
      mergeInto(this.#unattributed, delta);
      return;
    }
    test.attempts += 1;
    test.warm = delta;
    mergeInto(test.all, delta);
  }

  /** The tail: what ran after the last test (`afterAll` hooks). */
  finish(delta: WindowDelta): void {
    mergeInto(this.#unattributed, delta);
  }

  record(file: string, interner: CoverageInterner): RawCoverageRecord {
    return {
      schemaVersion: RAW_RECORD_SCHEMA_VERSION,
      file: toPosix(file),
      scripts: [...interner.scripts],
      blocks: [...interner.blocks],
      suiteWindows: this.#suiteWindows.map(({ suites, window }) => ({
        suites: [...suites],
        window: toRaw(window),
      })),
      unattributed: toRaw(this.#unattributed),
      tests: [...this.#tests].map(
        ([taskId, test]): RawTestCoverage => ({
          taskId,
          suiteChain: test.suiteChain,
          concurrent: test.concurrent,
          attempts: test.attempts,
          warm: toRaw(test.warm),
          all: toRaw(test.all),
        }),
      ),
    };
  }
}

// ── Wrappers ───────────────────────────────────────────────────────────────

/** A function value, called through `Reflect.apply`. */
export type Callable = (this: unknown, ...args: unknown[]) => unknown;

/** Narrows a value to a function. */
export const isCallable = (value: unknown): value is Callable => typeof value === 'function';

/**
 * A pass-through wrapper that reports each call (`api`, arguments) before calling `original`.
 * Own properties are copied, and `util.promisify.custom` (exec, execFile) is wrapped too, so
 * promisified calls are seen and keep their result shape.
 */
export function wrapCall(
  original: Callable,
  api: string,
  note: (api: string, args: readonly unknown[]) => void,
): Callable {
  const wrapped: Callable = function (this: unknown, ...args: unknown[]): unknown {
    note(api, args);
    return Reflect.apply(original, this, args);
  };
  for (const key of Reflect.ownKeys(original)) {
    // promisify.custom is wrapped below; Node defines it non-configurable, so never copy it first.
    if (key === 'length' || key === 'name' || key === 'prototype' || key === promisify.custom) {
      continue;
    }
    const descriptor = Reflect.getOwnPropertyDescriptor(original, key);
    if (descriptor !== undefined) Reflect.defineProperty(wrapped, key, descriptor);
  }
  const custom: unknown = Reflect.get(original, promisify.custom);
  if (isCallable(custom)) {
    Reflect.defineProperty(wrapped, promisify.custom, {
      value: wrapCall(custom, api, note),
      configurable: true,
      enumerable: false,
      writable: true,
    });
  }
  return wrapped;
}

/** The target text of a spawn: the first argument as a string, cut to {@link MAX_TARGET}. */
export function spawnTarget(args: readonly unknown[]): string {
  const first = args[0];
  const text = first instanceof URL ? first.href : String(first);
  return text.length > MAX_TARGET ? `${text.slice(0, MAX_TARGET)}…` : text;
}

// ── Output ─────────────────────────────────────────────────────────────────

/** Name of a test file's raw record; the pid keeps a re-run file apart. */
export function rawRecordName(file: string, pid: number, digest: string): string {
  return `${RAW_RECORD_PREFIX}${pid}-${digest}-${path.posix.basename(toPosix(file))}.json`;
}

/** Writes a raw record atomically (temporary dot-file, then rename), compact. */
export function writeRawRecord(dir: string, name: string, record: RawCoverageRecord): void {
  const target = path.join(dir, name);
  const temp = path.join(dir, `.${name}.${process.pid}.tmp`);
  writeFileSync(temp, JSON.stringify(record));
  renameSync(temp, target);
}

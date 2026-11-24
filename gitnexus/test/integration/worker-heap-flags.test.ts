import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Every heap-flag form a process can start with, in a real child process (V8
// rejects a space-separated size value in NODE_OPTIONS at startup, so that is
// not one of them): the lease must cap a worker under each form it can clear
// and restore the flags exactly. Under frozen flags, or flags the main
// isolate's live heap limit contradicts, it must not touch them, and
// admission must then charge each worker the main heap.

let directory: string;
let reportWorker: string;

let rewriteNodeOptions: string;

beforeAll(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-heap-flags-'));
  reportWorker = path.join(directory, 'report-heap.cjs');
  fs.writeFileSync(
    reportWorker,
    "require('node:worker_threads').parentPort.postMessage(Math.round(require('node:v8').getHeapStatistics().heap_size_limit / 2 ** 20));",
  );
  // A preload that rewrites NODE_OPTIONS after Node has applied it.
  rewriteNodeOptions = path.join(directory, 'rewrite-node-options.cjs');
  fs.writeFileSync(rewriteNodeOptions, "process.env.NODE_OPTIONS = '--max-old-space-size=2000';");
});

afterAll(() => fs.rmSync(directory, { recursive: true, force: true }));

interface Measured {
  main: number;
  before: number;
  capped: number;
  inherited: number;
  later: number;
  mainHeapMb: number;
  workerHeapMb: number;
}

// A 256 MiB cap plus V8's default young generation: 48 MiB on Node 22, 96 on
// Node 26, up to 192 on Node 24.
const CAPPED_MAX_MB = 256 + 192;

const dist = (file: string) => pathToFileURL(path.resolve('dist', file)).href;

/** Run an ES module in a fresh Node process and parse the JSON on its last stdout line. */
function runWithFlags(
  execArgv: string[],
  nodeOptions: string | undefined,
  runner: string,
): unknown {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  if (nodeOptions !== undefined) env.NODE_OPTIONS = nodeOptions;
  const run = spawnSync(process.execPath, [...execArgv, '--input-type=module', '--eval', runner], {
    env,
    encoding: 'utf8',
    timeout: 30000,
  });
  const output = `${run.stdout}\n${run.stderr}`;
  expect(run.status, output).toBe(0);
  expect(output).not.toContain('V8_Fatal');
  return JSON.parse(run.stdout.trim().split('\n').at(-1) ?? '');
}

function measure(execArgv: string[], nodeOptions?: string, evalComment = '') {
  const worker = JSON.stringify(pathToFileURL(reportWorker).href);
  const runner = `${evalComment}
    import { spawnWithInheritedHeap, spawnWithOwnHeapLimit } from ${JSON.stringify(dist('core/ingestion/workers/worker-heap-limit.js'))};
    import { resolveHostAnalysisResources } from ${JSON.stringify(dist('core/analysis-host-resources.js'))};
    import { getHeapStatistics } from 'node:v8';
    import { Worker } from 'node:worker_threads';
    const report = async (w) => { const mb = await new Promise((r) => w.once('message', r)); await w.terminate(); return mb; };
    // An ordinary worker before any lease: the heap the flags give a worker.
    const before = await report(new Worker(new URL(${worker})));
    const capped = await report(spawnWithOwnHeapLimit(() => new Worker(new URL(${worker}), { resourceLimits: { maxOldGenerationSizeMb: 256 } })));
    // A community-style worker after the parser lease, then a plain one.
    const inherited = await report(spawnWithInheritedHeap((resourceLimits) => new Worker(new URL(${worker}), { resourceLimits })));
    const later = await report(new Worker(new URL(${worker})));
    const budget = resolveHostAnalysisResources({ includeEmbeddings: false, supervisorBytes: 192 * 2 ** 20 });
    console.log(JSON.stringify({
      main: Math.round(getHeapStatistics().heap_size_limit / 2 ** 20),
      before, capped, inherited, later, mainHeapMb: budget.mainHeapMb, workerHeapMb: budget.parse.workerHeapMb,
    }));
  `;
  return runWithFlags(execArgv, nodeOptions, runner) as Measured;
}

/** How a manual-heap analyze in a process with these flags states its main heap. */
function cliHeapAdmission(execArgv: string[], nodeOptions?: string) {
  const runner = `
    import { manualHeapAdmission } from ${JSON.stringify(dist('cli/analyze.js'))};
    console.log(JSON.stringify(manualHeapAdmission()));
  `;
  return runWithFlags(execArgv, nodeOptions, runner) as {
    mainHeapMb?: number;
    mainHeapLimitMb?: number;
  };
}

it.each([
  ['execArgv size', ['--max-old-space-size=3000'], undefined],
  ['NODE_OPTIONS size', [], '--max-old-space-size=3000'],
  ['quoted NODE_OPTIONS size', [], '--max-old-space-size="3000"'],
  [
    'execArgv size with semi-space',
    ['--max-old-space-size=3000', '--max-semi-space-size=64'],
    undefined,
  ],
  ['execArgv --max-heap-size', ['--max-heap-size=3072'], undefined],
  [
    'execArgv --max-heap-size with a smaller old space',
    ['--max-heap-size=3000', '--max-old-space-size=1000'],
    undefined,
  ],
  ['NODE_OPTIONS size with semi-space', [], '--max-old-space-size=3000 --max-semi-space-size=64'],
  // V8 also accepts one leading dash, a sign and leading whitespace.
  ['a single-dash execArgv size', ['-max_old_space_size=3000'], undefined],
  ['a signed NODE_OPTIONS size', [], '--max-old-space-size=+3000'],
  ['a NODE_OPTIONS size with leading whitespace', [], '"--max-old-space-size= 3000"'],
  [
    'frozen flags unfrozen by the --no<name> spelling',
    ['--freeze-flags-after-init', '--nofreeze-flags-after-init', '--max-old-space-size=3000'],
    undefined,
  ],
  // V8 ignores a value out of its bounds and keeps the earlier one.
  [
    'an out-of-bounds --max-heap-size beside a size',
    ['--max-old-space-size=3000', '--max-heap-size=100000000000000000000'],
    undefined,
  ],
])(
  'caps a leased worker and restores the flags under %s',
  (_label, execArgv, nodeOptions) => {
    const measured = measure(execArgv, nodeOptions);
    expect(measured.main).toBeGreaterThanOrEqual(3000);
    expect(measured.capped).toBeLessThanOrEqual(CAPPED_MAX_MB);
    // A worker created after the lease gets the inherited heap again, and a
    // community-style worker gets it too: exactly, or under --max-heap-size
    // alone the whole limit as old space plus the default young generation the
    // capped worker shows.
    expect(measured.before).toBe(measured.main);
    expect(measured.later).toBe(measured.main);
    const split = !execArgv.includes('--max-heap-size=3072');
    expect(measured.inherited).toBe(measured.main + (split ? 0 : measured.capped - 256));
    expect(measured.workerHeapMb).toBeLessThan(measured.mainHeapMb);
  },
  60000,
);

it.each([
  ['execArgv', ['--max-old-space-size-percentage=25'], undefined],
  ['NODE_OPTIONS', [], '--max-old-space-size-percentage=25'],
  [
    'execArgv, with a semi-space flag',
    ['--max-old-space-size-percentage=12.5', '--max-semi-space-size=64'],
    undefined,
  ],
  [
    'NODE_OPTIONS, with a semi-space flag',
    [],
    '--max-old-space-size-percentage=12.5 --max-semi-space-size=64',
  ],
])(
  'restores exactly the heap a percentage flag gives, from %s',
  (_label, execArgv, nodeOptions) => {
    const measured = measure(execArgv, nodeOptions);
    expect(measured.capped).toBeLessThanOrEqual(CAPPED_MAX_MB);
    // An ordinary worker gets the same total heap before and after the parser
    // lease, and so does a community-style worker: none may add a young
    // generation on top of the percentage's old space.
    expect(measured.before).toBe(measured.main);
    expect(measured.later).toBe(measured.main);
    expect(measured.inherited).toBe(measured.main);
  },
  60000,
);

describe('flags that leave the default heap in effect', () => {
  let control: Measured;
  beforeAll(() => {
    control = measure([]);
  });

  it.each([
    ['an out-of-bounds size alone', ['--max-old-space-size=100000000000000000000'], undefined],
    ['an old-space reset', ['--max-old-space-size=0'], '--max-old-space-size=800'],
    [
      'old-space and semi-space resets',
      ['--max-old-space-size=0', '--max-semi-space-size=0'],
      '--max-old-space-size=2000 --max-semi-space-size=64',
    ],
  ])(
    'matches a fresh process without flags for %s',
    (_label, execArgv, nodeOptions) => {
      const measured = measure(execArgv, nodeOptions);
      expect(measured).toEqual(control);
      expect(measured.capped).toBeLessThanOrEqual(CAPPED_MAX_MB);
    },
    60000,
  );
});

it.each([
  [
    'an --eval source naming the percentage flag',
    ['--max-old-space-size=1024'],
    '// --max-old-space-size-percentage=50\n',
  ],
  ['a process title naming a size flag', ['--title', 'worker --max-old-space-size=2000'], ''],
  ['a process title starting with a dash', ['--title=--max-old-space-size=2000'], ''],
])(
  'keeps argument boundaries: %s is not a heap flag',
  (_label, execArgv, evalComment) => {
    const measured = measure(execArgv, undefined, evalComment);
    expect(measured.before).toBe(measured.main);
    expect(measured.later).toBe(measured.main);
    expect(measured.inherited).toBe(measured.main);
  },
  60000,
);

it('leaves flags the main heap contradicts alone and charges the main heap', () => {
  // A preload rewrote NODE_OPTIONS after startup: the main heap comes from the
  // original 3000, which stays live.
  const measured = measure(['--require', rewriteNodeOptions], '--max-old-space-size=3000');
  // No lease: the flags are never rewritten to the value read, so every worker
  // gets the main heap...
  expect(measured.capped).toBe(measured.main);
  expect(measured.inherited).toBe(measured.main);
  expect(measured.later).toBe(measured.main);
  // ...and admission charges each worker that heap.
  expect(measured.workerHeapMb).toBeGreaterThanOrEqual(measured.mainHeapMb);
}, 60000);

it('caps workers under frozen flags when no heap flag is set, as nothing needs clearing', () => {
  const measured = measure(['--freeze-flags-after-init']);
  expect(measured.capped).toBeLessThanOrEqual(CAPPED_MAX_MB);
  expect(measured.workerHeapMb).toBeLessThan(measured.mainHeapMb);
}, 60000);

it.each([
  [
    '--freeze-flags-after-init',
    ['--freeze-flags-after-init', '--max-old-space-size=2048'],
    undefined,
  ],
  [
    'its single-dash spelling',
    ['-freeze_flags_after_init', '--max-old-space-size=2048'],
    undefined,
  ],
  [
    'its underscore spelling',
    ['--freeze_flags_after_init', '--max-old-space-size=2048'],
    undefined,
  ],
  ['it, with the size in NODE_OPTIONS', ['--freeze-flags-after-init'], '--max-old-space-size=2048'],
])(
  'leaves flags frozen by %s alone and charges every worker the main heap',
  (_label, execArgv, nodeOptions) => {
    // Decided before the first flag write: under frozen flags it would abort V8.
    const measured = measure(execArgv, nodeOptions);
    // No lease, so the worker inherits the main heap instead of its own cap...
    expect(measured.capped).toBe(measured.main);
    // ...and admission charges it accordingly.
    expect(measured.workerHeapMb).toBeGreaterThanOrEqual(measured.mainHeapMb);
  },
  60000,
);

it('treats a single-dash command-line size as the CLI heap pin', () => {
  // The pin is the operator's reservation, so admission must hold it in full.
  expect(cliHeapAdmission(['-max-old-space-size=3000'])).toEqual({
    mainHeapMb: expect.any(Number),
  });
}, 60000);

it('lets a command-line zero hide a NODE_OPTIONS pin from the CLI', () => {
  // Node applies the command line last, so V8's default limit is only a ceiling.
  expect(cliHeapAdmission(['--max-old-space-size=0'], '--max-old-space-size=3000')).toEqual({
    mainHeapLimitMb: expect.any(Number),
  });
}, 60000);

it('does not take a NODE_OPTIONS pin that a command-line zero overrides as manual', () => {
  // Node runs this process at V8's default heap, so analyze must size it itself.
  const runner = `
    for (const name of ['GITNEXUS_MEMORY', 'GITNEXUS_ANALYSIS_SUPERVISED', 'GITNEXUS_ANALYSIS_MANUAL_HEAP']) delete process.env[name];
    const { usesManualAnalysisHeap } = await import(${JSON.stringify(dist('cli/analyze.js'))});
    console.log(JSON.stringify(usesManualAnalysisHeap()));
  `;
  expect(runWithFlags(['--max-old-space-size=0'], '--max-old-space-size=100000', runner)).toBe(
    false,
  );
}, 60000);

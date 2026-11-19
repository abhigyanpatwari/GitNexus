/**
 * The parse worker loads the R grammar on the first R file it parses, not at module load: a run
 * with no R file never requires the native binding (and so never logs a missing one in every
 * worker). The worker is spawned directly with a preload that reports each `require` of the R
 * grammar package back to the test.
 *
 * Requires a built worker (`dist/core/ingestion/workers/parse-worker.js`, from `node scripts/build.js`
 * in `gitnexus/`; `pretest:integration` does it) that is current with `src/`: the test runs the compiled file, so a stale build
 * tests old code. Without a build the suite is skipped (so `npm test` does not fail on a fresh
 * checkout) and a warning says so.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { DIST_WORKER_URL, distWorkerExists } from '../helpers/worker-parse.js';

const R_PACKAGE = '@eagleoutice/tree-sitter-r';

let tmp: string;
let preload: string;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gnx-lazy-r-'));
  preload = path.join(tmp, 'preload.cjs');
  // `workerData.failR` makes the require of the R package throw (a missing or unloadable binding).
  // The worker logs through pino on fd 2, so fs writes to fd 2 are reported as `probe-stderr`.
  fs.writeFileSync(
    preload,
    `const { parentPort, workerData } = require('node:worker_threads');
const Module = require('node:module');
const fs = require('node:fs');
const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === ${JSON.stringify(R_PACKAGE)}) {
    parentPort.postMessage({ type: 'probe-r-load' });
    if (workerData && workerData.failR) throw new Error('simulated missing R binding');
  }
  if (request.includes('tree-sitter-c-sharp') && request.endsWith('node-types.json')) {
    parentPort.postMessage({ type: 'probe-csharp-metadata' });
  }
  return load.call(this, request, ...rest);
};
for (const name of ['write', 'writeSync']) {
  const orig = fs[name];
  fs[name] = function (fd, data, ...rest) {
    if (fd === 2) parentPort.postMessage({ type: 'probe-stderr', text: String(data) });
    return orig.call(this, fd, data, ...rest);
  };
}
`,
  );
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

interface WorkerRun {
  seen: string[];
  /** Number of `require` calls of the R grammar package. */
  rLoads: number;
  /** Everything the worker wrote to stderr. */
  stderr: string;
}

/** Parse `batches` (one sub-batch message each) in one fresh worker (optionally with the R binding made unloadable). */
function parseInFreshWorker(
  batches: { path: string; content: string }[][],
  opts: { failR?: boolean } = {},
): Promise<WorkerRun> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(fileURLToPath(DIST_WORKER_URL), {
      execArgv: ['--require', preload],
      workerData: { failR: opts.failR === true },
    });
    let next = 0;
    const run: WorkerRun = { seen: [], rLoads: 0, stderr: '' };
    worker.on('error', reject);
    worker.on('message', (msg: { type: string; text?: string }) => {
      run.seen.push(msg.type);
      if (msg.type === 'probe-r-load') run.rLoads++;
      if (msg.type === 'probe-stderr') run.stderr += msg.text ?? '';
      if (msg.type === 'ready' || msg.type === 'sub-batch-done') {
        const files = batches[next++];
        if (files) worker.postMessage({ type: 'sub-batch', files });
        else worker.postMessage({ type: 'flush' });
      } else if (msg.type === 'result' || msg.type === 'error') {
        // pino writes asynchronously; give buffered stderr a moment before collecting.
        setTimeout(() => void worker.terminate().then(() => resolve(run)), 300);
      }
    });
  });
}

const distPresent = distWorkerExists();
if (!distPresent) {
  console.warn(
    'parse-worker-lazy-r-grammar: SKIPPED, no built parse worker. Run `node scripts/build.js` in gitnexus/.',
  );
}

describe.skipIf(!distPresent)('parse-worker lazy R grammar', () => {
  it('does not load the R grammar when no R file is parsed', async () => {
    const { seen } = await parseInFreshWorker([
      [{ path: 'a.py', content: 'def f():\n    pass\n' }],
    ]);
    expect(seen).toContain('result');
    expect(seen).not.toContain('probe-r-load');
  });

  it('defers the C# binding until a C# file is dispatched', async () => {
    const python = [{ path: 'a.py', content: 'def f(): pass' }];
    const csharp = [{ path: 'C.cs', content: 'class C { void M() {} }' }];
    const { seen } = await parseInFreshWorker([python, csharp]);
    expect(seen).toContain('result');
    expect(seen).toContain('sub-batch-done');
    expect(seen.indexOf('probe-csharp-metadata')).toBeGreaterThan(seen.indexOf('sub-batch-done'));
  });

  it('loads the R grammar on the first R file', async () => {
    const { seen } = await parseInFreshWorker([[{ path: 'a.R', content: 'f <- function() 1\n' }]]);
    expect(seen).toContain('result');
    expect(seen).toContain('probe-r-load');
  });

  it('loads the R grammar exactly once and reuses it across several sub-batches of R files', async () => {
    // Availability is resolved once per language per sub-batch, so reuse is only observable
    // across sub-batches of the same worker.
    const batch = (n: number) => [
      { path: `f${n}.R`, content: `f${n} <- function() ${n}\n` },
      { path: `g${n}.R`, content: `g${n} <- function() ${n}\n` },
    ];
    const { seen, rLoads } = await parseInFreshWorker([batch(1), batch(2), batch(3)]);
    expect(seen).toContain('result');
    expect(rLoads).toBe(1);
  });

  it('logs no missing-binding error when only non-R files are parsed and the binding is absent', async () => {
    const { seen, rLoads, stderr } = await parseInFreshWorker(
      [[{ path: 'a.py', content: 'def f():\n    pass\n' }]],
      { failR: true },
    );
    expect(seen).toContain('result');
    expect(rLoads).toBe(0);
    expect(stderr).not.toContain('simulated missing R binding');
  });

  it('logs the missing R binding once, caches the failure and skips R files without crashing', async () => {
    const { seen, rLoads, stderr } = await parseInFreshWorker(
      [
        [
          { path: 'a.R', content: 'f <- function() 1\n' },
          { path: 'c.py', content: 'def h():\n    pass\n' },
        ],
        [{ path: 'b.R', content: 'g <- function() 2\n' }],
        [{ path: 'd.R', content: 'k <- function() 3\n' }],
      ],
      { failR: true },
    );
    expect(seen).toContain('result');
    expect(seen).not.toContain('error');
    expect(rLoads).toBe(1);
    expect(stderr.split('simulated missing R binding').length - 1).toBe(1);
  });
});

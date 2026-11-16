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
  fs.writeFileSync(
    preload,
    `const { parentPort } = require('node:worker_threads');
const Module = require('node:module');
const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === ${JSON.stringify(R_PACKAGE)}) parentPort.postMessage({ type: 'probe-r-load' });
  return load.call(this, request, ...rest);
};
`,
  );
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Parse `files` in one fresh worker; resolves with the message types it posted. */
function parseInFreshWorker(files: { path: string; content: string }[]): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(fileURLToPath(DIST_WORKER_URL), { execArgv: ['--require', preload] });
    const seen: string[] = [];
    worker.on('error', reject);
    worker.on('message', (msg: { type: string; error?: string }) => {
      seen.push(msg.type);
      if (msg.type === 'ready') {
        worker.postMessage({ type: 'sub-batch', files });
      } else if (msg.type === 'sub-batch-done') {
        worker.postMessage({ type: 'flush' });
      } else if (msg.type === 'result' || msg.type === 'error') {
        void worker.terminate().then(() => resolve(seen));
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
    const seen = await parseInFreshWorker([{ path: 'a.py', content: 'def f():\n    pass\n' }]);
    expect(seen).toContain('result');
    expect(seen).not.toContain('probe-r-load');
  });

  it('loads the R grammar on the first R file', async () => {
    const seen = await parseInFreshWorker([{ path: 'a.R', content: 'f <- function() 1\n' }]);
    expect(seen).toContain('result');
    expect(seen).toContain('probe-r-load');
  });
});

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { afterEach, expect, it, vi } from 'vitest';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { runChunkedParseAndResolve } from '../../src/core/ingestion/pipeline-phases/parse-impl.js';

let directory: string;
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (directory) await fs.rm(directory, { recursive: true, force: true });
});

it.each(['abort', 'drain-failure'] as const)(
  'waits for the active round before teardown on %s',
  async (failure) => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-round-drain-'));
    vi.stubEnv('GITNEXUS_PARSE_ROUND_BYTES', '1');
    const worker = path.join(directory, 'controlled-worker.cjs');
    const realWorker = pathToFileURL(
      path.resolve('dist/core/ingestion/workers/parse-worker.js'),
    ).href;
    // Hold each sub-batch before the real parser runs. The release marker is a
    // controlled safe point; terminating while held must fail this test.
    await fs.writeFile(
      worker,
      `
    const { parentPort } = require('node:worker_threads');
    const fs = require('node:fs');
    const path = require('node:path');
    const on = parentPort.on.bind(parentPort);
    let round = 0;
    parentPort.on = (event, handler) => on(event, event !== 'message' ? handler : msg => {
      if (msg.type !== 'sub-batch') return handler(msg);
      const id = ++round;
      fs.writeFileSync(path.join(__dirname, 'started-' + id), '');
      const timer = setInterval(() => {
        if (!fs.existsSync(path.join(__dirname, 'release-' + id))) return;
        clearInterval(timer);
        handler(msg);
      }, 5);
    });
    import(${JSON.stringify(realWorker)});
  `,
    );
    const files = ['a.ts', 'b.ts'];
    await Promise.all(
      files.map((file) =>
        fs.writeFile(path.join(directory, file), `export function ${file[0]}() { return 1; }`),
      ),
    );
    const graph = createKnowledgeGraph();
    const abort = new AbortController();
    const error = new Error(failure);
    let drainFailed = false;
    if (failure === 'drain-failure') {
      await fs.writeFile(path.join(directory, 'release-1'), '');
      vi.spyOn(graph, 'addNode').mockImplementation(() => {
        drainFailed = true;
        throw error;
      });
    }
    const terminate = vi.spyOn(Worker.prototype, 'terminate');
    let settled = false;
    const result = runChunkedParseAndResolve(
      graph,
      files.map((file) => ({ path: file, size: 40 })),
      files,
      2,
      directory,
      Date.now(),
      () => {},
      {
        chunkByteBudget: 1,
        workerPoolSize: 1,
        workerUrlForTest: pathToFileURL(worker),
        signal: abort.signal,
      },
    ).then(
      () => {
        settled = true;
        return undefined;
      },
      (reason) => {
        settled = true;
        return reason;
      },
    );
    const heldRound = failure === 'abort' ? 1 : 2;
    try {
      await vi.waitFor(
        async () => {
          await fs.stat(path.join(directory, `started-${heldRound}`));
        },
        { timeout: 15000 },
      );
      if (failure === 'abort') abort.abort(error);
      else expect(drainFailed).toBe(true);
      // Give cancellation and an incorrect early-finally path a turn to run.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(settled).toBe(false);
      expect(terminate).not.toHaveBeenCalled();
    } finally {
      // Release both possible rounds even if startup/assertion failed, so a
      // failing test cannot strand a worker behind one of its own markers.
      abort.abort(new Error('test cleanup'));
      await Promise.all(
        [1, 2].map((round) => fs.writeFile(path.join(directory, `release-${round}`), '')),
      );
      expect(await result).toBe(error);
    }
    expect(terminate).toHaveBeenCalled();
  },
  20000,
);

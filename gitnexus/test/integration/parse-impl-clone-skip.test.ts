/**
 * #2112 — Integration regression test for the worker result clone-safety net.
 *
 * Reproduces the deterministic large-repo killer: a parse worker whose
 * accumulated result carries a value the structured-clone algorithm can't
 * serialize (the reporter's case was a node `properties` value pointing at a
 * native `toString`). Before the fix, `parentPort.postMessage({type:'result',
 * data})` threw a `DataCloneError` SENDER-side; the worker re-posted it as
 * `{type:'error'}`, the pool counted it as a worker death, and under
 * `GITNEXUS_WORKER_POOL_SIZE=1` the same graph re-threw on every respawn until
 * the slot's budget was exhausted and the whole parse phase aborted.
 *
 * Runs with REAL `worker_threads` + `createWorkerPool` over the production
 * pool / merge / graph wiring, under `workerPoolSize: 1` (matching the
 * conservative workaround that still failed in the issue). The custom worker
 * is an ESM module that statically imports the REAL built `clone-safety`
 * helper from `dist/` and applies the exact production `postResultCloneSafe`
 * pattern — so this exercises the actual helper across a real `postMessage`
 * boundary (the fake-worker doubles used by the unit suite bypass structured
 * clone entirely and can't reproduce the failure).
 *
 * Build prerequisite: the worker imports `dist/.../clone-safety.js`, so
 * `node scripts/build.js` must run first (the `pretest:integration` step does
 * this; a stale `dist/` would test old behavior).
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { runChunkedParseAndResolve } from '../../src/core/ingestion/pipeline-phases/parse-impl.js';

// file:// URL of the BUILT clone-safety helper, imported by the ESM test worker.
const CLONE_SAFETY_URL = new URL(
  '../../dist/core/ingestion/workers/clone-safety.js',
  import.meta.url,
).href;

const ACCUMULATED_INIT = `{
  nodes: [], relationships: [], symbols: [], calls: [], assignments: [],
  routes: [], fetchCalls: [], fetchWrapperDefs: [], decoratorRoutes: [],
  routerIncludes: [], routerImports: [], toolDefs: [], ormQueries: [],
  constructorBindings: [], fileScopeBindings: [], parsedFiles: [],
  skippedLanguages: {}, fileCount: 0,
}`;

/**
 * Synthesizes a Function node per file. For `poison.ts` it leaks an own native
 * `toString` into the node's `properties` — the exact #2112 shape that throws
 * `DataCloneError` across the real worker boundary.
 */
const SUB_BATCH_HANDLER = `
  if (msg && msg.type === 'sub-batch') {
    for (const file of msg.files) {
      const baseName = file.path.split('/').pop().replace(/\\.ts$/, '');
      const properties = {
        name: baseName, filePath: file.path, startLine: 1, endLine: 1,
        language: 'typescript', isExported: true,
      };
      if (file.path.endsWith('poison.ts')) {
        properties.toString = Object.prototype.toString; // native fn → non-cloneable
      }
      accumulated.nodes.push({ id: 'func:' + file.path, label: 'Function', properties });
      accumulated.fileCount++;
    }
    parentPort.postMessage({ type: 'progress', filesProcessed: accumulated.fileCount });
    parentPort.postMessage({ type: 'sub-batch-done' });
    return;
  }`;

/** GREEN worker: applies the real production clone-safety net before delivery. */
const CLONE_SAFE_WORKER = `
import { parentPort } from 'node:worker_threads';
import { isDataCloneError, makeWorkerResultCloneSafe } from '${CLONE_SAFETY_URL}';
const accumulated = ${ACCUMULATED_INIT};
parentPort.postMessage({ type: 'ready' });
parentPort.on('message', (msg) => {
${SUB_BATCH_HANDLER}
  if (msg && msg.type === 'flush') {
    try {
      parentPort.postMessage({ type: 'result', data: accumulated });
      return;
    } catch (err) {
      if (!isDataCloneError(err)) throw err;
    }
    const { skipped } = makeWorkerResultCloneSafe(accumulated, {
      dropWholeElement: new Set(['parsedFiles']),
      skipFields: new Set(['skippedPaths']),
    });
    accumulated.skippedPaths = skipped;
    parentPort.postMessage({ type: 'result', data: accumulated });
  }
});
`;

/** RED control: posts the non-cloneable result raw (no clone-safety net). */
const RAW_WORKER = `
import { parentPort } from 'node:worker_threads';
const accumulated = ${ACCUMULATED_INIT};
parentPort.postMessage({ type: 'ready' });
parentPort.on('message', (msg) => {
${SUB_BATCH_HANDLER}
  if (msg && msg.type === 'flush') {
    parentPort.postMessage({ type: 'result', data: accumulated });
  }
});
`;

const FIXTURE_FILES = {
  'src/good_a.ts': 'export function good_a() { return 1; }\n',
  'src/poison.ts': 'export function poison() { return 2; }\n',
  'src/good_c.ts': 'export function good_c() { return 3; }\n',
};

const nodeNames = (graph: ReturnType<typeof createKnowledgeGraph>): Set<string> => {
  const names = new Set<string>();
  for (const n of graph.nodes.values()) {
    if (n.label === 'Function') {
      const name = (n.properties as { name?: string }).name;
      if (name) names.add(name);
    }
  }
  return names;
};

describe('#2112: worker result clone-safety integration (POOL_SIZE=1)', () => {
  let tempDir: string;
  let repoDir: string;

  const writeWorker = (script: string): URL => {
    const p = path.join(tempDir, `clone-skip-worker-${Math.abs(hash(script))}.mjs`);
    writeFileSync(p, script);
    return pathToFileURL(p) as URL;
  };
  // Stable name without Math.random (banned in this harness elsewhere) — index by content.
  const hash = (s: string): number => {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return h;
  };

  const runWith = async (workerUrl: URL): Promise<ReturnType<typeof createKnowledgeGraph>> => {
    const filePaths = Object.keys(FIXTURE_FILES);
    const scanned = filePaths.map((rel) => ({
      path: rel,
      size: statSync(path.join(repoDir, rel)).size,
    }));
    const graph = createKnowledgeGraph();
    await runChunkedParseAndResolve(
      graph,
      scanned,
      filePaths,
      filePaths.length,
      repoDir,
      1, // deterministic start time (Date.now is banned in this harness)
      () => {},
      {
        skipWorkers: false,
        workerUrlForTest: workerUrl,
        workerPoolSize: 1, // poison lands on the only slot — the issue's workaround config
      },
    );
    return graph;
  };

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'parse-impl-clone-skip-'));
    repoDir = path.join(tempDir, 'repo');
    mkdirSync(repoDir, { recursive: true });
    for (const [rel, content] of Object.entries(FIXTURE_FILES)) {
      const full = path.join(repoDir, rel);
      mkdirSync(path.dirname(full), { recursive: true });
      writeFileSync(full, content);
    }
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('GREEN: a non-cloneable result is sanitized and delivered; the run completes with all files', async () => {
    const graph = await runWith(writeWorker(CLONE_SAFE_WORKER));
    const names = nodeNames(graph);
    // Survivors AND the sanitized poison file are all present — the run did not abort.
    expect(names.has('good_a')).toBe(true);
    expect(names.has('good_c')).toBe(true);
    // The poison node is delivered with its legitimate data intact (only the
    // leaked native `toString` was stripped), so it still lands in the graph.
    expect(names.has('poison')).toBe(true);
  });

  it('RED control: without clone-safety, the same poison result aborts the parse phase', async () => {
    // Pre-fix behavior: the raw non-cloneable result throws DataCloneError in
    // the worker; under POOL_SIZE=1 the pool exhausts the slot's respawn
    // budget and rejects. (This is the contract the GREEN worker repairs.)
    await expect(runWith(writeWorker(RAW_WORKER))).rejects.toThrow();
  });
});

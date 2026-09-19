/**
 * Regression coverage for native-worker startup on warm parse-cache runs.
 *
 * A cache-hit chunk must replay cached worker output without spawning the
 * parse-worker. Spawning workers on a warm cache hit still loads tree-sitter
 * native bindings at top level, which was the root trigger for intermittent
 * `libc++abi ... Napi::Error` crashes in linked local builds.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { runChunkedParseAndResolve } from '../../src/core/ingestion/pipeline-phases/parse-impl.js';
import { computeChunkHash, fileContentHash } from '../../src/storage/parse-cache.js';
import type { ParseWorkerResult } from '../../src/core/ingestion/workers/parse-worker.js';

const emptyWorkerResult = (filePath: string, name: string): ParseWorkerResult => ({
  nodes: [
    {
      id: `Function:${filePath}:${name}`,
      label: 'Function',
      properties: {
        name,
        filePath,
        startLine: 1,
        endLine: 1,
        language: 'typescript',
      },
    },
  ],
  relationships: [],
  symbols: [],
  imports: [],
  calls: [],
  assignments: [],
  heritage: [],
  routes: [],
  fetchCalls: [],
  fetchWrapperDefs: [],
  decoratorRoutes: [],
  routerIncludes: [],
  routerImports: [],
  toolDefs: [],
  ormQueries: [],
  constructorBindings: [],
  fileScopeBindings: [],
  parsedFiles: [],
  skippedLanguages: {},
  fileCount: 1,
});

const writeReadyWorker = (workerPath: string, markerPath: string): void => {
  fs.writeFileSync(
    workerPath,
    `
const fs = require('node:fs');
const { parentPort } = require('node:worker_threads');
fs.writeFileSync(${JSON.stringify(markerPath)}, 'spawned');
parentPort.postMessage({ type: 'ready' });
parentPort.on('message', () => {});
`,
  );
};

const writeResultWorker = (workerPath: string, markerPath: string): void => {
  fs.writeFileSync(
    workerPath,
    `
const fs = require('node:fs');
const { parentPort } = require('node:worker_threads');
const decoder = new TextDecoder('utf-8');
fs.writeFileSync(${JSON.stringify(markerPath)}, 'spawned');
parentPort.postMessage({ type: 'ready' });
const accumulated = {
  nodes: [], relationships: [], symbols: [], imports: [], calls: [], assignments: [], heritage: [],
  routes: [], fetchCalls: [], fetchWrapperDefs: [], decoratorRoutes: [], routerIncludes: [], routerImports: [], toolDefs: [], ormQueries: [], constructorBindings: [],
  fileScopeBindings: [], parsedFiles: [], skippedLanguages: {}, fileCount: 0,
};
parentPort.on('message', (msg) => {
  if (msg && msg.type === 'sub-batch') {
    for (const file of msg.files) {
      const filePath = file.path;
      const name = filePath.split('/').pop().replace(/\\.ts$/, '');
      accumulated.nodes.push({
        id: 'Function:' + filePath + ':' + name,
        label: 'Function',
        properties: { name, filePath, startLine: 1, endLine: 1, language: 'typescript' },
      });
      accumulated.fileCount++;
      // Decode to exercise the same transfer-list shape as production.
      if (file.content && typeof file.content !== 'string') decoder.decode(file.content);
    }
    parentPort.postMessage({ type: 'progress', filesProcessed: accumulated.fileCount });
    parentPort.postMessage({ type: 'sub-batch-done' });
    return;
  }
  if (msg && msg.type === 'flush') parentPort.postMessage({ type: 'result', data: accumulated });
});
`,
  );
};

/**
 * Like `writeResultWorker`, but each spawned instance writes its OWN marker
 * keyed by `threadId`. The shared single-marker workers above can only prove
 * "at least one worker started"; counting files in `markerDir` gives the actual
 * pool size the parse phase asked `createWorkerPool` for, which is the only
 * thing that distinguishes a clamped pool from an honored override.
 */
const writeSpawnCountingWorker = (workerPath: string, markerDir: string): void => {
  fs.writeFileSync(
    workerPath,
    `
const fs = require('node:fs');
const path = require('node:path');
const { parentPort, threadId } = require('node:worker_threads');
fs.mkdirSync(${JSON.stringify(markerDir)}, { recursive: true });
fs.writeFileSync(path.join(${JSON.stringify(markerDir)}, 'worker-' + threadId), 'spawned');
parentPort.postMessage({ type: 'ready' });
const accumulated = {
  nodes: [], relationships: [], symbols: [], imports: [], calls: [], assignments: [], heritage: [],
  routes: [], fetchCalls: [], fetchWrapperDefs: [], decoratorRoutes: [], routerIncludes: [], routerImports: [], toolDefs: [], ormQueries: [], constructorBindings: [],
  fileScopeBindings: [], parsedFiles: [], skippedLanguages: {}, fileCount: 0,
};
parentPort.on('message', (msg) => {
  if (msg && msg.type === 'sub-batch') {
    for (const file of msg.files) {
      const filePath = file.path;
      const name = filePath.split('/').pop().replace(/\.ts$/, '');
      accumulated.nodes.push({
        id: 'Function:' + filePath + ':' + name,
        label: 'Function',
        properties: { name, filePath, startLine: 1, endLine: 1, language: 'typescript' },
      });
      accumulated.fileCount++;
    }
    parentPort.postMessage({ type: 'progress', filesProcessed: accumulated.fileCount });
    parentPort.postMessage({ type: 'sub-batch-done' });
    return;
  }
  if (msg && msg.type === 'flush') parentPort.postMessage({ type: 'result', data: accumulated });
});
`,
  );
};

const writeExitBeforeReadyWorker = (workerPath: string): void => {
  fs.writeFileSync(workerPath, `process.exit(1);\n`);
};

describe('parse-impl worker pool lazy startup', () => {
  let tempDir = '';
  let repoDir = '';

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parse-impl-worker-lazy-cache-'));
    repoDir = path.join(tempDir, 'repo');
    fs.mkdirSync(repoDir, { recursive: true });
  });

  afterEach(() => {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('does not spawn a parse worker when every chunk is served from parse cache', async () => {
    const rel = 'src/cached.ts';
    const content = 'export function cached() { return 1; }\n';
    const full = path.join(repoDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);

    const chunkHash = computeChunkHash([{ filePath: rel, contentHash: fileContentHash(content) }]);
    const parseCache = {
      version: 'test',
      entries: new Map<string, ParseWorkerResult[]>([
        [chunkHash, [emptyWorkerResult(rel, 'cached')]],
      ]),
      usedKeys: new Set<string>(),
    };

    const markerPath = path.join(tempDir, 'worker-spawned.marker');
    const workerPath = path.join(tempDir, 'ready-worker.js');
    writeReadyWorker(workerPath, markerPath);

    const graph = createKnowledgeGraph();
    await runChunkedParseAndResolve(
      graph,
      [{ path: rel, size: fs.statSync(full).size }],
      [rel],
      1,
      repoDir,
      Date.now(),
      () => {},
      {
        workerUrlForTest: pathToFileURL(workerPath),
        workerPoolSize: 1,
        parseCache,
      },
    );

    expect(fs.existsSync(markerPath)).toBe(false);
    expect(parseCache.usedKeys.has(chunkHash)).toBe(true);
    expect(Array.from(graph.nodes.values()).some((n) => n.properties.name === 'cached')).toBe(true);
  });

  it('spawns the parse worker lazily on the first cache miss and stores raw results', async () => {
    const rel = 'src/miss.ts';
    const content = 'export function miss() { return 1; }\n';
    const full = path.join(repoDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);

    const markerPath = path.join(tempDir, 'worker-spawned.marker');
    const workerPath = path.join(tempDir, 'result-worker.js');
    writeResultWorker(workerPath, markerPath);

    const parseCache = {
      version: 'test',
      entries: new Map<string, ParseWorkerResult[]>(),
      usedKeys: new Set<string>(),
    };
    const chunkHash = computeChunkHash([{ filePath: rel, contentHash: fileContentHash(content) }]);

    const graph = createKnowledgeGraph();
    await runChunkedParseAndResolve(
      graph,
      [{ path: rel, size: fs.statSync(full).size }],
      [rel],
      1,
      repoDir,
      Date.now(),
      () => {},
      {
        workerUrlForTest: pathToFileURL(workerPath),
        workerPoolSize: 1,
        parseCache,
      },
    );

    expect(fs.existsSync(markerPath)).toBe(true);
    expect(parseCache.entries.has(chunkHash)).toBe(true);
    expect(Array.from(graph.nodes.values()).some((n) => n.properties.name === 'miss')).toBe(true);
  });

  it('fails fast (no silent fallback) when the pool cannot start its workers (#1741)', async () => {
    const rel = 'src/fatal.ts';
    const content = 'export function fatal() { return 1; }\n';
    const full = path.join(repoDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);

    const workerPath = path.join(tempDir, 'exit-before-ready-fatal-worker.js');
    writeExitBeforeReadyWorker(workerPath);

    const parseCache = {
      version: 'test',
      entries: new Map<string, ParseWorkerResult[]>(),
      usedKeys: new Set<string>(),
    };

    const graph = createKnowledgeGraph();
    await expect(
      runChunkedParseAndResolve(
        graph,
        [{ path: rel, size: fs.statSync(full).size }],
        [rel],
        1,
        repoDir,
        Date.now(),
        () => {},
        {
          workerUrlForTest: pathToFileURL(workerPath),
          workerPoolSize: 1,
          // No flag: a total worker-startup failure always fails fast now.
          parseCache,
        },
      ),
    ).rejects.toThrow(/Worker pool failed to start/i);

    // The fatal path did not silently parse sequentially behind the user's back.
    expect(Array.from(graph.nodes.values()).some((n) => n.properties.name === 'fatal')).toBe(false);
  });

  it('honors GITNEXUS_WORKER_POOL_SIZE above the work-proportional cap', async () => {
    // The auto pool size is bounded by source bytes so a tiny repo does not
    // spawn a full idle pool. That bound must apply to the AUTO default only —
    // it used to clamp the operator's env override too, so an operator asking
    // for more workers silently got the byte-derived number while `--workers`
    // was honored.
    //
    // This asserts the pool the PARSE PHASE actually builds, not the resolver in
    // isolation: `resolveAutoPoolSize()` already honored the env var before the
    // fix, so a test at that level stays green through a revert.
    const saved = process.env.GITNEXUS_WORKER_POOL_SIZE;
    process.env.GITNEXUS_WORKER_POOL_SIZE = '3';
    try {
      // Four tiny files: total bytes are far under one CHUNK_BYTES_PER_WORKER so
      // the work-proportional cap is 1, while the parseable count stays above the
      // requested 3 (the pool never exceeds the number of files to parse).
      const rels = ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'];
      const scanned = rels.map((rel) => {
        const full = path.join(repoDir, rel);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, `export function ${path.basename(rel, '.ts')}() { return 1; }\n`);
        return { path: rel, size: fs.statSync(full).size };
      });

      const markerDir = path.join(tempDir, 'pool-size-markers');
      const workerPath = path.join(tempDir, 'pool-size-worker.js');
      writeSpawnCountingWorker(workerPath, markerDir);

      const result = await runChunkedParseAndResolve(
        createKnowledgeGraph(),
        scanned,
        rels,
        rels.length,
        repoDir,
        Date.now(),
        () => {},
        // No `workerPoolSize`: the env var is the only override in play.
        { workerUrlForTest: pathToFileURL(workerPath) },
      );

      expect(result.usedWorkerPool).toBe(true);
      // 3, not the byte-derived 1. Exactly this assertion fails on the clamped
      // parent commit, which is what makes it a regression test for the fix.
      expect(fs.readdirSync(markerDir)).toHaveLength(3);
    } finally {
      if (saved === undefined) delete process.env.GITNEXUS_WORKER_POOL_SIZE;
      else process.env.GITNEXUS_WORKER_POOL_SIZE = saved;
    }
  });

  it('throws when GITNEXUS_WORKER_POOL_SIZE=0 and no --workers flag (sequential parsing removed)', async () => {
    const saved = process.env.GITNEXUS_WORKER_POOL_SIZE;
    process.env.GITNEXUS_WORKER_POOL_SIZE = '0';
    try {
      const rel = 'src/env0.ts';
      const content = 'export function env0() { return 1; }\n';
      const full = path.join(repoDir, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);

      // A ready-worker double with a spawn marker — it must NOT be spawned,
      // because the disabled-channel validation throws before any pool is built.
      const markerPath = path.join(tempDir, 'env0-worker.marker');
      const workerPath = path.join(tempDir, 'env0-ready-worker.js');
      writeReadyWorker(workerPath, markerPath);

      const graph = createKnowledgeGraph();
      await expect(
        runChunkedParseAndResolve(
          graph,
          [{ path: rel, size: fs.statSync(full).size }],
          [rel],
          1,
          repoDir,
          Date.now(),
          () => {},
          {
            workerUrlForTest: pathToFileURL(workerPath),
            // No workerPoolSize option — the ambient env=0 is the only signal.
          },
        ),
      ).rejects.toThrow(/GITNEXUS_WORKER_POOL_SIZE=0/);

      // Sequential parsing was removed: env=0 is a hard error, not a silent
      // sequential run. The validation throws before any pool is constructed.
      expect(fs.existsSync(markerPath)).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.GITNEXUS_WORKER_POOL_SIZE;
      else process.env.GITNEXUS_WORKER_POOL_SIZE = saved;
    }
  });

  it('an explicit --workers wins over an ambient GITNEXUS_WORKER_POOL_SIZE=0 (#1741)', async () => {
    const saved = process.env.GITNEXUS_WORKER_POOL_SIZE;
    process.env.GITNEXUS_WORKER_POOL_SIZE = '0';
    try {
      const rel = 'src/precedence.ts';
      const content = 'export function precedence() { return 1; }\n';
      const full = path.join(repoDir, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);

      const markerPath = path.join(tempDir, 'precedence-worker.marker');
      const workerPath = path.join(tempDir, 'precedence-result-worker.js');
      writeResultWorker(workerPath, markerPath);

      const graph = createKnowledgeGraph();
      const result = await runChunkedParseAndResolve(
        graph,
        [{ path: rel, size: fs.statSync(full).size }],
        [rel],
        1,
        repoDir,
        Date.now(),
        () => {},
        {
          workerUrlForTest: pathToFileURL(workerPath),
          workerPoolSize: 1, // explicit --workers 1 must win over ambient env=0
        },
      );

      expect(result.usedWorkerPool).toBe(true); // explicit flag wins; env=0 ignored
      expect(fs.existsSync(markerPath)).toBe(true); // worker was spawned
    } finally {
      if (saved === undefined) delete process.env.GITNEXUS_WORKER_POOL_SIZE;
      else process.env.GITNEXUS_WORKER_POOL_SIZE = saved;
    }
  });
});

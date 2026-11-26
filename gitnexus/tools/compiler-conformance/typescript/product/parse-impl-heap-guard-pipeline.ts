/**
 * #2649 review — pipeline-level coverage for the parse-phase heap guardrails.
 *
 * The pure predicates are covered in parse-impl-heap-guard.test.ts; these
 * tests pin the WIRING inside runChunkedParseAndResolve: the mid-loop abort
 * actually rejects the parse with the remedy message (nothing en route may
 * swallow or remap it — the #2441 exit-0 bug class), and the preflight
 * projection is computed from PARSEABLE files, not total scanned files (the
 * miscalibration fixed on this branch).
 */
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { expect } from 'expect';
import v8 from 'node:v8';
import { createTestEnvironment } from '../support/environment.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { createKnowledgeGraph } from '../../../../src/core/graph/graph.js';
import {
  projectParseHeapNeedBytes,
  runChunkedParseAndResolve,
} from '../../../../src/core/ingestion/pipeline-phases/parse-impl.js';
import { _captureLogger } from '../../../../src/core/logger.js';

const MB = 1024 * 1024;

let repoDir: string;
let workerStubPath: string;
const environment = createTestEnvironment();
const realHeapStatistics = v8.getHeapStatistics.bind(v8);
let limit: number;

beforeEach(() => {
  environment.set('GITNEXUS_MEMORY', undefined);
  mock.method(v8, 'getHeapStatistics', () => ({ ...realHeapStatistics(), heap_size_limit: limit }));
  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-heap-guard-pipeline-'));
  fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
  // The pool validates the worker script's existence up front; the abort test
  // never dispatches, and the preflight test parses one real file.
  workerStubPath = path.join(repoDir, 'fake-worker.js');
  fs.writeFileSync(workerStubPath, '// worker stub for createWorkerPool');
});

afterEach(() => {
  mock.restoreAll();
  environment.restore();
  fs.rmSync(repoDir, { recursive: true, force: true });
});

const writeFixture = (rel: string, content: string): { path: string; size: number } => {
  const full = path.join(repoDir, rel);
  fs.writeFileSync(full, content);
  return { path: rel, size: fs.statSync(full).size };
};

describe('#2649 heap guardrails wired into runChunkedParseAndResolve', () => {
  it('mid-loop guard rejects the parse with the actionable remedy message', async () => {
    const file = writeFixture('src/a.ts', 'export function a() { return 1; }\n');
    // 1GB limit with 95% "in use": above the 92% abort threshold.
    limit = 1024 * MB;
    mock.method(process, 'memoryUsage', () => ({
      rss: 0,
      heapTotal: 1024 * MB,
      heapUsed: 973 * MB,
      external: 0,
      arrayBuffers: 0,
    }));

    const graph = createKnowledgeGraph();
    await expect(
      runChunkedParseAndResolve(graph, [file], [file.path], 1, repoDir, Date.now(), () => {}, {
        workerUrlForTest: pathToFileURL(workerStubPath),
        workerPoolSize: 1,
      }),
    ).rejects.toThrow(/Analyze stopped before running out of memory/);
  });

  it('preflight warn projects from PARSEABLE files only and names the parseable count', async () => {
    // Mock the heap limit relative to what ONE parseable file actually projects,
    // so this stays a test of the WARN BEHAVIOUR rather than of the projection
    // constant. Hard-coding 150_000 tied it to PROJECTED_HEAP_BYTES_PER_NODE =
    // 2250; recalibrating that constant for streamed emit (#2680) dropped the
    // projection to 0.80 of the limit and the warn silently stopped firing.
    // Deriving the limit keeps the ratio at 0.90 — above the 0.85 threshold —
    // whatever the constant becomes.
    environment.set('GITNEXUS_MEMORY', 'off');
    limit = Math.floor(projectParseHeapNeedBytes(1) / 0.9);

    const parseable = writeFixture('src/b.ts', 'export function b() { return 2; }\n');
    const unparseable = writeFixture('src/data.zzz9', 'not source code\n');

    const cap = _captureLogger();
    const graph = createKnowledgeGraph();
    try {
      await runChunkedParseAndResolve(
        graph,
        [parseable, unparseable],
        [parseable.path, unparseable.path],
        2,
        repoDir,
        Date.now(),
        () => {},
        {
          workerUrlForTest: new URL(
            '../../../../dist/core/ingestion/workers/parse-worker.js',
            import.meta.url,
          ),
          workerPoolSize: 1,
        },
      );
    } finally {
      cap.restore();
    }

    const warn = cap.records().find((r) => r.msg.includes('Large repository'));
    // "analyzing 1 files" — the parseable count, not the 2 scanned files.
    expect({
      fired: warn !== undefined,
      parseableBasis: warn?.msg.includes('analyzing 1 files') ?? false,
    }).toEqual({ fired: true, parseableBasis: true });
  });
});

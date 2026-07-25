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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const getHeapStatisticsMock = vi.hoisted(() => vi.fn());
vi.mock('node:v8', async () => {
  const actual = await vi.importActual<typeof import('node:v8')>('node:v8');
  const mocked = { ...actual, getHeapStatistics: getHeapStatisticsMock };
  return { ...mocked, default: mocked };
});

import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { runChunkedParseAndResolve } from '../../src/core/ingestion/pipeline-phases/parse-impl.js';
import { _captureLogger } from '../../src/core/logger.js';

const MB = 1024 * 1024;

let repoDir: string;
let workerStubPath: string;
let memoryUsageSpy: ReturnType<typeof vi.spyOn> | undefined;

beforeEach(() => {
  delete process.env.GITNEXUS_MEMORY;
  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-heap-guard-pipeline-'));
  fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
  // The pool validates the worker script's existence up front; the abort test
  // never dispatches, and the preflight test parses one real file.
  workerStubPath = path.join(repoDir, 'fake-worker.js');
  fs.writeFileSync(workerStubPath, '// worker stub for createWorkerPool');
});

afterEach(() => {
  memoryUsageSpy?.mockRestore();
  memoryUsageSpy = undefined;
  delete process.env.GITNEXUS_MEMORY;
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
    getHeapStatisticsMock.mockReturnValue({ heap_size_limit: 1024 * MB });
    memoryUsageSpy = vi.spyOn(process, 'memoryUsage').mockReturnValue({
      rss: 0,
      heapTotal: 1024 * MB,
      heapUsed: 973 * MB,
      external: 0,
      arrayBuffers: 0,
    });

    const graph = createKnowledgeGraph();
    await expect(
      runChunkedParseAndResolve(graph, [file], [file.path], 1, repoDir, Date.now(), () => {}, {
        workerUrlForTest: pathToFileURL(workerStubPath),
        workerPoolSize: 1,
      }),
    ).rejects.toThrow(/Analyze stopped before running out of memory/);
  });

  it('preflight warn projects from PARSEABLE files only and names the parseable count', async () => {
    // Tiny mocked heap limit so ONE parseable file (~169KB projected) crosses
    // the 85% preflight threshold; the guard abort is disabled so the parse
    // itself proceeds on the real (unmocked) memoryUsage.
    process.env.GITNEXUS_MEMORY = 'off';
    getHeapStatisticsMock.mockReturnValue({ heap_size_limit: 150_000 });

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
          workerUrlForTest: pathToFileURL(
            path.resolve(
              __dirname,
              '..',
              '..',
              'dist',
              'core',
              'ingestion',
              'workers',
              'parse-worker.js',
            ),
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

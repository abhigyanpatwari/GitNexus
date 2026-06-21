/**
 * C++ ingestion pipeline benchmark.
 *
 * Generates synthetic C++ codebases at increasing scales and measures
 * wall-clock time and peak heap through the full pipeline — scanning, parsing,
 * structure extraction, scope resolution, and graph emission. Fills the one
 * missing slot in the per-language benchmark suite (cobol/csharp/go/php/ruby/
 * rust already have one); modeled on cobol-pipeline-benchmark.test.ts.
 *
 * Run: GITNEXUS_BENCH=1 npx vitest run test/integration/cpp-pipeline-benchmark.test.ts
 *
 * Parses with a single-worker pool (`workerPoolSize: 1`) — the sequential
 * parser was removed, so the worker pool is the only parse path. NOTE: this
 * needs the built `dist/parse-worker.js`; run `npm run build` first. The
 * wall-clock numbers now include 1-worker IPC overhead, so re-baseline before
 * trusting the timeRatio margin and confirm the node-ratio guard below still
 * trips on an injected O(n²) regression. Scales are kept modest accordingly.
 *
 * IMPORTANT — this benchmark measures scaling in FILE COUNT, so per-file work
 * must stay constant as fileCount grows. Each translation unit therefore
 * #includes a FIXED number of shared headers (HEADERS_PER_FILE), independent of
 * fileCount. Do NOT make every TU include all headers: headerCount grows as
 * floor(fileCount/5), so include-all makes emitted symbol nodes — and thus total
 * work — O(fileCount²), which measures header fan-out rather than file-count
 * scaling. With constant fan-out the pipeline is O(fileCount); the deterministic
 * node-ratio assertion below guards against reintroducing the O(n²) pattern.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';

const BENCH_ENABLED = process.env.GITNEXUS_BENCH === '1';

interface BenchResult {
  fileCount: number;
  headerCount: number;
  methodCount: number;
  elapsedMs: number;
  peakHeapMB: number;
  nodeCount: number;
  edgeCount: number;
}

const METHODS_PER_CLASS = 4;
const HEADERS_PER_FILE = 3;

function generateCppFixture(fileCount: number): {
  dir: string;
  headerCount: number;
  methodCount: number;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `cpp-bench-${fileCount}-`));

  // Shared headers (1 per 5 TUs, at least 2): each a small namespace with a
  // struct and a free function the TUs call cross-file (constant fan-in).
  const headerCount = Math.max(2, Math.floor(fileCount / 5));
  const headerNames: string[] = [];
  for (let h = 0; h < headerCount; h++) {
    const ns = `hdr${h}`;
    headerNames.push(ns);
    fs.writeFileSync(
      path.join(dir, `${ns}.h`),
      [
        `#pragma once`,
        `namespace ${ns} {`,
        `struct Rec${h} { int value; };`,
        `void use${h}(Rec${h}& r);`,
        `}`,
        '',
      ].join('\n'),
    );
  }

  const methodCount = fileCount * METHODS_PER_CLASS;

  for (let f = 0; f < fileCount; f++) {
    const className = `C${String(f).padStart(5, '0')}`;
    // Constant include fan-out, chosen by index so headers stay shared.
    const includes = [
      ...new Set(
        Array.from({ length: HEADERS_PER_FILE }, (_, k) => headerNames[(f + k) % headerCount]),
      ),
    ];

    const methods: string[] = [];
    for (let m = 0; m < METHODS_PER_CLASS; m++) {
      // Intra-file call (resolves locally) + one cross-file call into an
      // included header's free function (constant cross-file fan-out).
      const nextM = (m + 1) % METHODS_PER_CLASS;
      const hdr = includes[m % includes.length];
      const hdrIdx = hdr.replace('hdr', '');
      methods.push(
        `  void m${m}() {`,
        `    m${nextM}();`,
        `    ${hdr}::Rec${hdrIdx} r;`,
        `    ${hdr}::use${hdrIdx}(r);`,
        `  }`,
      );
    }

    const content = [
      ...includes.map((h) => `#include "${h}.h"`),
      `class ${className} {`,
      `public:`,
      ...methods,
      `};`,
      '',
    ].join('\n');

    fs.writeFileSync(path.join(dir, `${className}.cpp`), content);
  }

  return { dir, headerCount, methodCount };
}

async function runBenchmark(fileCount: number, budgetMs: number): Promise<BenchResult> {
  const { dir, headerCount, methodCount } = generateCppFixture(fileCount);

  let peakHeapMB = 0;
  const heapSampler = setInterval(() => {
    const heap = process.memoryUsage().heapUsed / 1024 / 1024;
    if (heap > peakHeapMB) peakHeapMB = heap;
  }, 50);

  try {
    const start = Date.now();
    const result = await Promise.race([
      runPipelineFromRepo(dir, () => {}, { workerPoolSize: 1 }),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`Pipeline exceeded ${budgetMs}ms at ${fileCount} files`)),
          budgetMs,
        ),
      ),
    ]);
    const elapsedMs = Date.now() - start;

    return {
      fileCount,
      headerCount,
      methodCount,
      elapsedMs,
      peakHeapMB: Math.round(peakHeapMB),
      nodeCount: result.graph.nodeCount,
      edgeCount: result.graph.relationshipCount,
    };
  } finally {
    clearInterval(heapSampler);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function printResults(results: BenchResult[]) {
  console.log('\nC++ Pipeline');
  console.log('┌──────────┬──────────┬──────────┬───────────┬──────────┬───────┬───────┐');
  console.log('│ Files    │ Headers  │ Methods  │ Time (ms) │ Heap MB  │ Nodes │ Edges │');
  console.log('├──────────┼──────────┼──────────┼───────────┼──────────┼───────┼───────┤');
  for (const r of results) {
    console.log(
      `│ ${String(r.fileCount).padStart(8)} │ ${String(r.headerCount).padStart(8)} │ ${String(r.methodCount).padStart(8)} │ ${String(r.elapsedMs).padStart(9)} │ ${String(r.peakHeapMB).padStart(8)} │ ${String(r.nodeCount).padStart(5)} │ ${String(r.edgeCount).padStart(5)} │`,
    );
  }
  console.log('└──────────┴──────────┴──────────┴───────────┴──────────┴───────┴───────┘');

  if (results.length >= 2) {
    console.log('\nScaling ratios (time_ratio / file_ratio):');
    for (let i = 1; i < results.length; i++) {
      const fileRatio = results[i].fileCount / results[i - 1].fileCount;
      const timeRatio = results[i].elapsedMs / results[i - 1].elapsedMs;
      const scaling = timeRatio / fileRatio;
      console.log(
        `  ${results[i - 1].fileCount} → ${results[i].fileCount}: ${scaling.toFixed(2)}x (${scaling < 1.5 ? 'linear' : scaling < 3 ? 'superlinear' : 'WARNING: quadratic'})`,
      );
    }
  }
}

describe.skipIf(!BENCH_ENABLED)('C++ pipeline benchmark', () => {
  it('scales with file count', async () => {
    const scales = [50, 100, 200, 400];
    const results: BenchResult[] = [];

    for (const fileCount of scales) {
      const result = await runBenchmark(fileCount, 300_000);
      results.push(result);
      console.log(
        `  ${fileCount} files: ${result.elapsedMs}ms, ${result.peakHeapMB}MB heap, ${result.nodeCount} nodes, ${result.edgeCount} edges`,
      );
    }

    printResults(results);

    for (let i = 1; i < results.length; i++) {
      const fileRatio = results[i].fileCount / results[i - 1].fileCount;
      const timeRatio = results[i].elapsedMs / results[i - 1].elapsedMs;
      // Wall-clock is noisy (GC/CI load); keep a coarse upper bound here.
      expect(timeRatio / fileRatio).toBeLessThan(4);

      // Deterministic regression guard: with constant per-file include fan-out
      // the emitted node count is linear in fileCount (ratio ≈ 1.0). If someone
      // reintroduces O(fileCount²) work — e.g. by making every TU include all
      // headers — node growth jumps and this fails. Node count is deterministic,
      // so this is a non-flaky guard unlike the wall-clock check above.
      const nodeRatio = results[i].nodeCount / results[i - 1].nodeCount;
      expect(nodeRatio / fileRatio).toBeLessThan(1.3);
    }
  }, 600_000);
});

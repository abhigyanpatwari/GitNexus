/**
 * C++ ADL (argument-dependent lookup) emit-scaling benchmark.
 *
 * Guards the optimization in PR #1990: `pickCppAdlCandidates` used to rescan all
 * parsed files (and all workspace defs) once PER unresolved ADL call site —
 * O(sites × files). It now queries a once-built index — O(sites). This benchmark
 * reproduces the pathological shape (many unresolved ADL sites) and asserts the
 * scope-resolution EMIT phase scales sub-quadratically.
 *
 * Run: GITNEXUS_BENCH=1 npx vitest run test/integration/cpp-adl-benchmark.test.ts
 *
 * WHY EMIT MS, NOT WALL TIME: parse dominates total wall time — masking the ADL
 * cost — so we isolate the scope-resolution `emit` ms from the profiler log
 * (captured in-process via the logger test destination). Because the metric is
 * the emit-ms RATIO (downstream of and independent from parsing), it is robust
 * to the parse path: the fixture is parsed with a single-worker pool
 * (`workerPoolSize: 1`) since the sequential parser was removed. Requires the
 * built `dist/parse-worker.js` (run `npm run build` first).
 *
 * WHY CO-SCALE FILES AND SITES: the regression is O(sites × files). At fixed
 * files, both the old and new code are linear in sites and indistinguishable.
 * Scaling both with N makes the OLD cost O(N²) and the NEW cost O(N); the
 * end-to-end emit ratio then separates them cleanly (linear ≈ Nratio,
 * quadratic ≈ Nratio²). The guard sits at Nratio^1.5.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import { _captureLogger } from '../../src/core/logger.js';

const BENCH_ENABLED = process.env.GITNEXUS_BENCH === '1';

interface BenchResult {
  fileCount: number;
  siteCount: number;
  elapsedMs: number;
  emitMs: number;
  peakHeapMB: number;
  nodeCount: number;
  callsResolved: number;
}

/**
 * Generate a workspace of `fileCount` headers, each declaring its own namespace
 * + struct, and one app.cpp with `siteCount` callers. Every caller makes a
 * class-typed local and calls `ghost(...)` — a name declared NOWHERE — so
 * ordinary lookup fails, ADL fires (the arg is class-typed), the index is
 * scanned, and the site stays UNRESOLVED. That is the maximal-scan shape the
 * optimization targets. Per-file work is constant; sites scale independently.
 */
function generateCppAdlFixture(fileCount: number, siteCount: number): { dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `cpp-adl-bench-${fileCount}-`));
  for (let k = 0; k < fileCount; k++) {
    const helpers = Array.from({ length: 3 }, (_, j) => `void helper${k}_${j}(T${k}& x) {}`).join(
      '\n',
    );
    fs.writeFileSync(
      path.join(dir, `lib_${k}.h`),
      `namespace lib_${k} {\nstruct T${k} {};\n${helpers}\n}\n`,
    );
  }
  const includes = Array.from({ length: fileCount }, (_, k) => `#include "lib_${k}.h"`).join('\n');
  const callers = Array.from({ length: siteCount }, (_, i) => {
    const k = i % fileCount;
    return `void call_${i}() {\n  lib_${k}::T${k} t;\n  ghost(t);\n}`;
  }).join('\n');
  fs.writeFileSync(path.join(dir, 'app.cpp'), `${includes}\n\n${callers}\n`);
  return { dir };
}

/** Largest `emit=<n>ms` across the captured scope-resolution profiler lines
 *  (the C++ pass dominates). Returns NaN if no profiler line was captured. */
function extractEmitMs(records: { msg?: string }[]): number {
  let max = NaN;
  for (const r of records) {
    const m = /\[scope-resolution prof\].*emit=(\d+(?:\.\d+)?)ms/.exec(r.msg ?? '');
    if (m) {
      const v = Number(m[1]);
      max = Number.isNaN(max) ? v : Math.max(max, v);
    }
  }
  return max;
}

async function runBenchmark(fileCount: number, siteCount: number): Promise<BenchResult> {
  const { dir } = generateCppAdlFixture(fileCount, siteCount);
  let peakHeapMB = 0;
  const heapSampler = setInterval(() => {
    const heap = process.memoryUsage().heapUsed / 1024 / 1024;
    if (heap > peakHeapMB) peakHeapMB = heap;
  }, 50);

  const prevProf = process.env.PROF_SCOPE_RESOLUTION;
  process.env.PROF_SCOPE_RESOLUTION = '1';
  const cap = _captureLogger();
  try {
    const start = Date.now();
    const result = await runPipelineFromRepo(dir, () => {}, { workerPoolSize: 1 });
    const elapsedMs = Date.now() - start;
    const emitMs = extractEmitMs(cap.records());

    let callsResolved = 0;
    for (const rel of result.graph.iterRelationships()) {
      if (rel.type === 'CALLS') callsResolved++;
    }

    return {
      fileCount,
      siteCount,
      elapsedMs,
      emitMs,
      peakHeapMB: Math.round(peakHeapMB),
      nodeCount: result.graph.nodeCount,
      callsResolved,
    };
  } finally {
    cap.restore();
    if (prevProf === undefined) delete process.env.PROF_SCOPE_RESOLUTION;
    else process.env.PROF_SCOPE_RESOLUTION = prevProf;
    clearInterval(heapSampler);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function printResults(results: BenchResult[]) {
  console.log('\nC++ ADL emit-scaling benchmark (unresolved-site pattern)');
  console.log('┌────────┬────────┬───────────┬──────────┬──────────┬───────┬───────────┐');
  console.log('│ Files  │ Sites  │ Wall (ms) │ Emit (ms)│ Heap MB  │ Nodes │ CALLS res │');
  console.log('├────────┼────────┼───────────┼──────────┼──────────┼───────┼───────────┤');
  for (const r of results) {
    console.log(
      `│ ${String(r.fileCount).padStart(6)} │ ${String(r.siteCount).padStart(6)} │ ${String(r.elapsedMs).padStart(9)} │ ${String(Number.isNaN(r.emitMs) ? 'n/a' : Math.round(r.emitMs)).padStart(8)} │ ${String(r.peakHeapMB).padStart(8)} │ ${String(r.nodeCount).padStart(5)} │ ${String(r.callsResolved).padStart(9)} │`,
    );
  }
  console.log('└────────┴────────┴───────────┴──────────┴──────────┴───────┴───────────┘');
}

describe.skipIf(!BENCH_ENABLED)('C++ ADL emit benchmark', () => {
  it('emit phase scales sub-quadratically with co-scaled files and sites', async () => {
    // files = N, sites = 6N. OLD emit O(sites × files) = O(6N²); NEW emit O(N).
    const scales = [40, 80, 160];
    const results: BenchResult[] = [];
    for (const n of scales) {
      results.push(await runBenchmark(n, n * 6));
    }
    printResults(results);

    const first = results[0];
    const last = results[results.length - 1];
    const fileRatio = last.fileCount / first.fileCount;

    // Primary guard: isolated emit ms. Linear ≈ fileRatio; quadratic ≈
    // fileRatio². The threshold fileRatio^1.5 sits between them with margin for
    // wall-clock/GC noise. Only applied when the profiler line was captured at
    // both ends (otherwise the in-process capture is unavailable in this env).
    if (!Number.isNaN(first.emitMs) && !Number.isNaN(last.emitMs) && first.emitMs > 0) {
      const emitRatio = last.emitMs / first.emitMs;
      expect(emitRatio).toBeLessThan(Math.pow(fileRatio, 1.5));
    } else {
      // Fallback: a coarse catastrophe guard on total wall (parse-dominated, so
      // it only catches gross blow-ups, not the constant-factor ADL regression).
      const wallRatio = last.elapsedMs / first.elapsedMs;
      expect(wallRatio).toBeLessThan(Math.pow(fileRatio, 2));
    }

    // Sanity: the sites are intentionally unresolved (ghost is declared nowhere),
    // so this benchmark stresses the scan path, not edge emission.
    expect(last.callsResolved).toBe(0);
  }, 600_000);
});

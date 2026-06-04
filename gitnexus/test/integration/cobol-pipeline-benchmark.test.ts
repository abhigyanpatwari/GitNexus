/**
 * COBOL ingestion pipeline benchmark.
 *
 * Generates synthetic COBOL codebases at increasing scales and measures
 * wall-clock time and peak heap through the full pipeline — scanning,
 * preprocessing, COPY expansion, CALL resolution, and scope extraction.
 *
 * Run: GITNEXUS_BENCH=1 npx vitest run test/integration/cobol-pipeline-benchmark.test.ts
 *
 * COBOL is wired as a standalone provider, so the scope-resolution phase is
 * skipped for it (standalone guard in phase.ts) and node/edge counts come
 * entirely from cobolPhase.
 *
 * IMPORTANT — this benchmark measures scaling in FILE COUNT, so per-file work
 * must stay constant as fileCount grows. Each program therefore COPYs a fixed
 * number of shared copybooks (COPYBOOKS_PER_PROGRAM), independent of fileCount.
 * Do NOT make every program COPY all copybooks: copybookCount grows as
 * floor(fileCount/5), so copy-all makes emitted data-item nodes — and thus
 * total work — O(fileCount²), which measures copybook fan-out rather than
 * file-count scaling. The pipeline itself is O(fileCount) (verified: with
 * constant fan-out, node count and wall-clock scale exactly linearly); the
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
  programCount: number;
  paragraphCount: number;
  copybookCount: number;
  elapsedMs: number;
  peakHeapMB: number;
  nodeCount: number;
  edgeCount: number;
}

function generateCobolFixture(
  fileCount: number,
  paragraphsPerProgram: number,
): { dir: string; programCount: number; paragraphCount: number; copybookCount: number } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `cobol-bench-${fileCount}-`));
  const copybookDir = path.join(dir, 'copybooks');
  fs.mkdirSync(copybookDir, { recursive: true });

  const programCount = fileCount;
  const paragraphCount = fileCount * paragraphsPerProgram;

  // Generate shared copybooks (1 per 5 programs, at least 2)
  const copybookCount = Math.max(2, Math.floor(fileCount / 5));
  const copybookNames: string[] = [];
  for (let c = 0; c < copybookCount; c++) {
    const name = `BENCH${String(c + 1).padStart(4, '0')}`;
    copybookNames.push(name);
    const copyContent = [
      `       01 ${name}-RECORD.`,
      `           05 ${name}-KEY        PIC X(10).`,
      `           05 ${name}-VALUE      PIC 9(08).`,
      `           05 ${name}-FLAG       PIC X(01).`,
      '',
    ].join('\n');
    fs.writeFileSync(path.join(copybookDir, `${name}.cpy`), copyContent);
  }

  for (let f = 0; f < fileCount; f++) {
    const programName = `PGM${String(f + 1).padStart(4, '0')}`;
    const paragraphs: string[] = [];

    for (let p = 0; p < paragraphsPerProgram; p++) {
      const paraName = `${String(p + 1).padStart(4, '0')}-PARA`;

      // Every paragraph has a PERFORM to the next paragraph (or wraps around)
      const nextParaIdx = (p + 1) % paragraphsPerProgram;
      const nextParaName = `${String(nextParaIdx + 1).padStart(4, '0')}-PARA`;
      const performLine = `           PERFORM ${nextParaName}.`;

      // Cross-file CALL: every 3rd paragraph calls another program
      const crossFileIdx = (f + p + 1) % fileCount;
      const crossProgram = `PGM${String(crossFileIdx + 1).padStart(4, '0')}`;
      const callLine =
        p % 3 === 0
          ? `           CALL '${crossProgram}' USING ${copybookNames[p % copybookCount]}-KEY.`
          : '';

      // COPY in paragraphs adds preprocessing stress — non-idiomatic but
      // exercises the preprocessor's expansion path per-paragraph.
      const copyLine = `           COPY ${copybookNames[f % copybookCount]}.`;

      paragraphs.push(
        `       ${paraName}.`,
        copyLine,
        performLine,
        callLine,
        `           DISPLAY '${programName} ${paraName}'.`,
        '',
      );
    }

    // Each program COPYs a CONSTANT number of shared copybooks (independent of
    // fileCount) so per-file work stays O(1) and the benchmark measures true
    // file-count scaling. Copybooks are chosen by program index so they remain
    // shared across programs (fan-in), still exercising cross-program copybook
    // reuse and multi-COPY-per-program expansion. (Copying ALL copybooks here
    // would make per-file work — and emitted data-item nodes — grow with
    // fileCount, i.e. O(fileCount²); see the file header.)
    const COPYBOOKS_PER_PROGRAM = 3;
    const wsCopybooks = [
      ...new Set(
        Array.from(
          { length: COPYBOOKS_PER_PROGRAM },
          (_, k) => copybookNames[(f + k) % copybookCount],
        ),
      ),
    ];

    const content = [
      `       IDENTIFICATION DIVISION.`,
      `       PROGRAM-ID. ${programName}.`,
      `       ENVIRONMENT DIVISION.`,
      `       DATA DIVISION.`,
      `       WORKING-STORAGE SECTION.`,
      ...wsCopybooks.map((n) => `           COPY ${n}.`),
      `       PROCEDURE DIVISION.`,
      ...paragraphs,
      `       STOP RUN.`,
      `       END PROGRAM ${programName}.`,
      '',
    ].join('\n');

    fs.writeFileSync(path.join(dir, `${programName}.cbl`), content);
  }

  return { dir, programCount, paragraphCount, copybookCount };
}

async function runBenchmark(
  fileCount: number,
  paragraphsPerProgram: number,
  budgetMs: number,
): Promise<BenchResult> {
  const { dir, programCount, paragraphCount, copybookCount } = generateCobolFixture(
    fileCount,
    paragraphsPerProgram,
  );

  let peakHeapMB = 0;
  const heapSampler = setInterval(() => {
    const heap = process.memoryUsage().heapUsed / 1024 / 1024;
    if (heap > peakHeapMB) peakHeapMB = heap;
  }, 50);

  try {
    const start = Date.now();
    const result = await Promise.race([
      runPipelineFromRepo(dir, () => {}, { skipGraphPhases: true }),
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
      programCount,
      paragraphCount,
      copybookCount,
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

function printResults(label: string, results: BenchResult[]) {
  console.log(`\n${label}`);
  console.log(
    '┌──────────┬──────────┬────────────┬──────────┬───────────┬──────────┬───────┬───────┐',
  );
  console.log(
    '│ Files    │ Programs │ Paragraphs │ Copybooks│ Time (ms) │ Heap MB  │ Nodes │ Edges │',
  );
  console.log(
    '├──────────┼──────────┼────────────┼──────────┼───────────┼──────────┼───────┼───────┤',
  );
  for (const r of results) {
    console.log(
      `│ ${String(r.fileCount).padStart(8)} │ ${String(r.programCount).padStart(8)} │ ${String(r.paragraphCount).padStart(10)} │ ${String(r.copybookCount).padStart(8)} │ ${String(r.elapsedMs).padStart(9)} │ ${String(r.peakHeapMB).padStart(8)} │ ${String(r.nodeCount).padStart(5)} │ ${String(r.edgeCount).padStart(5)} │`,
    );
  }
  console.log(
    '└──────────┴──────────┴────────────┴──────────┴───────────┴──────────┴───────┴───────┘',
  );

  if (results.length >= 2) {
    console.log('\nScaling ratios (time_ratio / file_ratio):');
    for (let i = 1; i < results.length; i++) {
      const fileRatio = results[i].fileCount / results[i - 1].fileCount;
      const timeRatio = results[i].elapsedMs / results[i - 1].elapsedMs;
      const scaling = timeRatio / fileRatio;
      console.log(
        `  ${results[i - 1].fileCount} \u2192 ${results[i].fileCount}: ${scaling.toFixed(2)}x (${scaling < 1.5 ? 'linear' : scaling < 3 ? 'superlinear' : 'WARNING: quadratic'})`,
      );
    }
  }
}

describe.skipIf(!BENCH_ENABLED)('COBOL pipeline benchmark', () => {
  it('scales with file count', async () => {
    const scales = [100, 250, 500, 1000];
    const results: BenchResult[] = [];

    for (const fileCount of scales) {
      const paragraphsPerProgram = 3;
      const result = await runBenchmark(fileCount, paragraphsPerProgram, 300_000);
      results.push(result);
      console.log(
        `  ${fileCount} files: ${result.elapsedMs}ms, ${result.peakHeapMB}MB heap, ${result.nodeCount} nodes, ${result.edgeCount} edges`,
      );
    }

    printResults('COBOL Pipeline', results);

    for (let i = 1; i < results.length; i++) {
      const fileRatio = results[i].fileCount / results[i - 1].fileCount;
      const timeRatio = results[i].elapsedMs / results[i - 1].elapsedMs;
      // Wall-clock is noisy (GC/CI load); keep a coarse upper bound here.
      expect(timeRatio / fileRatio).toBeLessThan(4);

      // Deterministic regression guard: with constant per-program copybook
      // fan-out the emitted node count is exactly linear in fileCount
      // (ratio ≈ 1.0). If someone reintroduces O(fileCount²) work — e.g. by
      // making every program COPY all copybooks — node growth jumps to ~2x
      // per file-doubling and this fails. Node count is deterministic, so
      // this is a non-flaky guard unlike the wall-clock check above.
      const nodeRatio = results[i].nodeCount / results[i - 1].nodeCount;
      expect(nodeRatio / fileRatio).toBeLessThan(1.3);
    }
  }, 600_000);
});

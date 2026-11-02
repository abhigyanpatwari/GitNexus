/**
 * Objective-C ingestion pipeline benchmark.
 *
 * Generates synthetic .h/.m pairs at increasing scales and measures
 * wall-clock time and peak heap through the full pipeline — header
 * classification, parsing, provider-owned semantic facts, import
 * suffix resolution, and static message-send edges.
 *
 * Mirrors test/integration/csharp-pipeline-benchmark.test.ts and
 * test/integration/php-pipeline-benchmark.test.ts. Two shapes:
 *   1. "spread" — each class imports a fixed sibling (constant fan-out;
 *      see cpp-pipeline-benchmark.test.ts). This is the linear file-count
 *      gate.
 *   2. "protocol" — every class conforms to one shared protocol and
 *      sends one protocol-typed message. Implementer USES are shared
 *      per (protocol, selector); the dedicated
 *      bench/objective-c-resolution protocol arm pins that evidence
 *      shape at O(implementers).
 *
 * Run: GITNEXUS_BENCH=1 npx vitest run test/integration/objective-c-pipeline-benchmark.test.ts
 */
import { beforeAll, describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';

const BENCH_ENABLED = process.env.GITNEXUS_BENCH === '1';

beforeAll(() => vi.stubEnv('GITNEXUS_WORKER_READY_TIMEOUT_MS', '60000'));

interface BenchResult {
  classCount: number;
  fileCount: number;
  elapsedMs: number;
  peakHeapMB: number;
  nodeCount: number;
  edgeCount: number;
}

type FixtureShape = 'spread' | 'protocol';

function generateObjectiveCFixture(
  classCount: number,
  shape: FixtureShape,
): { dir: string; fileCount: number } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `objc-bench-${shape}-${classCount}-`));

  if (shape === 'protocol') {
    fs.writeFileSync(
      path.join(dir, 'Runnable.h'),
      [
        '#import <Foundation/Foundation.h>',
        '',
        '@protocol Runnable',
        '- (void)run;',
        '@end',
        '',
      ].join('\n'),
    );
  }

  for (let f = 0; f < classCount; f++) {
    const className = `Class${f}`;
    const sibling = `Class${(f + 1) % classCount}`;
    const header =
      shape === 'protocol'
        ? [
            '#import <Foundation/Foundation.h>',
            '#import "Runnable.h"',
            '',
            `@interface ${className} : NSObject <Runnable>`,
            '- (void)run;',
            '- (void)tick:(id<Runnable>)runner;',
            '@end',
            '',
          ].join('\n')
        : [
            '#import <Foundation/Foundation.h>',
            '',
            `@interface ${className} : NSObject`,
            '- (void)process;',
            '@end',
            '',
          ].join('\n');

    const impl =
      shape === 'protocol'
        ? [
            `#import "${className}.h"`,
            '',
            `@implementation ${className}`,
            '- (void)run {}',
            '- (void)tick:(id<Runnable>)runner',
            '{',
            '    [self run];',
            '    [runner run];',
            '}',
            '@end',
            '',
          ].join('\n')
        : [
            `#import "${className}.h"`,
            `#import "${sibling}.h"`,
            '',
            `@implementation ${className}`,
            '- (void)process',
            '{',
            '    [self process];',
            `    ${sibling} *sib = [${sibling} new];`,
            '    [sib process];',
            '}',
            '@end',
            '',
          ].join('\n');

    fs.writeFileSync(path.join(dir, `${className}.h`), header);
    fs.writeFileSync(path.join(dir, `${className}.m`), impl);
  }

  const fileCount = classCount * 2 + (shape === 'protocol' ? 1 : 0);
  return { dir, fileCount };
}

async function runBenchmark(
  classCount: number,
  shape: FixtureShape,
  budgetMs: number,
): Promise<BenchResult> {
  const { dir, fileCount } = generateObjectiveCFixture(classCount, shape);

  let peakHeapMB = 0;
  const heapSampler = setInterval(() => {
    const heap = process.memoryUsage().heapUsed / 1024 / 1024;
    if (heap > peakHeapMB) peakHeapMB = heap;
  }, 50);

  let budgetTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const start = Date.now();
    const result = await Promise.race([
      runPipelineFromRepo(dir, () => {}, { skipGraphPhases: true }),
      new Promise<never>((_, reject) => {
        budgetTimer = setTimeout(
          () =>
            reject(
              new Error(`Pipeline exceeded ${budgetMs}ms at ${classCount} classes (${shape})`),
            ),
          budgetMs,
        );
      }),
    ]);
    const elapsedMs = Date.now() - start;

    return {
      classCount,
      fileCount,
      elapsedMs,
      peakHeapMB: Math.round(peakHeapMB),
      nodeCount: result.graph.nodeCount,
      edgeCount: result.graph.relationshipCount,
    };
  } finally {
    clearInterval(heapSampler);
    clearTimeout(budgetTimer);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function printResults(label: string, results: BenchResult[]) {
  console.log(`\n${label}`);
  console.log('┌──────────┬──────────┬───────────┬──────────┬───────┬───────┐');
  console.log('│ Classes  │ Files    │ Time (ms) │ Heap MB  │ Nodes │ Edges │');
  console.log('├──────────┼──────────┼───────────┼──────────┼───────┼───────┤');
  for (const r of results) {
    console.log(
      `│ ${String(r.classCount).padStart(8)} │ ${String(r.fileCount).padStart(8)} │ ${String(r.elapsedMs).padStart(9)} │ ${String(r.peakHeapMB).padStart(8)} │ ${String(r.nodeCount).padStart(5)} │ ${String(r.edgeCount).padStart(5)} │`,
    );
  }
  console.log('└──────────┴──────────┴───────────┴──────────┴───────┴───────┘');

  if (results.length >= 2) {
    console.log('\nScaling ratios (time_ratio / class_ratio):');
    for (let i = 1; i < results.length; i++) {
      const classRatio = results[i].classCount / results[i - 1].classCount;
      const timeRatio = results[i].elapsedMs / results[i - 1].elapsedMs;
      const scaling = timeRatio / classRatio;
      console.log(
        `  ${results[i - 1].classCount} → ${results[i].classCount}: ${scaling.toFixed(2)}x (${scaling < 1.5 ? 'linear' : scaling < 3 ? 'superlinear' : 'WARNING: quadratic'})`,
      );
    }
  }
}

describe.skipIf(!BENCH_ENABLED)('Objective-C pipeline benchmark', () => {
  it('scales with file count — typed sibling receivers', async () => {
    const scales = [40, 80, 160];
    const results: BenchResult[] = [];

    for (const classCount of scales) {
      const result = await runBenchmark(classCount, 'spread', 180_000);
      results.push(result);
      console.log(
        `  ${classCount} classes: ${result.elapsedMs}ms, ${result.peakHeapMB}MB heap, ${result.nodeCount} nodes, ${result.edgeCount} edges`,
      );
    }

    printResults('Objective-C Pipeline — Spread', results);

    expect(results[results.length - 1].edgeCount).toBeGreaterThan(0);

    for (let i = 1; i < results.length; i++) {
      const classRatio = results[i].classCount / results[i - 1].classCount;
      const timeRatio = results[i].elapsedMs / results[i - 1].elapsedMs;
      expect(timeRatio / classRatio).toBeLessThan(3);
      // Wall-clock at these scales is worker-startup dominated; node/edge
      // cardinality is the load-bearing linearity check (cpp-pipeline analog).
      expect(results[i].nodeCount / results[i - 1].nodeCount).toBeCloseTo(classRatio, 1);
      expect(results[i].edgeCount / results[i - 1].edgeCount).toBeCloseTo(classRatio, 1);
    }
  }, 600_000);

  it('scales with file count — shared protocol receivers', async () => {
    const scales = [40, 80, 160];
    const results: BenchResult[] = [];

    for (const classCount of scales) {
      const result = await runBenchmark(classCount, 'protocol', 180_000);
      results.push(result);
      console.log(
        `  ${classCount} classes: ${result.elapsedMs}ms, ${result.peakHeapMB}MB heap, ${result.nodeCount} nodes, ${result.edgeCount} edges`,
      );
    }

    printResults('Objective-C Pipeline — Shared Protocol', results);

    expect(results[results.length - 1].edgeCount).toBeGreaterThan(0);

    for (let i = 1; i < results.length; i++) {
      const classRatio = results[i].classCount / results[i - 1].classCount;
      const timeRatio = results[i].elapsedMs / results[i - 1].elapsedMs;
      expect(timeRatio / classRatio).toBeLessThan(3);
      expect(results[i].nodeCount / results[i - 1].nodeCount).toBeCloseTo(classRatio, 1);
      expect(results[i].edgeCount / results[i - 1].edgeCount).toBeCloseTo(classRatio, 1);
    }
  }, 600_000);
});

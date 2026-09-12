/**
 * Spring programmatic lookup scaling for Java and Kotlin.
 *
 * Always-on tripwires catch a quadratic re-walk of every invocation in a dense
 * file. Gated suites measure capture and full-pipeline INJECTS resolution:
 *
 *   GITNEXUS_BENCH=1 npx vitest run test/integration/spring-dynamic-lookup-benchmark.test.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { emitJavaScopeCaptures } from '../../src/core/ingestion/languages/java/captures.js';
import { collectJavaCaptureSideChannel } from '../../src/core/ingestion/languages/java/capture-side-channel.js';
import { emitKotlinScopeCaptures } from '../../src/core/ingestion/languages/kotlin/captures.js';
import { collectKotlinCaptureSideChannel } from '../../src/core/ingestion/languages/kotlin/capture-side-channel.js';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';

const BENCH_ENABLED = process.env.GITNEXUS_BENCH === '1';
const LOOKUPS_PER_CONSUMER = 2;
// Time growth divided by input growth: linear work stays near 1.
const LINEAR_SCALING_TOLERANCE = 1.5;

interface CaptureBenchResult {
  consumers: number;
  elapsedMs: number;
  captureCount: number;
  factCount: number;
}

function denseJavaLookupSource(consumerCount: number): string {
  const consumers = Array.from({ length: consumerCount }, (_, index) => {
    return `
class Consumer${index} {
  void collect${index}() { ctx.getBeans(Parent.class); }
  void single${index}() { applicationContext.getBean(Parent.class); }
  void decoy${index}() { other.getName(); }
  void noise${index}() {
    // ctx.getBeans(Parent.class);
    String example = "ctx.getBean(Parent.class)";
  }
}
`;
  }).join('\n');

  return `package com.example;
interface Parent {}
class Impl implements Parent {}
${consumers}
`;
}

function denseKotlinLookupSource(consumerCount: number): string {
  const consumers = Array.from({ length: consumerCount }, (_, index) => {
    return `
class Consumer${index} {
  fun collect${index}() { ctx.getBeans(Parent::class.java) }
  fun single${index}() { applicationContext.getBean(Parent::class) }
  fun decoy${index}() { other.getName() }
  fun noise${index}() {
    // ctx.getBeans(Parent::class.java)
    val example = "ctx.getBean(Parent::class.java)"
  }
}
`;
  }).join('\n');

  return `package com.example
interface Parent
class Impl : Parent
${consumers}
`;
}

function runJavaCaptureBenchmark(consumerCount: number, run: number): CaptureBenchResult {
  const filePath = `src/SpringDynamicLookupBench${consumerCount}_${run}.java`;
  const start = performance.now();
  const captures = emitJavaScopeCaptures(denseJavaLookupSource(consumerCount), filePath);
  const elapsedMs = performance.now() - start;
  const facts = collectJavaCaptureSideChannel(filePath)?.springDynamicLookupFacts ?? [];
  return {
    consumers: consumerCount,
    elapsedMs,
    captureCount: captures.length,
    factCount: facts.length,
  };
}

function runKotlinCaptureBenchmark(consumerCount: number, run: number): CaptureBenchResult {
  const filePath = `src/SpringDynamicLookupBench${consumerCount}_${run}.kt`;
  const start = performance.now();
  const captures = emitKotlinScopeCaptures(denseKotlinLookupSource(consumerCount), filePath);
  const elapsedMs = performance.now() - start;
  const facts = collectKotlinCaptureSideChannel(filePath)?.springDynamicLookupFacts ?? [];
  return {
    consumers: consumerCount,
    elapsedMs,
    captureCount: captures.length,
    factCount: facts.length,
  };
}

function assertCaptureScaling(results: readonly CaptureBenchResult[]): void {
  const first = results[0];
  const last = results[results.length - 1];
  expect(last.factCount).toBe(last.consumers * LOOKUPS_PER_CONSUMER);
  const sizeRatio = last.consumers / first.consumers;
  if (first.elapsedMs >= 20) {
    const normalizedGrowth = last.elapsedMs / first.elapsedMs / sizeRatio;
    expect(normalizedGrowth).toBeLessThan(LINEAR_SCALING_TOLERANCE);
  } else {
    expect(last.elapsedMs).toBeLessThan(10_000);
  }
}

describe('Spring dynamic lookup capture O(n²) regression tripwire', () => {
  it('captures a dense 400-consumer Java file within a coarse linear-time budget', () => {
    const consumers = 400;
    runJavaCaptureBenchmark(4, 0);
    const result = runJavaCaptureBenchmark(consumers, 1);
    expect(result.factCount).toBe(consumers * LOOKUPS_PER_CONSUMER);
    expect(result.captureCount).toBeGreaterThan(consumers * 8);
    expect(result.elapsedMs).toBeLessThan(10_000);
  }, 30_000);

  it('captures a dense 400-consumer Kotlin file within a coarse linear-time budget', () => {
    const consumers = 400;
    runKotlinCaptureBenchmark(4, 0);
    const result = runKotlinCaptureBenchmark(consumers, 1);
    expect(result.factCount).toBe(consumers * LOOKUPS_PER_CONSUMER);
    expect(result.captureCount).toBeGreaterThan(consumers * 8);
    expect(result.elapsedMs).toBeLessThan(10_000);
  }, 30_000);
});

describe.skipIf(!BENCH_ENABLED)('Java Spring dynamic lookup capture scaling', () => {
  it('scales sub-quadratically as Java lookup sites grow', () => {
    const scales = [100, 200, 400];
    const repetitions = 4;
    const results: CaptureBenchResult[] = [];
    runJavaCaptureBenchmark(8, 0);
    for (const consumers of scales) {
      let elapsedMs = 0;
      let captureCount = 0;
      let factCount = 0;
      for (let run = 0; run < repetitions; run++) {
        const current = runJavaCaptureBenchmark(consumers, run + 1);
        elapsedMs += current.elapsedMs;
        captureCount = current.captureCount;
        factCount = current.factCount;
      }
      results.push({ consumers, elapsedMs, captureCount, factCount });
      process.stdout.write(
        `  java capture n=${consumers} ×${repetitions}: ${elapsedMs.toFixed(1)}ms ` +
          `(${factCount} facts, ${captureCount} captures/run)\n`,
      );
    }
    assertCaptureScaling(results);
  }, 120_000);
});

describe.skipIf(!BENCH_ENABLED)('Kotlin Spring dynamic lookup capture scaling', () => {
  it('scales sub-quadratically as Kotlin lookup sites grow', () => {
    const scales = [100, 200, 400];
    const repetitions = 4;
    const results: CaptureBenchResult[] = [];
    runKotlinCaptureBenchmark(8, 0);
    for (const consumers of scales) {
      let elapsedMs = 0;
      let captureCount = 0;
      let factCount = 0;
      for (let run = 0; run < repetitions; run++) {
        const current = runKotlinCaptureBenchmark(consumers, run + 1);
        elapsedMs += current.elapsedMs;
        captureCount = current.captureCount;
        factCount = current.factCount;
      }
      results.push({ consumers, elapsedMs, captureCount, factCount });
      process.stdout.write(
        `  kotlin capture n=${consumers} ×${repetitions}: ${elapsedMs.toFixed(1)}ms ` +
          `(${factCount} facts, ${captureCount} captures/run)\n`,
      );
    }
    assertCaptureScaling(results);
  }, 120_000);
});

function writeJavaLookupRepo(consumerCount: number): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `spring-dynamic-java-${consumerCount}-`));
  fs.writeFileSync(
    path.join(dir, 'Parent.java'),
    `package a;
public interface Parent {}
`,
  );
  fs.writeFileSync(
    path.join(dir, 'Impl.java'),
    `package a;
public class Impl implements Parent {}
`,
  );
  for (let index = 0; index < consumerCount; index++) {
    fs.writeFileSync(
      path.join(dir, `Consumer${index}.java`),
      `package c;
import a.Parent;
class Consumer${index} {
  void lookup() { ctx.getBeans(Parent.class); }
}
`,
    );
  }
  return dir;
}

function writeKotlinLookupRepo(consumerCount: number): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `spring-dynamic-kotlin-${consumerCount}-`));
  fs.writeFileSync(path.join(dir, 'Parent.kt'), 'package a\ninterface Parent\n');
  fs.writeFileSync(path.join(dir, 'Impl.kt'), 'package a\nclass Impl : Parent\n');
  for (let index = 0; index < consumerCount; index++) {
    fs.writeFileSync(
      path.join(dir, `Consumer${index}.kt`),
      `package c
import a.Parent
class Consumer${index} {
  fun lookup() { ctx.getBeans(Parent::class.java) }
}
`,
    );
  }
  return dir;
}

async function runPipelineBenchmark(
  label: string,
  writeRepo: (consumerCount: number) => string,
): Promise<void> {
  const scales = [25, 50, 100];
  const results: Array<{ consumers: number; elapsedMs: number; injects: number }> = [];

  for (const consumers of scales) {
    const dir = writeRepo(consumers);
    try {
      const start = performance.now();
      const result = await runPipelineFromRepo(dir, () => {}, {});
      const elapsedMs = performance.now() - start;
      const injects = [...result.graph.iterRelationshipsByType('INJECTS')].length;
      results.push({ consumers, elapsedMs, injects });
      process.stdout.write(
        `  ${label} pipeline n=${consumers}: ${elapsedMs.toFixed(1)}ms (${injects} INJECTS edges)\n`,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  for (const result of results) expect(result.injects).toBe(result.consumers);
  const first = results[0];
  const last = results[results.length - 1];
  const sizeRatio = last.consumers / first.consumers;
  const normalizedGrowth = last.elapsedMs / first.elapsedMs / sizeRatio;
  expect(normalizedGrowth).toBeLessThan(LINEAR_SCALING_TOLERANCE);
}

describe.skipIf(!BENCH_ENABLED)('Java Spring dynamic lookup end-to-end scaling', () => {
  it('keeps Java pipeline lookup resolution sub-quadratic across file counts', async () => {
    await runPipelineBenchmark('java', writeJavaLookupRepo);
  }, 300_000);
});

describe.skipIf(!BENCH_ENABLED)('Kotlin Spring dynamic lookup end-to-end scaling', () => {
  it('keeps Kotlin pipeline lookup resolution sub-quadratic across file counts', async () => {
    await runPipelineBenchmark('kotlin', writeKotlinLookupRepo);
  }, 300_000);
});

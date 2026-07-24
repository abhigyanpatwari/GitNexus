/**
 * Spring standard-DI scaling benchmark (#2414 / PR #2632 review).
 *
 * Guards the two hot paths introduced by standard Spring injection:
 *
 *   1. Java and Kotlin capture emission collect DI facts from their existing
 *      scope-query traversals instead of recursively walking the AST root a
 *      second time.
 *   2. Post-resolution metadata attachment finds captured fields through the
 *      owning class scope's bindings instead of scanning every HAS_PROPERTY
 *      relationship in the graph.
 *
 * The normal-CI tripwires use dense Java/Kotlin files to catch a capture
 * re-regression. The gated suites measure Java and Kotlin capture plus
 * full-pipeline scaling:
 *
 *   GITNEXUS_BENCH=1 npx vitest run test/integration/spring-di-benchmark.test.ts
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

function denseSpringSource(consumerCount: number): string {
  const consumers = Array.from(
    { length: consumerCount },
    (_, index) => `
@Service
class Consumer${index} {
  @Autowired private Gateway field${index};

  Consumer${index}(@Qualifier("gatewayImpl") Gateway gateway) {}

  @Inject void setGateway(Gateway gateway) {}
}
`,
  ).join('\n');

  return `package com.example;
import org.springframework.stereotype.Service;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import jakarta.inject.Inject;

interface Gateway {}

@Service
class GatewayImpl implements Gateway {}

${consumers}
`;
}

interface CaptureBenchResult {
  consumers: number;
  elapsedMs: number;
  captureCount: number;
  factCount: number;
}

function runCaptureBenchmark(consumerCount: number, run: number): CaptureBenchResult {
  const filePath = `src/SpringDiBench${consumerCount}_${run}.java`;
  const start = performance.now();
  const captures = emitJavaScopeCaptures(denseSpringSource(consumerCount), filePath);
  const elapsedMs = performance.now() - start;
  const facts = collectJavaCaptureSideChannel(filePath)?.springDiFacts ?? [];
  return {
    consumers: consumerCount,
    elapsedMs,
    captureCount: captures.length,
    factCount: facts.length,
  };
}

function denseKotlinSpringSource(consumerCount: number): string {
  const consumers = Array.from(
    { length: consumerCount },
    (_, index) => `
@Service
class Consumer${index} @Autowired constructor(
  @param:Qualifier("gatewayImpl") gateway: Gateway,
) {
  @field:Autowired lateinit var field${index}: Gateway
  @Inject fun setGateway(gateway: Gateway) {}
}
`,
  ).join('\n');

  return `package com.example
import org.springframework.stereotype.Service
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.beans.factory.annotation.Qualifier
import jakarta.inject.Inject

interface Gateway

@Service
class GatewayImpl : Gateway

${consumers}
`;
}

function runKotlinCaptureBenchmark(consumerCount: number, run: number): CaptureBenchResult {
  const filePath = `src/SpringDiBench${consumerCount}_${run}.kt`;
  const start = performance.now();
  const captures = emitKotlinScopeCaptures(denseKotlinSpringSource(consumerCount), filePath);
  const elapsedMs = performance.now() - start;
  const facts = collectKotlinCaptureSideChannel(filePath)?.springDiFacts ?? [];
  return {
    consumers: consumerCount,
    elapsedMs,
    captureCount: captures.length,
    factCount: facts.length,
  };
}

describe('Spring DI capture O(n²) regression tripwire (#2414)', () => {
  it('captures a dense 400-consumer file within a coarse linear-time budget', () => {
    const consumers = 400;
    const budgetMs = 10_000;

    runCaptureBenchmark(4, 0);
    const result = runCaptureBenchmark(consumers, 1);

    expect(result.factCount).toBe(consumers + 1);
    expect(result.captureCount).toBeGreaterThan(consumers * 10);
    expect(result.elapsedMs).toBeLessThan(budgetMs);
  }, 30_000);

  it('captures a dense 400-consumer Kotlin file within a coarse linear-time budget', () => {
    const consumers = 400;
    const budgetMs = 10_000;

    runKotlinCaptureBenchmark(4, 0);
    const result = runKotlinCaptureBenchmark(consumers, 1);

    expect(result.factCount).toBe(consumers + 1);
    expect(result.captureCount).toBeGreaterThan(consumers * 8);
    expect(result.elapsedMs).toBeLessThan(budgetMs);
  }, 30_000);
});

describe.skipIf(!BENCH_ENABLED)('Spring DI capture scaling benchmark (#2414)', () => {
  it('scales sub-quadratically as classes and injection sites grow together', () => {
    const scales = [100, 200, 400];
    const repetitions = 4;
    const results: CaptureBenchResult[] = [];

    runCaptureBenchmark(8, 0);
    for (const consumers of scales) {
      let elapsedMs = 0;
      let captureCount = 0;
      let factCount = 0;
      for (let run = 0; run < repetitions; run++) {
        const current = runCaptureBenchmark(consumers, run + 1);
        elapsedMs += current.elapsedMs;
        captureCount = current.captureCount;
        factCount = current.factCount;
      }
      results.push({ consumers, elapsedMs, captureCount, factCount });
      console.log(
        `  capture n=${consumers} ×${repetitions}: ${elapsedMs.toFixed(1)}ms ` +
          `(${factCount} facts, ${captureCount} captures/run)`,
      );
    }

    const first = results[0];
    const last = results[results.length - 1];
    const sizeRatio = last.consumers / first.consumers;
    if (first.elapsedMs >= 20) {
      const wallRatio = last.elapsedMs / first.elapsedMs;
      expect(wallRatio).toBeLessThan(Math.pow(sizeRatio, 1.5));
    } else {
      expect(last.elapsedMs).toBeLessThan(10_000);
    }
    expect(last.factCount).toBe(last.consumers + 1);
  }, 120_000);
});

describe.skipIf(!BENCH_ENABLED)('Kotlin Spring DI capture scaling benchmark (#2414)', () => {
  it('scales sub-quadratically as classes and injection sites grow together', () => {
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
      console.log(
        `  kotlin capture n=${consumers} ×${repetitions}: ${elapsedMs.toFixed(1)}ms ` +
          `(${factCount} facts, ${captureCount} captures/run)`,
      );
    }

    const first = results[0];
    const last = results[results.length - 1];
    const sizeRatio = last.consumers / first.consumers;
    if (first.elapsedMs >= 20) {
      const wallRatio = last.elapsedMs / first.elapsedMs;
      expect(wallRatio).toBeLessThan(Math.pow(sizeRatio, 1.5));
    } else {
      expect(last.elapsedMs).toBeLessThan(10_000);
    }
    expect(last.factCount).toBe(last.consumers + 1);
  }, 120_000);
});

function writeSpringDiRepo(consumerCount: number): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `spring-di-bench-${consumerCount}-`));
  fs.writeFileSync(
    path.join(dir, 'Gateway.java'),
    `package com.example;
public interface Gateway {}
`,
  );
  fs.writeFileSync(
    path.join(dir, 'GatewayImpl.java'),
    `package com.example;
import org.springframework.stereotype.Service;
@Service
public class GatewayImpl implements Gateway {}
`,
  );
  for (let index = 0; index < consumerCount; index++) {
    fs.writeFileSync(
      path.join(dir, `Consumer${index}.java`),
      `package com.example;
import org.springframework.stereotype.Service;
@Service
public class Consumer${index} {
  public Consumer${index}(Gateway gateway) {}
}
`,
    );
  }
  return dir;
}

describe.skipIf(!BENCH_ENABLED)('Spring DI end-to-end scaling benchmark (#2414)', () => {
  it('keeps full-pipeline injection resolution sub-quadratic across file counts', async () => {
    const scales = [25, 50, 100];
    const results: Array<{ consumers: number; elapsedMs: number; injects: number }> = [];

    for (const consumers of scales) {
      const dir = writeSpringDiRepo(consumers);
      try {
        const start = performance.now();
        const result = await runPipelineFromRepo(dir, () => {}, {});
        const elapsedMs = performance.now() - start;
        const injects = [...result.graph.iterRelationshipsByType('INJECTS')].length;
        results.push({ consumers, elapsedMs, injects });
        console.log(
          `  pipeline n=${consumers}: ${elapsedMs.toFixed(1)}ms (${injects} INJECTS edges)`,
        );
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }

    for (const result of results) expect(result.injects).toBe(result.consumers);
    const first = results[0];
    const last = results[results.length - 1];
    const sizeRatio = last.consumers / first.consumers;
    const wallRatio = last.elapsedMs / first.elapsedMs;
    expect(wallRatio).toBeLessThan(Math.pow(sizeRatio, 1.5));
  }, 300_000);
});

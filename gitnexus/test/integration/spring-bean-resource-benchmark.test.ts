/**
 * Spring @Bean / @Resource scaling benchmark (#2413, #2633).
 *
 * The normal-CI tripwires protect the single-pass Java and Kotlin capture
 * paths. The gated benchmark exercises the complete graph pipeline, including
 * Bean provider indexing and Resource name-first lookup:
 *
 *   GITNEXUS_BENCH=1 npx vitest run test/integration/spring-bean-resource-benchmark.test.ts
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

interface CaptureResult {
  elapsedMs: number;
  captureCount: number;
  factoryCount: number;
  resourceCount: number;
}

function denseJavaSource(size: number): string {
  const factories = Array.from(
    { length: size },
    (_, index) => `  @Bean Gateway bean${index}() { return new GatewayImpl(); }`,
  ).join('\n');
  const consumers = Array.from(
    { length: size },
    (_, index) => `
class Consumer${index} {
  @Resource(name = "bean${index}") Gateway dependency;
}`,
  ).join('\n');
  return `package com.example;
import jakarta.annotation.Resource;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
interface Gateway {}
class GatewayImpl implements Gateway {}
@Configuration
class BenchConfiguration {
${factories}
}
${consumers}
`;
}

function denseKotlinSource(size: number): string {
  const factories = Array.from(
    { length: size },
    (_, index) => `  @Bean fun bean${index}(): Gateway = GatewayImpl()`,
  ).join('\n');
  const consumers = Array.from(
    { length: size },
    (_, index) => `
class Consumer${index} {
  @field:Resource(name = "bean${index}")
  lateinit var dependency: Gateway
}`,
  ).join('\n');
  return `package com.example
import jakarta.annotation.Resource
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
interface Gateway
class GatewayImpl : Gateway
@Configuration
class BenchConfiguration {
${factories}
}
${consumers}
`;
}

function runJavaCapture(size: number, run: number): CaptureResult {
  const filePath = `src/SpringBeanResource${size}_${run}.java`;
  const start = performance.now();
  const captures = emitJavaScopeCaptures(denseJavaSource(size), filePath);
  const elapsedMs = performance.now() - start;
  const facts = collectJavaCaptureSideChannel(filePath)?.springDiFacts ?? [];
  return {
    elapsedMs,
    captureCount: captures.length,
    factoryCount: facts.reduce((count, fact) => count + (fact.beanFactoryMethods?.length ?? 0), 0),
    resourceCount: facts.reduce((count, fact) => count + fact.injectionSites.length, 0),
  };
}

function runKotlinCapture(size: number, run: number): CaptureResult {
  const filePath = `src/SpringBeanResource${size}_${run}.kt`;
  const start = performance.now();
  const captures = emitKotlinScopeCaptures(denseKotlinSource(size), filePath);
  const elapsedMs = performance.now() - start;
  const facts = collectKotlinCaptureSideChannel(filePath)?.springDiFacts ?? [];
  return {
    elapsedMs,
    captureCount: captures.length,
    factoryCount: facts.reduce((count, fact) => count + (fact.beanFactoryMethods?.length ?? 0), 0),
    resourceCount: facts.reduce((count, fact) => count + fact.injectionSites.length, 0),
  };
}

describe('Spring Bean/Resource capture O(n²) regression tripwire (#2413, #2633)', () => {
  it('captures 400 Java factories and Resource sites within a coarse linear-time budget', () => {
    runJavaCapture(4, 0);
    const result = runJavaCapture(400, 1);

    expect(result.factoryCount).toBe(400);
    expect(result.resourceCount).toBe(400);
    expect(result.captureCount).toBeGreaterThan(3_200);
    expect(result.elapsedMs).toBeLessThan(10_000);
  }, 30_000);

  it('captures 400 Kotlin factories and Resource sites within a coarse linear-time budget', () => {
    runKotlinCapture(4, 0);
    const result = runKotlinCapture(400, 1);

    expect(result.factoryCount).toBe(400);
    expect(result.resourceCount).toBe(400);
    expect(result.captureCount).toBeGreaterThan(2_400);
    expect(result.elapsedMs).toBeLessThan(10_000);
  }, 30_000);
});

describe.skipIf(!BENCH_ENABLED)(
  'Spring Bean/Resource end-to-end scaling benchmark (#2413, #2633)',
  () => {
    it('keeps named Resource resolution sub-quadratic as providers and sites grow together', async () => {
      const scales = [25, 50, 100, 200];
      const results: Array<{
        size: number;
        elapsedMs: number;
        declarations: number;
        injections: number;
      }> = [];

      for (const size of scales) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), `spring-bean-resource-${size}-`));
        try {
          fs.writeFileSync(path.join(dir, 'Application.java'), denseJavaSource(size));
          const start = performance.now();
          const result = await runPipelineFromRepo(dir, () => {}, {});
          const elapsedMs = performance.now() - start;
          const declarations = [...result.graph.iterRelationshipsByType('DECLARES')].length;
          const injections = [...result.graph.iterRelationshipsByType('INJECTS')].length;
          results.push({ size, elapsedMs, declarations, injections });
          console.log(
            `  pipeline n=${size}: ${elapsedMs.toFixed(1)}ms ` +
              `(${declarations} declarations, ${injections} injections)`,
          );
        } finally {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      }

      for (const result of results) {
        expect(result.declarations).toBe(result.size);
        expect(result.injections).toBe(result.size);
      }
      const first = results[0];
      const last = results[results.length - 1];
      const sizeRatio = last.size / first.size;
      const wallRatio = last.elapsedMs / first.elapsedMs;
      expect(wallRatio).toBeLessThan(Math.pow(sizeRatio, 1.5));
    }, 300_000);
  },
);

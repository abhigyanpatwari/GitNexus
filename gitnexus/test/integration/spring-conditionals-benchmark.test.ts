/**
 * Spring condition/auto-configuration scaling guards (#2415).
 *
 * Java and Kotlin capture condition facts from the class nodes already visited
 * by their scope-query loops. Shared attachment indexes configuration keys
 * lazily once per graph, while metadata parsing is linear in declaration count.
 *
 * Normal CI runs coarse 400-class tripwires. Ratio assertions are gated because
 * scaling measurements are sensitive to shared-runner noise:
 *
 *   GITNEXUS_BENCH=1 npx vitest run test/integration/spring-conditionals-benchmark.test.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectJavaCaptureSideChannel } from '../../src/core/ingestion/languages/java/capture-side-channel.js';
import { emitJavaScopeCaptures } from '../../src/core/ingestion/languages/java/captures.js';
import { collectKotlinCaptureSideChannel } from '../../src/core/ingestion/languages/kotlin/capture-side-channel.js';
import { emitKotlinScopeCaptures } from '../../src/core/ingestion/languages/kotlin/captures.js';
import {
  parseSpringAutoConfigurationImports,
  parseSpringFactoriesAutoConfigurations,
} from '../../src/core/ingestion/pipeline-phases/spring-auto-configuration.js';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';

const BENCH_ENABLED = process.env.GITNEXUS_BENCH === '1';

interface CaptureResult {
  readonly classes: number;
  readonly elapsedMs: number;
  readonly facts: number;
  readonly captures: number;
}

function denseJavaConditions(classCount: number): string {
  const classes = Array.from(
    { length: classCount },
    (_, index) => `
@Configuration
@Profile("profile-${index}")
@ConditionalOnProperty(prefix = "feature.${index}", name = "enabled")
class JavaConfig${index} {
  @ConditionalOnClass(name = "com.example.Driver${index}")
  Object bean${index}() { return new Object(); }
}
`,
  ).join('\n');
  return `package com.example;
import org.springframework.boot.autoconfigure.condition.ConditionalOnClass;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Profile;
${classes}
`;
}

function denseKotlinConditions(classCount: number): string {
  const classes = Array.from(
    { length: classCount },
    (_, index) => `
@Configuration
@Profile("profile-${index}")
@ConditionalOnProperty(prefix = "feature.${index}", name = ["enabled"])
class KotlinConfig${index} {
  @ConditionalOnClass(name = ["com.example.Driver${index}"])
  fun bean${index}(): Any = Any()
}
`,
  ).join('\n');
  return `package com.example
import org.springframework.boot.autoconfigure.condition.ConditionalOnClass
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty
import org.springframework.context.annotation.Configuration
import org.springframework.context.annotation.Profile
${classes}
`;
}

function javaCaptureBenchmark(classCount: number, run: number): CaptureResult {
  const filePath = `src/SpringConditionBench${classCount}_${run}.java`;
  const start = performance.now();
  const captures = emitJavaScopeCaptures(denseJavaConditions(classCount), filePath);
  const elapsedMs = performance.now() - start;
  const facts = collectJavaCaptureSideChannel(filePath)?.springConditionalFacts ?? [];
  return { classes: classCount, elapsedMs, facts: facts.length, captures: captures.length };
}

function kotlinCaptureBenchmark(classCount: number, run: number): CaptureResult {
  const filePath = `src/SpringConditionBench${classCount}_${run}.kt`;
  const start = performance.now();
  const captures = emitKotlinScopeCaptures(denseKotlinConditions(classCount), filePath);
  const elapsedMs = performance.now() - start;
  const facts = collectKotlinCaptureSideChannel(filePath)?.springConditionalFacts ?? [];
  return { classes: classCount, elapsedMs, facts: facts.length, captures: captures.length };
}

describe('Spring condition capture O(n²) regression tripwires (#2415)', () => {
  it('captures a dense 400-class Java file within a coarse budget', () => {
    javaCaptureBenchmark(4, 0);
    const result = javaCaptureBenchmark(400, 1);
    expect(result.facts).toBe(800);
    expect(result.captures).toBeGreaterThan(400 * 6);
    expect(result.elapsedMs).toBeLessThan(10_000);
  }, 30_000);

  it('captures a dense 400-class Kotlin file within a coarse budget', () => {
    kotlinCaptureBenchmark(4, 0);
    const result = kotlinCaptureBenchmark(400, 1);
    expect(result.facts).toBe(800);
    expect(result.captures).toBeGreaterThan(400 * 5);
    expect(result.elapsedMs).toBeLessThan(10_000);
  }, 30_000);
});

function assertSubQuadratic(results: readonly CaptureResult[]): void {
  const first = results[0];
  const last = results.at(-1);
  if (first === undefined || last === undefined) throw new Error('benchmark results are empty');
  const sizeRatio = last.classes / first.classes;
  if (first.elapsedMs >= 20) {
    expect(last.elapsedMs / first.elapsedMs).toBeLessThan(Math.pow(sizeRatio, 1.5));
  } else {
    expect(last.elapsedMs).toBeLessThan(10_000);
  }
}

describe.skipIf(!BENCH_ENABLED)('Spring condition capture scaling (#2415)', () => {
  it('keeps Java and Kotlin capture sub-quadratic', () => {
    const scales = [100, 200, 400];
    const repetitions = 4;
    for (const [language, benchmark] of [
      ['java', javaCaptureBenchmark],
      ['kotlin', kotlinCaptureBenchmark],
    ] as const) {
      benchmark(8, 0);
      const results: CaptureResult[] = [];
      for (const classes of scales) {
        let elapsedMs = 0;
        let latest: CaptureResult | undefined;
        for (let run = 0; run < repetitions; run++) {
          latest = benchmark(classes, run + 1);
          elapsedMs += latest.elapsedMs;
        }
        if (latest === undefined) throw new Error('benchmark repetitions must be positive');
        const result = { ...latest, elapsedMs };
        results.push(result);
        console.log(
          `  ${language} condition capture n=${classes} ×${repetitions}: ` +
            `${elapsedMs.toFixed(1)}ms (${result.facts} facts)`,
        );
      }
      assertSubQuadratic(results);
      expect(results.at(-1)?.facts).toBe(800);
    }
  }, 180_000);

  it('keeps modern and legacy auto-configuration metadata parsing linear', () => {
    const scales = [2_000, 4_000, 8_000];
    const measurements: number[] = [];
    for (const scale of scales) {
      const imports = Array.from(
        { length: scale },
        (_, index) => `com.example.AutoConfiguration${index}`,
      ).join('\n');
      const factories =
        'org.springframework.boot.autoconfigure.EnableAutoConfiguration=' +
        imports.replaceAll('\n', ',');
      const start = performance.now();
      expect(parseSpringAutoConfigurationImports(imports)).toHaveLength(scale);
      expect(parseSpringFactoriesAutoConfigurations(factories)).toHaveLength(scale);
      const elapsedMs = performance.now() - start;
      measurements.push(elapsedMs);
      console.log(`  auto-config metadata n=${scale}: ${elapsedMs.toFixed(1)}ms`);
    }
    const first = measurements[0];
    const last = measurements.at(-1);
    if (first === undefined || last === undefined) throw new Error('benchmark results are empty');
    if (first >= 10) {
      expect(last / first).toBeLessThan(6);
    } else {
      expect(measurements.at(-1)).toBeLessThan(2_000);
    }
  }, 60_000);
});

function writeMixedConditionRepo(classCount: number): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `spring-condition-bench-${classCount}-`));
  fs.writeFileSync(path.join(dir, 'JavaConditions.java'), denseJavaConditions(classCount));
  fs.writeFileSync(path.join(dir, 'KotlinConditions.kt'), denseKotlinConditions(classCount));
  fs.writeFileSync(
    path.join(dir, 'application.properties'),
    Array.from({ length: classCount }, (_, index) => `feature.${index}.enabled=true`).join('\n'),
  );
  return dir;
}

function writeSparseLargeGraphRepo(unrelatedPropertyCount: number): string {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), `spring-condition-sparse-${unrelatedPropertyCount}-`),
  );
  fs.writeFileSync(
    path.join(dir, 'SparseJava.java'),
    `package com.example;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
@ConditionalOnProperty(prefix = "feature", name = "enabled")
class SparseJava {}
`,
  );
  fs.writeFileSync(
    path.join(dir, 'SparseKotlin.kt'),
    `package com.example
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty
@ConditionalOnProperty(prefix = "feature", name = ["enabled"])
class SparseKotlin
`,
  );
  fs.writeFileSync(
    path.join(dir, 'application.properties'),
    [
      'feature.enabled=true',
      ...Array.from(
        { length: unrelatedPropertyCount },
        (_, index) => `unrelated.property.${index}=value`,
      ),
    ].join('\n'),
  );
  const metadataDir = path.join(dir, 'META-INF', 'spring');
  fs.mkdirSync(metadataDir, { recursive: true });
  fs.writeFileSync(
    path.join(metadataDir, 'org.springframework.boot.autoconfigure.AutoConfiguration.imports'),
    'com.example.SparseJava\n',
  );
  return dir;
}

describe.skipIf(!BENCH_ENABLED)('Spring condition mixed-language pipeline scaling (#2415)', () => {
  it('keeps Java+Kotlin condition attachment sub-quadratic', async () => {
    const scales = [25, 50, 100];
    const results: Array<{ classes: number; elapsedMs: number; edges: number }> = [];
    for (const classes of scales) {
      const dir = writeMixedConditionRepo(classes);
      try {
        const start = performance.now();
        const result = await runPipelineFromRepo(dir, () => {}, { skipGraphPhases: true });
        const elapsedMs = performance.now() - start;
        const edges = [...result.graph.iterRelationshipsByType('CONDITIONAL_ON')].length;
        results.push({ classes, elapsedMs, edges });
        console.log(
          `  mixed condition pipeline n=${classes}×2: ${elapsedMs.toFixed(1)}ms ` +
            `(${edges} CONDITIONAL_ON edges)`,
        );
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
    for (const result of results) expect(result.edges).toBe(result.classes * 6);
    const first = results[0];
    const last = results.at(-1);
    if (first === undefined || last === undefined) throw new Error('benchmark results are empty');
    expect(last.elapsedMs / first.elapsedMs).toBeLessThan(
      Math.pow(last.classes / first.classes, 1.5),
    );
  }, 300_000);

  it('keeps sparse conditions linear as unrelated graph nodes grow', async () => {
    const scales = [1_000, 2_000, 4_000];
    const results: Array<{ nodes: number; elapsedMs: number }> = [];
    for (const unrelatedProperties of scales) {
      const dir = writeSparseLargeGraphRepo(unrelatedProperties);
      try {
        const start = performance.now();
        const result = await runPipelineFromRepo(dir, () => {}, { skipGraphPhases: true });
        const elapsedMs = performance.now() - start;
        expect([...result.graph.iterRelationshipsByType('CONDITIONAL_ON')]).toHaveLength(2);
        expect([...result.graph.iterRelationshipsByType('AUTO_REGISTERS')]).toHaveLength(1);
        results.push({ nodes: [...result.graph.iterNodes()].length, elapsedMs });
        console.log(
          `  sparse condition graph properties=${unrelatedProperties}: ` +
            `${elapsedMs.toFixed(1)}ms`,
        );
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
    const first = results[0];
    const last = results.at(-1);
    if (first === undefined || last === undefined) throw new Error('benchmark results are empty');
    const sizeRatio = last.nodes / first.nodes;
    if (first.elapsedMs >= 20) {
      expect(last.elapsedMs / first.elapsedMs).toBeLessThan(Math.pow(sizeRatio, 1.5));
    } else {
      expect(last.elapsedMs).toBeLessThan(15_000);
    }
  }, 300_000);
});

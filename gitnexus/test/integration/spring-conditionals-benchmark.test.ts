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
import type { GraphNode } from 'gitnexus-shared';
import { describe, expect, it } from 'vitest';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { collectJavaCaptureSideChannel } from '../../src/core/ingestion/languages/java/capture-side-channel.js';
import { emitJavaScopeCaptures } from '../../src/core/ingestion/languages/java/captures.js';
import { collectKotlinCaptureSideChannel } from '../../src/core/ingestion/languages/kotlin/capture-side-channel.js';
import { emitKotlinScopeCaptures } from '../../src/core/ingestion/languages/kotlin/captures.js';
import {
  classifySpringAutoConfigurationMetadata,
  parseSpringAutoConfigurationImports,
  parseSpringFactoriesAutoConfigurations,
  springAutoConfigurationPhase,
} from '../../src/core/ingestion/pipeline-phases/spring-auto-configuration.js';
import type { StructureOutput } from '../../src/core/ingestion/pipeline-phases/structure.js';
import type {
  PipelineContext,
  PhaseResult,
} from '../../src/core/ingestion/pipeline-phases/types.js';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import { generateId } from '../../src/lib/utils.js';

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

interface AutoConfigurationResolutionResult {
  readonly classes: number;
  readonly candidates: number;
  readonly elapsedMs: number;
  readonly totalMs: number;
}

async function autoConfigurationResolutionBenchmark(
  classCount: number,
  candidateCount: number,
): Promise<AutoConfigurationResolutionResult> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `spring-auto-config-bench-${classCount}-`));
  const metadataPath =
    'META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports';
  const content = Array.from(
    { length: candidateCount },
    (_, index) => `com.example.AutoConfiguration${index}`,
  ).join('\n');
  fs.mkdirSync(path.join(dir, path.dirname(metadataPath)), { recursive: true });
  fs.writeFileSync(path.join(dir, metadataPath), content);

  try {
    const graph = createKnowledgeGraph();
    graph.addNode({
      id: generateId('File', metadataPath),
      label: 'File',
      properties: { name: path.basename(metadataPath), filePath: metadataPath },
    });
    for (let index = 0; index < classCount; index++) {
      const qualifiedName = `com.example.AutoConfiguration${index}`;
      const node: GraphNode = {
        id: `Class:src/AutoConfiguration${index}.java:${qualifiedName}`,
        label: 'Class',
        properties: {
          name: `AutoConfiguration${index}`,
          qualifiedName,
          filePath: `src/AutoConfiguration${index}.java`,
        },
      };
      graph.addNode(node);
    }
    const structure: StructureOutput = {
      scannedFiles: [{ path: metadataPath, size: Buffer.byteLength(content) }],
      allPaths: [metadataPath],
      allPathSet: new Set([metadataPath]),
      totalFiles: 1,
    };
    const deps = new Map<string, PhaseResult<unknown>>([
      [
        'structure',
        {
          phaseName: 'structure',
          output: structure,
          durationMs: 0,
        },
      ],
    ]);
    const ctx = {
      repoPath: dir,
      graph,
      onProgress: () => {},
      pipelineStart: performance.now(),
    } as PipelineContext;

    // Re-run against the same immutable Class population and report the median
    // so GC/scheduler noise does not dominate this allocation-sensitive scan.
    const measurements: number[] = [];
    for (let run = 0; run < 5; run++) {
      const start = performance.now();
      const output = await springAutoConfigurationPhase.execute(ctx, deps);
      measurements.push(performance.now() - start);
      expect(output.autoConfigurations).toBe(candidateCount);
      expect(output.ambiguousAutoConfigurations).toBe(0);
    }
    const totalMs = measurements.reduce((sum, elapsedMs) => sum + elapsedMs, 0);
    measurements.sort((left, right) => left - right);
    return {
      classes: classCount,
      candidates: candidateCount,
      elapsedMs: measurements[Math.floor(measurements.length / 2)] ?? Number.POSITIVE_INFINITY,
      totalMs,
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe.skipIf(!BENCH_ENABLED)('Spring auto-configuration resolution scaling (#2415)', () => {
  it('classifies large unrelated file inventories without path-sized allocations', () => {
    const results: Array<{ files: number; totalMs: number }> = [];
    for (const files of [50_000, 100_000, 200_000]) {
      const paths = Array.from(
        { length: files },
        (_, index) => `module-${index}/src/main/java/com/example/Service${index}.java`,
      );
      const measurements: number[] = [];
      for (let run = 0; run < 5; run++) {
        let matches = 0;
        const start = performance.now();
        for (const filePath of paths) {
          if (classifySpringAutoConfigurationMetadata(filePath) !== null) matches++;
        }
        measurements.push(performance.now() - start);
        expect(matches).toBe(0);
      }
      const totalMs = measurements.reduce((sum, elapsedMs) => sum + elapsedMs, 0);
      measurements.sort((left, right) => left - right);
      const median = measurements[Math.floor(measurements.length / 2)] ?? Number.POSITIVE_INFINITY;
      results.push({ files, totalMs });
      console.log(`  auto-config path classification files=${files}: ${median.toFixed(1)}ms`);
      expect(median).toBeLessThan(2_000);
    }
    const first = results[0];
    const last = results.at(-1);
    if (first === undefined || last === undefined) throw new Error('benchmark results are empty');
    expect(last.totalMs / first.totalMs).toBeLessThan(Math.pow(last.files / first.files, 1.5));
  }, 60_000);

  it('keeps FQN indexing and candidate resolution linear as the Class graph grows', async () => {
    const results: AutoConfigurationResolutionResult[] = [];
    for (const classes of [10_000, 20_000, 40_000]) {
      const result = await autoConfigurationResolutionBenchmark(classes, 2_000);
      results.push(result);
      console.log(
        `  auto-config resolution classes=${classes}, candidates=${result.candidates}: ` +
          `${result.elapsedMs.toFixed(1)}ms`,
      );
    }

    const first = results[0];
    const last = results.at(-1);
    if (first === undefined || last === undefined) throw new Error('benchmark results are empty');
    const sizeRatio = last.classes / first.classes;
    expect(last.totalMs / first.totalMs).toBeLessThan(Math.pow(sizeRatio, 1.5));
  }, 120_000);
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
        expect([...result.graph.iterRelationshipsByType('DECLARES')]).toHaveLength(1);
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

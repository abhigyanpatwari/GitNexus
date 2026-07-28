/**
 * Standalone Spring condition/auto-configuration benchmark (#2415).
 *
 * Wall-clock measurements intentionally live outside Vitest: shared-runner
 * scheduling and machine load must not make integration tests flaky. Existing
 * unit/integration suites own deterministic correctness; the assertions here
 * only protect the synthetic benchmark setup while timings remain diagnostic.
 *
 * Run from gitnexus/:
 *
 *   node --import tsx bench/spring-conditionals/measure.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createKnowledgeGraph } from '../../src/core/graph/graph.ts';
import { collectJavaCaptureSideChannel } from '../../src/core/ingestion/languages/java/capture-side-channel.ts';
import { emitJavaScopeCaptures } from '../../src/core/ingestion/languages/java/captures.ts';
import { collectKotlinCaptureSideChannel } from '../../src/core/ingestion/languages/kotlin/capture-side-channel.ts';
import { emitKotlinScopeCaptures } from '../../src/core/ingestion/languages/kotlin/captures.ts';
import {
  classifySpringAutoConfigurationMetadata,
  parseSpringAutoConfigurationImports,
  parseSpringFactoriesAutoConfigurations,
  springAutoConfigurationPhase,
} from '../../src/core/ingestion/pipeline-phases/spring-auto-configuration.ts';
import { generateId } from '../../src/lib/utils.ts';

const CAPTURE_SCALES = [100, 200, 400];
const METADATA_SCALES = [2_000, 4_000, 8_000];
const PATH_SCALES = [50_000, 100_000, 200_000];
const CLASS_SCALES = [10_000, 20_000, 40_000];
const AUTO_CONFIGURATION_CANDIDATES = 2_000;
const REPETITIONS = 5;

function denseJavaConditions(classCount) {
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

function denseKotlinConditions(classCount) {
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

function elapsedMs(start) {
  return Number(process.hrtime.bigint() - start) / 1e6;
}

function median(samples) {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
}

function measure(repetitions, operation) {
  operation();
  const samples = [];
  let value;
  for (let run = 0; run < repetitions; run++) {
    const start = process.hrtime.bigint();
    value = operation();
    samples.push(elapsedMs(start));
  }
  return { medianMs: median(samples), samplesMs: samples, value };
}

function captureBenchmark(language) {
  const isJava = language === 'java';
  const emit = isJava ? emitJavaScopeCaptures : emitKotlinScopeCaptures;
  const collect = isJava ? collectJavaCaptureSideChannel : collectKotlinCaptureSideChannel;
  const source = isJava ? denseJavaConditions : denseKotlinConditions;
  const extension = isJava ? 'java' : 'kt';

  return CAPTURE_SCALES.map((classes) => {
    let run = 0;
    const result = measure(REPETITIONS, () => {
      const filePath = `src/SpringConditionBench${classes}_${run++}.${extension}`;
      const captures = emit(source(classes), filePath);
      const facts = collect(filePath)?.springConditionalFacts ?? [];
      return { captures: captures.length, facts: facts.length };
    });
    assert.equal(result.value?.facts, classes * 2);
    assert.ok((result.value?.captures ?? 0) > classes * (isJava ? 6 : 5));
    return {
      classes,
      median_ms: Number(result.medianMs.toFixed(2)),
      facts: result.value.facts,
      captures: result.value.captures,
    };
  });
}

function metadataParsingBenchmark() {
  return METADATA_SCALES.map((declarations) => {
    const imports = Array.from(
      { length: declarations },
      (_, index) => `com.example.AutoConfiguration${index}`,
    ).join('\n');
    const factories =
      'org.springframework.boot.autoconfigure.EnableAutoConfiguration=' +
      imports.replaceAll('\n', ',');
    const result = measure(REPETITIONS, () => ({
      modern: parseSpringAutoConfigurationImports(imports).length,
      legacy: parseSpringFactoriesAutoConfigurations(factories).length,
    }));
    assert.deepEqual(result.value, { modern: declarations, legacy: declarations });
    return {
      declarations,
      median_ms: Number(result.medianMs.toFixed(2)),
    };
  });
}

function pathClassificationBenchmark() {
  return PATH_SCALES.map((files) => {
    const paths = Array.from(
      { length: files },
      (_, index) => `module-${index}/src/main/java/com/example/Service${index}.java`,
    );
    const result = measure(REPETITIONS, () => {
      let matches = 0;
      for (const filePath of paths) {
        if (classifySpringAutoConfigurationMetadata(filePath) !== null) matches++;
      }
      return matches;
    });
    assert.equal(result.value, 0);
    return {
      files,
      median_ms: Number(result.medianMs.toFixed(2)),
    };
  });
}

async function autoConfigurationResolutionBenchmark(classCount) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `spring-auto-config-bench-${classCount}-`));
  const metadataPath =
    'META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports';
  const content = Array.from(
    { length: AUTO_CONFIGURATION_CANDIDATES },
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
      graph.addNode({
        id: `Class:src/AutoConfiguration${index}.java:${qualifiedName}`,
        label: 'Class',
        properties: {
          name: `AutoConfiguration${index}`,
          qualifiedName,
          filePath: `src/AutoConfiguration${index}.java`,
        },
      });
    }

    const structure = {
      scannedFiles: [{ path: metadataPath, size: Buffer.byteLength(content) }],
      allPaths: [metadataPath],
      allPathSet: new Set([metadataPath]),
      totalFiles: 1,
    };
    const deps = new Map([
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
      pipelineStart: Date.now(),
    };

    await springAutoConfigurationPhase.execute(ctx, deps);
    const samples = [];
    let output;
    for (let run = 0; run < REPETITIONS; run++) {
      const start = process.hrtime.bigint();
      output = await springAutoConfigurationPhase.execute(ctx, deps);
      samples.push(elapsedMs(start));
    }
    assert.equal(output?.autoConfigurations, AUTO_CONFIGURATION_CANDIDATES);
    assert.equal(output?.ambiguousAutoConfigurations, 0);
    return {
      classes: classCount,
      candidates: AUTO_CONFIGURATION_CANDIDATES,
      median_ms: Number(median(samples).toFixed(2)),
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  const resolution = [];
  for (const classes of CLASS_SCALES) {
    resolution.push(await autoConfigurationResolutionBenchmark(classes));
  }

  const results = {
    capture: {
      java: captureBenchmark('java'),
      kotlin: captureBenchmark('kotlin'),
    },
    metadata_parsing: metadataParsingBenchmark(),
    unrelated_path_classification: pathClassificationBenchmark(),
    class_fqn_resolution: resolution,
  };
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
}

await main();

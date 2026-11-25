import { runInSequence } from '../../../../test/helpers/run-in-sequence.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { emitJavaScopeCaptures } from '../../../../dist/core/ingestion/languages/java/captures.js';
import { collectJavaCaptureSideChannel } from '../../../../dist/core/ingestion/languages/java/capture-side-channel.js';
import { emitKotlinScopeCaptures } from '../../../../dist/core/ingestion/languages/kotlin/captures.js';
import { collectKotlinCaptureSideChannel } from '../../../../dist/core/ingestion/languages/kotlin/capture-side-channel.js';
import { runPipelineFromRepo } from '../../../../dist/core/ingestion/pipeline.js';

function denseSpringSource(consumerCount) {
  const consumers = Array.from(
    {
      length: consumerCount,
    },
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

function denseKotlinSpringSource(consumerCount) {
  const consumers = Array.from(
    {
      length: consumerCount,
    },
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

function writeSpringDiRepo(dir, consumerCount) {
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
}

function denseJavaSource(size) {
  const factories = Array.from(
    {
      length: size,
    },
    (_, index) => `  @Bean Gateway bean${index}() { return new GatewayImpl(); }`,
  ).join('\n');
  const consumers = Array.from(
    {
      length: size,
    },
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

function denseKotlinSource(size) {
  const factories = Array.from(
    {
      length: size,
    },
    (_, index) => `  @Bean fun bean${index}(): Gateway = GatewayImpl()`,
  ).join('\n');
  const consumers = Array.from(
    {
      length: size,
    },
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

function denseJavaLookupSource(consumerCount) {
  const consumers = Array.from(
    {
      length: consumerCount,
    },
    (_, index) => {
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
    },
  ).join('\n');
  return `package com.example;
interface Parent {}
class Impl implements Parent {}
${consumers}
`;
}

function denseKotlinLookupSource(consumerCount) {
  const consumers = Array.from(
    {
      length: consumerCount,
    },
    (_, index) => {
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
    },
  ).join('\n');
  return `package com.example
interface Parent
class Impl : Parent
${consumers}
`;
}

function writeJavaLookupRepo(dir, consumerCount) {
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
}

function writeKotlinLookupRepo(dir, consumerCount) {
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
}

function runCaptureBenchmark(consumerCount, run) {
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

function runKotlinCaptureBenchmark(consumerCount, run) {
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

function measureJavaCaptureScaling() {
  // scales sub-quadratically as classes and injection sites grow together

  const scales = [100, 200, 400];
  const repetitions = 4;
  const results = [];
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
    results.push({
      consumers,
      elapsedMs,
      captureCount,
      factCount,
    });
    console.log(
      `  capture n=${consumers} ×${repetitions}: ${elapsedMs.toFixed(1)}ms ` +
        `(${factCount} facts, ${captureCount} captures/run)`,
    );
  }
  const first = results[0];
  const last = results.at(-1);
  const sizeRatio = last.consumers / first.consumers;
  if (first.elapsedMs >= 20) {
    const wallRatio = last.elapsedMs / first.elapsedMs;
    assert.ok(wallRatio < Math.pow(sizeRatio, 1.5));
  } else {
    assert.ok(last.elapsedMs < 10_000);
  }
  assert.equal(last.factCount, last.consumers + 1);
}

function measureKotlinCaptureScaling() {
  // scales sub-quadratically as classes and injection sites grow together

  const scales = [100, 200, 400];
  const repetitions = 4;
  const results = [];
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
    results.push({
      consumers,
      elapsedMs,
      captureCount,
      factCount,
    });
    console.log(
      `  kotlin capture n=${consumers} ×${repetitions}: ${elapsedMs.toFixed(1)}ms ` +
        `(${factCount} facts, ${captureCount} captures/run)`,
    );
  }
  const first = results[0];
  const last = results.at(-1);
  const sizeRatio = last.consumers / first.consumers;
  if (first.elapsedMs >= 20) {
    const wallRatio = last.elapsedMs / first.elapsedMs;
    assert.ok(wallRatio < Math.pow(sizeRatio, 1.5));
  } else {
    assert.ok(last.elapsedMs < 10_000);
  }
  assert.equal(last.factCount, last.consumers + 1);
}

async function measureDiPipeline() {
  // keeps full-pipeline injection resolution sub-quadratic across file counts

  const scales = [25, 50, 100];
  const results = [];
  await runInSequence(scales, async (consumers) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `spring-di-bench-${consumers}-`));
    try {
      writeSpringDiRepo(dir, consumers);
      const start = performance.now();
      const result = await runPipelineFromRepo(dir, () => {}, {});
      const elapsedMs = performance.now() - start;
      const injects = [...result.graph.iterRelationshipsByType('INJECTS')].length;
      results.push({
        consumers,
        elapsedMs,
        injects,
      });
      console.log(
        `  pipeline n=${consumers}: ${elapsedMs.toFixed(1)}ms (${injects} INJECTS edges)`,
      );
    } finally {
      fs.rmSync(dir, {
        recursive: true,
        force: true,
      });
    }
  });
  for (const result of results) assert.equal(result.injects, result.consumers);
  const first = results[0];
  const last = results.at(-1);
  const sizeRatio = last.consumers / first.consumers;
  const wallRatio = last.elapsedMs / first.elapsedMs;
  assert.ok(wallRatio < Math.pow(sizeRatio, 1.5));
}

export async function verifyDiBenchmark() {
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
   *   GITNEXUS_BENCH=1 node tools/compiler-conformance/java/spring-check.mjs annotation-scaling
   */

  const BENCH_ENABLED = process.env.GITNEXUS_BENCH === '1';

  // Spring DI capture O(n²) regression tripwire (#2414)

  // captures a dense 400-consumer file within a coarse linear-time budget
  {
    const consumers = 400;
    const budgetMs = 10_000;
    runCaptureBenchmark(4, 0);
    const result = runCaptureBenchmark(consumers, 1);
    assert.equal(result.factCount, consumers + 1);
    assert.ok(result.captureCount > consumers * 10);
    assert.ok(result.elapsedMs < budgetMs);
  }
  // captures a dense 400-consumer Kotlin file within a coarse linear-time budget
  {
    const consumers = 400;
    const budgetMs = 10_000;
    runKotlinCaptureBenchmark(4, 0);
    const result = runKotlinCaptureBenchmark(consumers, 1);
    assert.equal(result.factCount, consumers + 1);
    assert.ok(result.captureCount > consumers * 8);
    assert.ok(result.elapsedMs < budgetMs);
  }
  // Spring DI capture scaling benchmark (#2414)

  // Kotlin Spring DI capture scaling benchmark (#2414)

  // Spring DI end-to-end scaling benchmark (#2414)

  if (!BENCH_ENABLED) return;
  measureJavaCaptureScaling();
  measureKotlinCaptureScaling();
  await measureDiPipeline();
}
export async function verifyBeanResourceBenchmark() {
  /**
   * Spring @Bean / @Resource scaling benchmark (#2413, #2633).
   *
   * The normal-CI tripwires protect the single-pass Java and Kotlin capture
   * paths. The gated benchmark exercises the complete graph pipeline, including
   * Bean provider indexing and Resource name-first lookup:
   *
   *   GITNEXUS_BENCH=1 node tools/compiler-conformance/java/spring-check.mjs annotation-scaling
   */

  const BENCH_ENABLED = process.env.GITNEXUS_BENCH === '1';

  function runJavaCapture(size, run) {
    const filePath = `src/SpringBeanResource${size}_${run}.java`;
    const start = performance.now();
    const captures = emitJavaScopeCaptures(denseJavaSource(size), filePath);
    const elapsedMs = performance.now() - start;
    const facts = collectJavaCaptureSideChannel(filePath)?.springDiFacts ?? [];
    return {
      elapsedMs,
      captureCount: captures.length,
      factoryCount: facts.reduce(
        (count, fact) => count + (fact.beanFactoryMethods?.length ?? 0),
        0,
      ),
      resourceCount: facts.reduce((count, fact) => count + fact.injectionSites.length, 0),
    };
  }
  function runKotlinCapture(size, run) {
    const filePath = `src/SpringBeanResource${size}_${run}.kt`;
    const start = performance.now();
    const captures = emitKotlinScopeCaptures(denseKotlinSource(size), filePath);
    const elapsedMs = performance.now() - start;
    const facts = collectKotlinCaptureSideChannel(filePath)?.springDiFacts ?? [];
    return {
      elapsedMs,
      captureCount: captures.length,
      factoryCount: facts.reduce(
        (count, fact) => count + (fact.beanFactoryMethods?.length ?? 0),
        0,
      ),
      resourceCount: facts.reduce((count, fact) => count + fact.injectionSites.length, 0),
    };
  }
  // Spring Bean/Resource capture O(n²) regression tripwire (#2413, #2633)

  // captures 400 Java factories and Resource sites within a coarse linear-time budget
  {
    runJavaCapture(4, 0);
    const result = runJavaCapture(400, 1);
    assert.equal(result.factoryCount, 400);
    assert.equal(result.resourceCount, 400);
    assert.ok(result.captureCount > 3_200);
    assert.ok(result.elapsedMs < 10_000);
  }
  // captures 400 Kotlin factories and Resource sites within a coarse linear-time budget
  {
    runKotlinCapture(4, 0);
    const result = runKotlinCapture(400, 1);
    assert.equal(result.factoryCount, 400);
    assert.equal(result.resourceCount, 400);
    assert.ok(result.captureCount > 2_400);
    assert.ok(result.elapsedMs < 10_000);
  }
  if (BENCH_ENABLED) // Spring Bean/Resource end-to-end scaling benchmark (#2413, #2633)
  {
    // keeps named Resource resolution sub-quadratic as providers and sites grow together

    const scales = [25, 50, 100, 200];
    const results = [];
    await runInSequence(scales, async (size) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), `spring-bean-resource-${size}-`));
      try {
        fs.writeFileSync(path.join(dir, 'Application.java'), denseJavaSource(size));
        const start = performance.now();
        const result = await runPipelineFromRepo(dir, () => {}, {});
        const elapsedMs = performance.now() - start;
        const declarations = [...result.graph.iterRelationshipsByType('DECLARES')].length;
        const injections = [...result.graph.iterRelationshipsByType('INJECTS')].length;
        results.push({
          size,
          elapsedMs,
          declarations,
          injections,
        });
        console.log(
          `  pipeline n=${size}: ${elapsedMs.toFixed(1)}ms ` +
            `(${declarations} declarations, ${injections} injections)`,
        );
      } finally {
        fs.rmSync(dir, {
          recursive: true,
          force: true,
        });
      }
    });
    for (const result of results) {
      assert.equal(result.declarations, result.size);
      assert.equal(result.injections, result.size);
    }
    const first = results[0];
    const last = results.at(-1);
    const sizeRatio = last.size / first.size;
    const wallRatio = last.elapsedMs / first.elapsedMs;
    assert.ok(wallRatio < Math.pow(sizeRatio, 1.5));
  }
}
export async function verifyDynamicLookupBenchmark() {
  /**
   * Spring programmatic lookup scaling for Java and Kotlin.
   *
   * Always-on tripwires catch a quadratic re-walk of every invocation in a dense
   * file. Gated suites measure capture and full-pipeline INJECTS resolution:
   *
   *   GITNEXUS_BENCH=1 node tools/compiler-conformance/java/spring-check.mjs annotation-scaling
   */

  const BENCH_ENABLED = process.env.GITNEXUS_BENCH === '1';
  const LOOKUPS_PER_CONSUMER = 2;
  // Time growth divided by input growth: linear work stays near 1.
  const LINEAR_SCALING_TOLERANCE = 1.5;

  function runJavaCaptureBenchmark(consumerCount, run) {
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

  function runKotlinCaptureBenchmark(consumerCount, run) {
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

  function assertCaptureScaling(results) {
    const first = results[0];
    const last = results[results.length - 1];
    assert.equal(last.factCount, last.consumers * LOOKUPS_PER_CONSUMER);
    const sizeRatio = last.consumers / first.consumers;
    if (first.elapsedMs >= 20) {
      const normalizedGrowth = last.elapsedMs / first.elapsedMs / sizeRatio;
      assert.ok(normalizedGrowth < LINEAR_SCALING_TOLERANCE);
    } else {
      assert.ok(last.elapsedMs < 10_000);
    }
  }

  async function runPipelineBenchmark(label, writeRepo) {
    const scales = [25, 50, 100];
    const results = [];
    await runInSequence(scales, async (consumers) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), `spring-dynamic-${label}-${consumers}-`));
      try {
        writeRepo(dir, consumers);
        const start = performance.now();
        const result = await runPipelineFromRepo(dir, () => {}, {});
        const elapsedMs = performance.now() - start;
        const injects = [...result.graph.iterRelationshipsByType('INJECTS')].length;
        results.push({
          consumers,
          elapsedMs,
          injects,
        });
        process.stdout.write(
          `  ${label} pipeline n=${consumers}: ${elapsedMs.toFixed(1)}ms (${injects} INJECTS edges)\n`,
        );
      } finally {
        fs.rmSync(dir, {
          recursive: true,
          force: true,
        });
      }
    });
    for (const result of results) assert.equal(result.injects, result.consumers);
    const first = results[0];
    const last = results.at(-1);
    const sizeRatio = last.consumers / first.consumers;
    const normalizedGrowth = last.elapsedMs / first.elapsedMs / sizeRatio;
    assert.ok(normalizedGrowth < LINEAR_SCALING_TOLERANCE);
  }
  // Spring dynamic lookup capture O(n²) regression tripwire

  // captures a dense 400-consumer Java file within a coarse linear-time budget
  {
    const consumers = 400;
    runJavaCaptureBenchmark(4, 0);
    const result = runJavaCaptureBenchmark(consumers, 1);
    assert.equal(result.factCount, consumers * LOOKUPS_PER_CONSUMER);
    assert.ok(result.captureCount > consumers * 8);
    assert.ok(result.elapsedMs < 10_000);
  }
  // captures a dense 400-consumer Kotlin file within a coarse linear-time budget
  {
    const consumers = 400;
    runKotlinCaptureBenchmark(4, 0);
    const result = runKotlinCaptureBenchmark(consumers, 1);
    assert.equal(result.factCount, consumers * LOOKUPS_PER_CONSUMER);
    assert.ok(result.captureCount > consumers * 8);
    assert.ok(result.elapsedMs < 10_000);
  }
  if (BENCH_ENABLED) // Java Spring dynamic lookup capture scaling
  {
    // scales sub-quadratically as Java lookup sites grow

    const scales = [100, 200, 400];
    const repetitions = 4;
    const results = [];
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
      results.push({
        consumers,
        elapsedMs,
        captureCount,
        factCount,
      });
      process.stdout.write(
        `  java capture n=${consumers} ×${repetitions}: ${elapsedMs.toFixed(1)}ms ` +
          `(${factCount} facts, ${captureCount} captures/run)\n`,
      );
    }
    assertCaptureScaling(results);
  }
  if (BENCH_ENABLED) // Kotlin Spring dynamic lookup capture scaling
  {
    // scales sub-quadratically as Kotlin lookup sites grow

    const scales = [100, 200, 400];
    const repetitions = 4;
    const results = [];
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
      results.push({
        consumers,
        elapsedMs,
        captureCount,
        factCount,
      });
      process.stdout.write(
        `  kotlin capture n=${consumers} ×${repetitions}: ${elapsedMs.toFixed(1)}ms ` +
          `(${factCount} facts, ${captureCount} captures/run)\n`,
      );
    }
    assertCaptureScaling(results);
  }
  if (BENCH_ENABLED) // Java Spring dynamic lookup end-to-end scaling
  {
    // keeps Java pipeline lookup resolution sub-quadratic across file counts

    await runPipelineBenchmark('java', writeJavaLookupRepo);
  }
  if (BENCH_ENABLED) // Kotlin Spring dynamic lookup end-to-end scaling
  {
    // keeps Kotlin pipeline lookup resolution sub-quadratic across file counts

    await runPipelineBenchmark('kotlin', writeKotlinLookupRepo);
  }
}

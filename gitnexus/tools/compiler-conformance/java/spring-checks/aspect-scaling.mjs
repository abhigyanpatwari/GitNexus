import { runInSequence } from '../../../../test/helpers/run-in-sequence.mjs';
import { compareCodeUnits } from '../../compare.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSpringAopCandidateIndex } from '../../../../dist/core/ingestion/frameworks/spring/aop-candidates.js';
import {
  decodeSpringAopReason,
  parseSpringAopPointcut,
  springAopPointcutMatches,
} from '../../../../dist/core/ingestion/frameworks/spring/aop.js';
import { collectKotlinCaptureSideChannel } from '../../../../dist/core/ingestion/languages/kotlin/capture-side-channel.js';
import { emitKotlinScopeCaptures } from '../../../../dist/core/ingestion/languages/kotlin/captures.js';
import { runPipelineFromRepo } from '../../../../dist/core/ingestion/pipeline.js';

function parsePointcut(expression) {
  const pointcut = parseSpringAopPointcut(expression);
  if (pointcut === null) throw new Error(`Expected a static pointcut: ${expression}`);
  return pointcut;
}

function matchingIds(pointcut, candidates, methodAnnotations) {
  return candidates
    .filter((candidate) =>
      springAopPointcutMatches(
        pointcut,
        candidate.owner,
        candidate.method,
        methodAnnotations.get(candidate.method.id),
      ),
    )
    .map((candidate) => candidate.method.id)
    .sort(compareCodeUnits);
}

function denseKotlinAopSource(classCount) {
  const classes = Array.from(
    {
      length: classCount,
    },
    (_, index) => {
      const transactional =
        index % 50 === 0
          ? `
  @Tx
  fun transactional${index}() {}`
          : '';
      return `
@Noise
class Subject${index} {
  @Noise
  fun ordinary${index}() {}

  @OtherNoise
  fun secondary${index}() {}
${transactional}
}
`;
    },
  ).join('\n');
  return `package com.example

import org.aspectj.lang.annotation.Aspect as AopAspect
import org.aspectj.lang.annotation.Before as AdviceBefore
import org.springframework.transaction.annotation.Transactional as Tx

@AopAspect
class DenseAspect {
  @AdviceBefore("@annotation(org.springframework.transaction.annotation.Transactional)")
  fun beforeTransaction() {}
}

${classes}
`;
}

function writeFixture(root, relativePath, content) {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), {
    recursive: true,
  });
  fs.writeFileSync(target, content);
}

function javaServices(count) {
  return Array.from(
    {
      length: count,
    },
    (_, index) => `
class JavaService${index} {
  @Transactional public void transaction${index}() {}
  public void read${index}() {}
  public void write${index}() {}
}
`,
  ).join('\n');
}

function kotlinServices(count) {
  return Array.from(
    {
      length: count,
    },
    (_, index) => `
class KotlinService${index} {
  @Tx fun transaction${index}() {}
  fun read${index}() {}
  fun write${index}() {}
}
`,
  ).join('\n');
}

function createRepoDir(serviceCount) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `spring-aop-bench-${serviceCount}-`));
}

function runKotlinAopCapture(classCount, run) {
  const filePath = `src/SpringAopBench${classCount}_${run}.kt`;
  const startedAt = performance.now();
  const captures = emitKotlinScopeCaptures(denseKotlinAopSource(classCount), filePath);
  const elapsedMs = performance.now() - startedAt;
  const facts = collectKotlinCaptureSideChannel(filePath)?.springAopFacts ?? [];
  return {
    classCount,
    elapsedMs,
    captureCount: captures.length,
    factCount: facts.length,
    annotationNames: facts.flatMap((fact) => fact.annotations.map((annotation) => annotation.name)),
  };
}

function writeMixedSpringAopRepo(root, serviceCount) {
  const javaCount = serviceCount / 2;
  const kotlinCount = serviceCount - javaCount;
  writeFixture(
    root,
    'src/main/java/com/example/service/Services.java',
    `package com.example.service;
import org.springframework.transaction.annotation.Transactional;
${javaServices(javaCount)}
`,
  );
  writeFixture(
    root,
    'src/main/kotlin/com/example/service/Services.kt',
    `package com.example.service
import org.springframework.transaction.annotation.Transactional as Tx
${kotlinServices(kotlinCount)}
`,
  );
  writeFixture(
    root,
    'src/main/java/com/example/aspect/BenchmarkAspect.java',
    `package com.example.aspect;
import org.aspectj.lang.annotation.Aspect;
import org.aspectj.lang.annotation.Before;

@Aspect
public class BenchmarkAspect {
  @Before("@annotation(org.springframework.transaction.annotation.Transactional)")
  public void transactionalAdvice() {}

  @Before("within(com.example.service.KotlinService*)")
  public void kotlinServiceAdvice() {}

  @Before("execution(public * com.example.service.JavaService*.read*(..))")
  public void javaReadAdvice() {}
}
`,
  );
}

export async function verifyAopBenchmark() {
  /**
   * Spring AOP candidate-selection and Kotlin capture benchmarks (#2416).
   *
   * Normal CI runs deterministic work-count tripwires. Wall-clock scaling and
   * mixed-language pipeline measurements stay behind the benchmark flag:
   *
   *   GITNEXUS_BENCH=1 node tools/compiler-conformance/java/spring-check.mjs aspect-scaling
   */

  const BENCH_ENABLED = process.env.GITNEXUS_BENCH === '1';
  const TRANSACTIONAL = 'org.springframework.transaction.annotation.Transactional';
  const CACHEABLE = 'org.springframework.cache.annotation.Cacheable';
  function addOwnerMethods(
    owner,
    { ownerIndex, methodsPerOwner, qualifiedName, extension, filePath, language },
    candidates,
    methodAnnotations,
  ) {
    for (let methodIndex = 0; methodIndex < methodsPerOwner; methodIndex += 1) {
      const name = `${methodIndex % 2 === 0 ? 'read' : 'write'}${methodIndex}`;
      const method = {
        id: `Method:${qualifiedName}.${name}:${extension}`,
        label: 'Method',
        properties: {
          name,
          qualifiedName: `${qualifiedName}.${name}`,
          filePath,
          language,
          startLine: methodIndex + 2,
          endLine: methodIndex + 2,
          isExported: true,
          visibility: methodIndex % 3 === 0 ? 'protected' : 'public',
          parameterCount: methodIndex % 3,
        },
      };
      candidates.push({
        method,
        owner,
      });
      const annotations = new Set();
      if (ownerIndex % 100 === 0 && methodIndex === 0) annotations.add(TRANSACTIONAL);
      if (ownerIndex % 125 === 1 && methodIndex === 1) annotations.add(CACHEABLE);
      if (annotations.size > 0) methodAnnotations.set(method.id, annotations);
    }
  }
  function candidateFixture(methodCount) {
    const methodsPerOwner = 10;
    if (methodCount % methodsPerOwner !== 0) {
      throw new Error(`methodCount must be divisible by ${methodsPerOwner}`);
    }
    const candidates = [];
    const methodAnnotations = new Map();
    for (let ownerIndex = 0; ownerIndex < methodCount / methodsPerOwner; ownerIndex += 1) {
      const language = ownerIndex % 2 === 0 ? 'java' : 'kotlin';
      const extension = language === 'java' ? 'java' : 'kt';
      const qualifiedName = `com.example.partition${ownerIndex % 100}.Service${ownerIndex}`;
      const filePath = `src/${language}/Service${ownerIndex}.${extension}`;
      const owner = {
        id: `Class:${qualifiedName}:${extension}`,
        label: 'Class',
        properties: {
          name: `Service${ownerIndex}`,
          qualifiedName,
          filePath,
          language,
          startLine: 1,
          endLine: 40,
          isExported: true,
        },
      };
      addOwnerMethods(
        owner,
        { ownerIndex, methodsPerOwner, qualifiedName, extension, filePath, language },
        candidates,
        methodAnnotations,
      );
    }
    return {
      candidates,
      methodAnnotations,
    };
  }

  function selectivePointcuts() {
    const partitions = [0, 7, 19, 42, 88];
    return [
      ...partitions.map((partition) =>
        parsePointcut(`within(com.example.partition${partition}..*)`),
      ),
      ...partitions.map((partition) =>
        parsePointcut(`execution(public * com.example.partition${partition}..*.read*(*))`),
      ),
      ...partitions.map((partition) =>
        parsePointcut(`within(com.example.partition${partition}.Service${partition})`),
      ),
      parsePointcut(`@annotation(${TRANSACTIONAL})`),
      parsePointcut(`@annotation(${CACHEABLE})`),
    ];
  }

  function runSelectorBenchmark(methods) {
    const fixture = candidateFixture(methods);
    const buildStartedAt = performance.now();
    const index = createSpringAopCandidateIndex(fixture.candidates, fixture.methodAnnotations);
    const buildMs = performance.now() - buildStartedAt;
    const pointcuts = selectivePointcuts();
    let examined = 0;
    let matches = 0;
    const queryStartedAt = performance.now();
    for (const pointcut of pointcuts) {
      const selected = index.candidatesFor(pointcut);
      examined += selected.length;
      matches += matchingIds(pointcut, selected, fixture.methodAnnotations).length;
    }
    const queryMs = performance.now() - queryStartedAt;
    return {
      methods,
      buildMs,
      queryMs,
      examined,
      matches,
    };
  }

  async function runMixedPipelineBenchmark(serviceCount) {
    const root = createRepoDir(serviceCount);
    try {
      writeMixedSpringAopRepo(root, serviceCount);
      const startedAt = performance.now();
      const result = await runPipelineFromRepo(root, () => {}, {
        skipGraphPhases: true,
        workerPoolSize: 1,
      });
      const elapsedMs = performance.now() - startedAt;
      const advisedBy = [...result.graph.iterRelationshipsByType('ADVISED_BY')];
      let behaviorEdges = 0;
      let adviceEdges = 0;
      for (const relationship of advisedBy) {
        const kind = decodeSpringAopReason(relationship.reason)?.kind;
        if (kind === 'behavior') behaviorEdges += 1;
        if (kind === 'advice') adviceEdges += 1;
      }
      const adviceEdgeCount = (name) =>
        advisedBy.filter(
          (relationship) =>
            decodeSpringAopReason(relationship.reason)?.kind === 'advice' &&
            result.graph.getNode(relationship.targetId)?.properties.name === name,
        ).length;
      return {
        services: serviceCount,
        elapsedMs,
        advisedBy: advisedBy.length,
        behaviorEdges,
        adviceEdges,
        transactionalAdviceEdges: adviceEdgeCount('transactionalAdvice'),
        kotlinAdviceEdges: adviceEdgeCount('kotlinServiceAdvice'),
        javaAdviceEdges: adviceEdgeCount('javaReadAdvice'),
      };
    } finally {
      fs.rmSync(root, {
        recursive: true,
        force: true,
      });
    }
  }
  // Spring AOP candidate-index regression tripwire (#2416)

  // preserves brute-force matches while reducing selective advice inspections by 10x
  const fixture = candidateFixture(50_000);
  const index = createSpringAopCandidateIndex(fixture.candidates, fixture.methodAnnotations);
  const pointcuts = selectivePointcuts();
  let indexedInspections = 0;
  for (const pointcut of pointcuts) {
    const selected = index.candidatesFor(pointcut);
    indexedInspections += selected.length;
    assert.deepStrictEqual(
      matchingIds(pointcut, selected, fixture.methodAnnotations),
      matchingIds(pointcut, fixture.candidates, fixture.methodAnnotations),
    );
  }
  const bruteForceInspections = pointcuts.length * fixture.candidates.length;
  assert.equal(index.totalCandidates, 50_000);
  assert.ok(indexedInspections <= bruteForceInspections / 10);
  const leadingWildcard = parsePointcut('within(*..Service*)');
  const broadCandidates = index.candidatesFor(leadingWildcard);
  assert.equal(broadCandidates.length, fixture.candidates.length);
  assert.deepStrictEqual(
    matchingIds(leadingWildcard, broadCandidates, fixture.methodAnnotations),
    matchingIds(leadingWildcard, fixture.candidates, fixture.methodAnnotations),
  );
  // Spring AOP broad-advice budget regression tripwire (#2416)

  // bounds aggregate edge work across multiple broad advices and reports truncation
  {
    const root = createRepoDir(20);
    const progressMessages = [];
    try {
      writeMixedSpringAopRepo(root, 20);
      const result = await runPipelineFromRepo(
        root,
        (progress) => progressMessages.push(progress.message),
        {
          skipGraphPhases: true,
          workerPoolSize: 1,
          springAopMaxCandidateInspectionsPerAdvice: 0,
          springAopMaxCandidateInspections: 0,
          springAopMaxAdvisedEdgesPerAdvice: 5,
          springAopMaxAdvisedEdges: 9,
        },
      );
      const adviceEdges = [...result.graph.iterRelationshipsByType('ADVISED_BY')].filter(
        (relationship) => decodeSpringAopReason(relationship.reason)?.kind === 'advice',
      );
      assert.equal(adviceEdges.length, 9);
      assert.ok(
        progressMessages.includes('Spring AOP advice resolution truncated by configured budgets'),
      );
    } finally {
      fs.rmSync(root, {
        recursive: true,
        force: true,
      });
    }
  }
  // bounds aggregate candidate inspections across multiple broad advices
  {
    const root = createRepoDir(20);
    const progressMessages = [];
    try {
      writeMixedSpringAopRepo(root, 20);
      const result = await runPipelineFromRepo(
        root,
        (progress) => progressMessages.push(progress.message),
        {
          skipGraphPhases: true,
          workerPoolSize: 1,
          springAopMaxCandidateInspectionsPerAdvice: 4,
          springAopMaxCandidateInspections: 7,
          springAopMaxAdvisedEdgesPerAdvice: 0,
          springAopMaxAdvisedEdges: 0,
        },
      );
      const adviceEdges = [...result.graph.iterRelationshipsByType('ADVISED_BY')].filter(
        (relationship) => decodeSpringAopReason(relationship.reason)?.kind === 'advice',
      );
      assert.equal(adviceEdges.length, 7);
      assert.ok(
        progressMessages.includes('Spring AOP advice resolution truncated by configured budgets'),
      );
    } finally {
      fs.rmSync(root, {
        recursive: true,
        force: true,
      });
    }
  }
  // Kotlin Spring AOP capture regression tripwire (#2416)

  // captures dense unrelated annotations and every Spring alias within a coarse budget

  const classCount = 400;
  const aliasedTransactionalCount = classCount / 50;
  const budgetMs = 10_000;
  runKotlinAopCapture(4, 0);
  const smaller = runKotlinAopCapture(classCount / 2, 1);
  const result = runKotlinAopCapture(classCount, 1);
  assert.equal(smaller.factCount, (classCount / 2) * 3 + aliasedTransactionalCount / 2 + 2);
  assert.equal(result.factCount, classCount * 3 + aliasedTransactionalCount + 2);
  assert.equal(result.annotationNames.filter((name) => name === 'Noise').length, classCount * 2);
  assert.equal(result.annotationNames.filter((name) => name === 'OtherNoise').length, classCount);
  assert.equal(
    result.annotationNames.filter((name) => name === 'Tx').length,
    aliasedTransactionalCount,
  );
  assert.equal(result.annotationNames.filter((name) => name === 'AopAspect').length, 1);
  assert.equal(result.annotationNames.filter((name) => name === 'AdviceBefore').length, 1);
  assert.ok(result.captureCount > classCount * 8);
  assert.ok(result.captureCount / smaller.captureCount > 1.9);
  assert.ok(result.captureCount / smaller.captureCount < 2.05);
  if (BENCH_ENABLED) assert.ok(result.elapsedMs < budgetMs);
  if (BENCH_ENABLED) // Spring AOP candidate-index scaling benchmark (#2416)
  {
    // reports build/query scaling while keeping selective work proportional to candidates

    const scales = [10_000, 50_000, 100_000];
    const results = scales.map((methods) => runSelectorBenchmark(methods));
    for (const result of results) {
      const bruteForceInspections = selectivePointcuts().length * result.methods;
      console.log(
        `  selector methods=${result.methods}: build=${result.buildMs.toFixed(1)}ms ` +
          `query=${result.queryMs.toFixed(1)}ms (${result.examined} examined, ` +
          `${result.matches} matches)`,
      );
      assert.ok(result.examined <= bruteForceInspections / 10);
      assert.ok(result.matches > 0);
      assert.ok(result.buildMs + result.queryMs < 10_000);
    }
    const first = results[0];
    const last = results.at(-1);
    const workRatio = last.examined / first.examined;
    const sizeRatio = last.methods / first.methods;
    assert.ok(workRatio > sizeRatio * 0.9);
    assert.ok(workRatio < sizeRatio * 1.1);
  }
  if (BENCH_ENABLED) // mixed Java/Kotlin Spring AOP pipeline benchmark (#2416)
  {
    // scales real behavior and advice materialization with exact ADVISED_BY counts

    const scales = [20, 40, 80];
    const results = [];
    await runInSequence(scales, async (services) => {
      const result = await runMixedPipelineBenchmark(services);
      results.push(result);
      console.log(
        `  pipeline services=${services}: ${result.elapsedMs.toFixed(1)}ms ` +
          `(${result.behaviorEdges} behavior, ${result.adviceEdges} advice edges)`,
      );
    });
    for (const result of results) {
      const javaServiceCount = result.services / 2;
      const kotlinServiceCount = result.services - javaServiceCount;
      assert.equal(result.behaviorEdges, result.services);
      assert.equal(result.transactionalAdviceEdges, result.services);
      assert.equal(result.kotlinAdviceEdges, kotlinServiceCount * 3);
      assert.equal(result.javaAdviceEdges, javaServiceCount);
      assert.equal(result.adviceEdges, result.services + kotlinServiceCount * 3 + javaServiceCount);
      assert.equal(result.advisedBy, result.behaviorEdges + result.adviceEdges);
      assert.ok(result.elapsedMs < 120_000);
    }
  }
}

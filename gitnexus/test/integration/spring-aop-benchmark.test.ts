/**
 * Spring AOP candidate-selection and Kotlin capture benchmarks (#2416).
 *
 * Normal CI runs deterministic work-count tripwires. Wall-clock scaling and
 * mixed-language pipeline measurements stay behind the benchmark flag:
 *
 *   GITNEXUS_BENCH=1 npx vitest run test/integration/spring-aop-benchmark.test.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { GraphNode } from 'gitnexus-shared';
import { describe, expect, it } from 'vitest';
import {
  createSpringAopCandidateIndex,
  type SpringAopOwnedMethod,
} from '../../src/core/ingestion/frameworks/spring/aop-candidates.js';
import {
  decodeSpringAopReason,
  parseSpringAopPointcut,
  springAopPointcutMatches,
  type SpringAopStaticPointcut,
} from '../../src/core/ingestion/frameworks/spring/aop.js';
import { collectKotlinCaptureSideChannel } from '../../src/core/ingestion/languages/kotlin/capture-side-channel.js';
import { emitKotlinScopeCaptures } from '../../src/core/ingestion/languages/kotlin/captures.js';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';

const BENCH_ENABLED = process.env.GITNEXUS_BENCH === '1';
const TRANSACTIONAL = 'org.springframework.transaction.annotation.Transactional';
const CACHEABLE = 'org.springframework.cache.annotation.Cacheable';

interface CandidateFixture {
  readonly candidates: readonly SpringAopOwnedMethod[];
  readonly methodAnnotations: ReadonlyMap<string, ReadonlySet<string>>;
}

function candidateFixture(methodCount: number): CandidateFixture {
  const methodsPerOwner = 10;
  if (methodCount % methodsPerOwner !== 0) {
    throw new Error(`methodCount must be divisible by ${methodsPerOwner}`);
  }

  const candidates: SpringAopOwnedMethod[] = [];
  const methodAnnotations = new Map<string, Set<string>>();
  for (let ownerIndex = 0; ownerIndex < methodCount / methodsPerOwner; ownerIndex += 1) {
    const language = ownerIndex % 2 === 0 ? 'java' : 'kotlin';
    const extension = language === 'java' ? 'java' : 'kt';
    const qualifiedName = `com.example.partition${ownerIndex % 100}.Service${ownerIndex}`;
    const filePath = `src/${language}/Service${ownerIndex}.${extension}`;
    const owner: GraphNode = {
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

    for (let methodIndex = 0; methodIndex < methodsPerOwner; methodIndex += 1) {
      const name = `${methodIndex % 2 === 0 ? 'read' : 'write'}${methodIndex}`;
      const method: GraphNode = {
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
      candidates.push({ method, owner });

      const annotations = new Set<string>();
      if (ownerIndex % 100 === 0 && methodIndex === 0) annotations.add(TRANSACTIONAL);
      if (ownerIndex % 125 === 1 && methodIndex === 1) annotations.add(CACHEABLE);
      if (annotations.size > 0) methodAnnotations.set(method.id, annotations);
    }
  }
  return { candidates, methodAnnotations };
}

function parsePointcut(expression: string): SpringAopStaticPointcut {
  const pointcut = parseSpringAopPointcut(expression);
  if (pointcut === null) throw new Error(`Expected a static pointcut: ${expression}`);
  return pointcut;
}

function matchingIds(
  pointcut: SpringAopStaticPointcut,
  candidates: readonly SpringAopOwnedMethod[],
  methodAnnotations: ReadonlyMap<string, ReadonlySet<string>>,
): string[] {
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
    .sort();
}

function selectivePointcuts(): SpringAopStaticPointcut[] {
  const partitions = [0, 7, 19, 42, 88];
  return [
    ...partitions.map((partition) => parsePointcut(`within(com.example.partition${partition}..*)`)),
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

describe('Spring AOP candidate-index regression tripwire (#2416)', () => {
  it('preserves brute-force matches while reducing selective advice inspections by 10x', () => {
    const fixture = candidateFixture(50_000);
    const index = createSpringAopCandidateIndex(fixture.candidates, fixture.methodAnnotations);
    const pointcuts = selectivePointcuts();
    let indexedInspections = 0;

    for (const pointcut of pointcuts) {
      const selected = index.candidatesFor(pointcut);
      indexedInspections += selected.length;
      expect(matchingIds(pointcut, selected, fixture.methodAnnotations)).toEqual(
        matchingIds(pointcut, fixture.candidates, fixture.methodAnnotations),
      );
    }

    const bruteForceInspections = pointcuts.length * fixture.candidates.length;
    expect(index.totalCandidates).toBe(50_000);
    expect(indexedInspections).toBeLessThanOrEqual(bruteForceInspections / 10);

    const leadingWildcard = parsePointcut('within(*..Service*)');
    const broadCandidates = index.candidatesFor(leadingWildcard);
    expect(broadCandidates).toHaveLength(fixture.candidates.length);
    expect(matchingIds(leadingWildcard, broadCandidates, fixture.methodAnnotations)).toEqual(
      matchingIds(leadingWildcard, fixture.candidates, fixture.methodAnnotations),
    );
  }, 30_000);
});

describe('Spring AOP broad-advice budget regression tripwire (#2416)', () => {
  it('bounds aggregate edge work across multiple broad advices and reports truncation', async () => {
    const root = writeMixedSpringAopRepo(20);
    const progressMessages: string[] = [];
    try {
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

      expect(adviceEdges).toHaveLength(9);
      expect(progressMessages).toContain(
        'Spring AOP advice resolution truncated by configured budgets',
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('bounds aggregate candidate inspections across multiple broad advices', async () => {
    const root = writeMixedSpringAopRepo(20);
    const progressMessages: string[] = [];
    try {
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

      expect(adviceEdges).toHaveLength(7);
      expect(progressMessages).toContain(
        'Spring AOP advice resolution truncated by configured budgets',
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});

function denseKotlinAopSource(classCount: number): string {
  const classes = Array.from({ length: classCount }, (_, index) => {
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
  }).join('\n');

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

interface KotlinCaptureResult {
  readonly classCount: number;
  readonly elapsedMs: number;
  readonly captureCount: number;
  readonly factCount: number;
  readonly annotationNames: readonly string[];
}

function runKotlinAopCapture(classCount: number, run: number): KotlinCaptureResult {
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

describe('Kotlin Spring AOP capture regression tripwire (#2416)', () => {
  it('captures dense unrelated annotations and every Spring alias within a coarse budget', () => {
    const classCount = 400;
    const aliasedTransactionalCount = classCount / 50;
    const budgetMs = 10_000;

    runKotlinAopCapture(4, 0);
    const smaller = runKotlinAopCapture(classCount / 2, 1);
    const result = runKotlinAopCapture(classCount, 1);

    expect(smaller.factCount).toBe((classCount / 2) * 3 + aliasedTransactionalCount / 2 + 2);
    expect(result.factCount).toBe(classCount * 3 + aliasedTransactionalCount + 2);
    expect(result.annotationNames.filter((name) => name === 'Noise')).toHaveLength(classCount * 2);
    expect(result.annotationNames.filter((name) => name === 'OtherNoise')).toHaveLength(classCount);
    expect(result.annotationNames.filter((name) => name === 'Tx')).toHaveLength(
      aliasedTransactionalCount,
    );
    expect(result.annotationNames.filter((name) => name === 'AopAspect')).toHaveLength(1);
    expect(result.annotationNames.filter((name) => name === 'AdviceBefore')).toHaveLength(1);
    expect(result.captureCount).toBeGreaterThan(classCount * 8);
    expect(result.captureCount / smaller.captureCount).toBeGreaterThan(1.9);
    expect(result.captureCount / smaller.captureCount).toBeLessThan(2.05);
    expect(result.elapsedMs).toBeLessThan(budgetMs);
  }, 30_000);
});

interface SelectorBenchResult {
  readonly methods: number;
  readonly buildMs: number;
  readonly queryMs: number;
  readonly examined: number;
  readonly matches: number;
}

function runSelectorBenchmark(methods: number): SelectorBenchResult {
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
  return { methods, buildMs, queryMs, examined, matches };
}

describe.skipIf(!BENCH_ENABLED)('Spring AOP candidate-index scaling benchmark (#2416)', () => {
  it('reports build/query scaling while keeping selective work proportional to candidates', () => {
    const scales = [10_000, 50_000, 100_000];
    const results = scales.map((methods) => runSelectorBenchmark(methods));

    for (const result of results) {
      const bruteForceInspections = selectivePointcuts().length * result.methods;
      console.log(
        `  selector methods=${result.methods}: build=${result.buildMs.toFixed(1)}ms ` +
          `query=${result.queryMs.toFixed(1)}ms (${result.examined} examined, ` +
          `${result.matches} matches)`,
      );
      expect(result.examined).toBeLessThanOrEqual(bruteForceInspections / 10);
      expect(result.matches).toBeGreaterThan(0);
      expect(result.buildMs + result.queryMs).toBeLessThan(10_000);
    }

    const first = results[0]!;
    const last = results[results.length - 1]!;
    const workRatio = last.examined / first.examined;
    const sizeRatio = last.methods / first.methods;
    expect(workRatio).toBeGreaterThan(sizeRatio * 0.9);
    expect(workRatio).toBeLessThan(sizeRatio * 1.1);
  }, 60_000);
});

function writeFixture(root: string, relativePath: string, content: string): void {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function javaServices(count: number): string {
  return Array.from(
    { length: count },
    (_, index) => `
class JavaService${index} {
  @Transactional public void transaction${index}() {}
  public void read${index}() {}
  public void write${index}() {}
}
`,
  ).join('\n');
}

function kotlinServices(count: number): string {
  return Array.from(
    { length: count },
    (_, index) => `
class KotlinService${index} {
  @Tx fun transaction${index}() {}
  fun read${index}() {}
  fun write${index}() {}
}
`,
  ).join('\n');
}

function writeMixedSpringAopRepo(serviceCount: number): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `spring-aop-bench-${serviceCount}-`));
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
  return root;
}

interface PipelineBenchResult {
  readonly services: number;
  readonly elapsedMs: number;
  readonly advisedBy: number;
  readonly behaviorEdges: number;
  readonly adviceEdges: number;
  readonly transactionalAdviceEdges: number;
  readonly kotlinAdviceEdges: number;
  readonly javaAdviceEdges: number;
}

async function runMixedPipelineBenchmark(serviceCount: number): Promise<PipelineBenchResult> {
  const root = writeMixedSpringAopRepo(serviceCount);
  try {
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
    const adviceEdgeCount = (name: string): number =>
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
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe.skipIf(!BENCH_ENABLED)('mixed Java/Kotlin Spring AOP pipeline benchmark (#2416)', () => {
  it('scales real behavior and advice materialization with exact ADVISED_BY counts', async () => {
    const scales = [20, 40, 80];
    const results: PipelineBenchResult[] = [];
    for (const services of scales) {
      const result = await runMixedPipelineBenchmark(services);
      results.push(result);
      console.log(
        `  pipeline services=${services}: ${result.elapsedMs.toFixed(1)}ms ` +
          `(${result.behaviorEdges} behavior, ${result.adviceEdges} advice edges)`,
      );
    }

    for (const result of results) {
      const javaServiceCount = result.services / 2;
      const kotlinServiceCount = result.services - javaServiceCount;
      expect(result.behaviorEdges).toBe(result.services);
      expect(result.transactionalAdviceEdges).toBe(result.services);
      expect(result.kotlinAdviceEdges).toBe(kotlinServiceCount * 3);
      expect(result.javaAdviceEdges).toBe(javaServiceCount);
      expect(result.adviceEdges).toBe(result.services + kotlinServiceCount * 3 + javaServiceCount);
      expect(result.advisedBy).toBe(result.behaviorEdges + result.adviceEdges);
      expect(result.elapsedMs).toBeLessThan(120_000);
    }
  }, 300_000);
});

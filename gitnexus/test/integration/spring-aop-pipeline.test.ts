import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { GraphNode, GraphRelationship } from 'gitnexus-shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decodeSpringAopReason } from '../../src/core/ingestion/frameworks/spring/aop.js';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import {
  loadParseCache,
  PARSE_CACHE_VERSION,
  pruneCache,
  saveParseCache,
  type ParseCache,
} from '../../src/storage/parse-cache.js';
import {
  getDurableParsedFileDir,
  pruneAndSaveDurableParsedFileStore,
} from '../../src/storage/parsedfile-store.js';
import type { PipelineResult } from '../../src/types/pipeline.js';

function writeFixture(root: string, relativePath: string, content: string): void {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

describe('Spring AOP, transaction, cache, and method-security pipeline (#2416)', () => {
  let dir: string;
  let result: PipelineResult;
  let nodes: GraphNode[];
  let advisedBy: GraphRelationship[];
  let declarations: GraphRelationship[];

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-spring-aop-'));
    writeFixture(
      dir,
      'src/main/java/com/example/service/OrderService.java',
      `package com.example.service;

import org.springframework.cache.annotation.CacheEvict;
import org.springframework.cache.annotation.Cacheable;
import org.springframework.security.access.annotation.Secured;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.transaction.annotation.Transactional;

public class OrderService {
  @Transactional
  public void transactionalOperation() {}

  @Cacheable("orders")
  public String cachedOperation() { return "cached"; }

  @CacheEvict(cacheNames = "orders", allEntries = true)
  public void evictOperation() {}

  @PreAuthorize("hasRole('ADMIN')")
  public void securedOperation() {}

  @Secured("ROLE_AUDITOR")
  public void legacySecuredOperation() {}

  public void plainOperation() {}
}
`,
    );
    writeFixture(
      dir,
      'src/main/java/com/example/service/SecuredOperations.java',
      `package com.example.service;

import org.springframework.security.access.prepost.PreAuthorize;

public interface SecuredOperations {
  @PreAuthorize("hasRole('OPERATOR')")
  void interfaceSecuredOperation();
}
`,
    );
    writeFixture(
      dir,
      'src/main/java/com/example/service/ClassLevelService.java',
      `package com.example.service;

import org.springframework.transaction.annotation.Transactional;

@Transactional
public class ClassLevelService {
  public void inheritedTransaction() {}
  private void privateHelper() {}
  public static void staticHelper() {}
}
`,
    );
    writeFixture(
      dir,
      'src/main/java/com/example/service/TransactionalOperations.java',
      `package com.example.service;

import org.springframework.transaction.annotation.Transactional;

@Transactional
public interface TransactionalOperations {
  void interfaceInheritedTransaction();
}
`,
    );
    writeFixture(
      dir,
      'src/main/java/com/example/aop/OrderAspect.java',
      `package com.example.aop;

import org.aspectj.lang.ProceedingJoinPoint;
import org.aspectj.lang.annotation.After;
import org.aspectj.lang.annotation.AfterReturning;
import org.aspectj.lang.annotation.Around;
import org.aspectj.lang.annotation.Aspect;
import org.aspectj.lang.annotation.Before;

@Aspect
public class OrderAspect {
  @Around("execution(* com.example..OrderService.*(..))")
  public Object traceOrderOperations(ProceedingJoinPoint joinPoint) throws Throwable {
    return joinPoint.proceed();
  }

  @Before("@annotation(org.springframework.transaction.annotation.Transactional)")
  public void transactionalAnnotationAdvice() {}

  @Before("within(*Service)")
  public void simpleNameWithinAdvice() {}

  @Before("execution(* *Service.kotlinCachedOperation(..))")
  public void simpleNameExecutionAdvice() {}

  @Before("within(OrderService)")
  public void unresolvedSimpleTypeAdvice() {}

  @AfterReturning(
      pointcut = "execution(* com.example..OrderService.cachedOperation(..))",
      returning = "result")
  public void cachedReturnAdvice(Object result) {}

  @Before("namedOrderOperations()")
  public void unresolvedNamedAdvice() {}

  @Before("")
  public void emptyPointcutAdvice() {}

  @After("execution(* com.example..OrderService.*(..)) && args(orderId)")
  public void unresolvedCompoundAdvice(String orderId) {}
}
`,
    );
    writeFixture(
      dir,
      'src/main/kotlin/com/example/aop/KotlinOrderAspect.kt',
      `package com.example.aop

import org.aspectj.lang.annotation.Aspect
import org.aspectj.lang.annotation.Before

@Aspect
object KotlinOrderAspect {
  @Before("within(com.example.service.KotlinOrderService)")
  fun traceKotlinOperations() {}

  @Before("within(com.example.service.KotlinObjectService)")
  fun traceKotlinObjectOperations() {}

  @Before("""execution(* com.example..KotlinOrderService.kotlinCachedOperation(..))""")
  fun rawStringPointcutAdvice() {}
}
`,
    );
    writeFixture(
      dir,
      'src/main/kotlin/com/example/service/KotlinOrderService.kt',
      `package com.example.service

import org.springframework.cache.annotation.CacheEvict
import org.springframework.cache.annotation.Cacheable
import org.springframework.security.access.annotation.Secured
import org.springframework.security.access.prepost.PreAuthorize
import org.springframework.transaction.annotation.Transactional

class KotlinOrderService {
  @Transactional
  fun kotlinTransactionalOperation() {}

  @Cacheable("orders")
  fun kotlinCachedOperation(): String = "cached"

  @CacheEvict(cacheNames = ["orders"], allEntries = true)
  fun kotlinEvictOperation() {}

  @PreAuthorize("hasRole('ADMIN')")
  fun kotlinSecuredOperation() {}

  @Secured("ROLE_AUDITOR")
  fun kotlinLegacySecuredOperation() {}

  @Transactional
  suspend fun kotlinSuspendTransaction() {}

  @Transactional
  fun String.kotlinExtensionTransaction() {}

  @org.springframework.transaction.annotation.Transactional
  fun kotlinFullyQualifiedTransaction() {}

  @Transactional
  private fun kotlinPrivateTransaction() {}
}

@Transactional
fun kotlinTopLevelTransaction() {}
`,
    );
    writeFixture(
      dir,
      'src/main/kotlin/com/example/service/KotlinObjectService.kt',
      `package com.example.service

import org.springframework.transaction.annotation.Transactional

interface KotlinObjectContract {
  fun kotlinObjectInheritedTransaction()
  fun kotlinObjectExplicitTransaction()
}

@Transactional
object KotlinObjectService : KotlinObjectContract {
  override fun kotlinObjectInheritedTransaction() {}

  @Transactional
  override fun kotlinObjectExplicitTransaction() {}

  private fun kotlinObjectPrivateHelper() {}
}
`,
    );
    writeFixture(
      dir,
      'src/main/kotlin/com/example/service/KotlinTransactionalOperations.kt',
      `package com.example.service

import org.springframework.security.access.prepost.PreAuthorize
import org.springframework.transaction.annotation.Transactional

@Transactional
interface KotlinTransactionalOperations {
  fun kotlinInterfaceInheritedTransaction()

  @PreAuthorize("hasRole('KOTLIN_OPERATOR')")
  fun kotlinInterfaceSecuredOperation()
}

interface KotlinMethodAnnotatedOperations {
  @Transactional
  fun kotlinInterfaceExplicitTransaction()
}
`,
    );
    writeFixture(
      dir,
      'src/main/kotlin/com/example/service/KotlinAliasedService.kt',
      `package com.example.service

import org.springframework.transaction.annotation.Transactional as Tx

class KotlinAliasedService {
  @Tx
  fun kotlinAliasedTransactionalOperation() {}

  fun kotlinAliasedPlainOperation() {}
}
`,
    );
    writeFixture(
      dir,
      'src/main/kotlin/com/example/aop/KotlinAliasedAspect.kt',
      `package com.example.aop

import org.aspectj.lang.annotation.Aspect as AopAspect
import org.aspectj.lang.annotation.Before as AdviceBefore

@AopAspect
object KotlinAliasedAspect {
  @AdviceBefore("@annotation(org.springframework.transaction.annotation.Transactional)")
  fun aliasedTransactionalAdvice() {}
}
`,
    );
    writeFixture(
      dir,
      'src/main/kotlin/com/example/service/KotlinWildcardService.kt',
      `package com.example.service

import org.springframework.transaction.annotation.*

class KotlinWildcardService {
  @Transactional
  fun kotlinWildcardTransaction() {}
}
`,
    );
    writeFixture(
      dir,
      'src/main/kotlin/com/example/service/KotlinScriptService.kts',
      `package com.example.service

import org.springframework.transaction.annotation.Transactional

class KotlinScriptService {
  @Transactional
  fun kotlinScriptTransaction() {}
}
`,
    );
    writeFixture(
      dir,
      'src/main/csharp/com/example/service/OrderService.cs',
      `namespace com.example.service {
  public class OrderService {
    public void foreignOperation() {}
  }
}
`,
    );

    result = await runPipelineFromRepo(dir, () => {}, { skipGraphPhases: true });
    nodes = [...result.graph.iterNodes()];
    advisedBy = [...result.graph.iterRelationshipsByType('ADVISED_BY')];
    declarations = [...result.graph.iterRelationshipsByType('DECLARES')];
  }, 60_000);

  afterAll(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  const nodeNamed = (name: string): GraphNode | undefined =>
    nodes.find((node) => node.properties.name === name);

  const relationshipTarget = (relationship: GraphRelationship): GraphNode | undefined =>
    result.graph.getNode(relationship.targetId);

  const methodNamedOn = (ownerName: string, methodName: string): GraphNode | undefined => {
    const owner = nodeNamed(ownerName);
    const ownership = [...result.graph.iterRelationshipsByType('HAS_METHOD')].find(
      (relationship) =>
        relationship.sourceId === owner?.id &&
        result.graph.getNode(relationship.targetId)?.properties.name === methodName,
    );
    return ownership === undefined ? undefined : result.graph.getNode(ownership.targetId);
  };

  const declarativeAdviceForNode = (source: GraphNode | undefined): GraphRelationship[] => {
    if (source === undefined) return [];
    return advisedBy.filter(
      (relationship) =>
        relationship.sourceId === source.id &&
        relationshipTarget(relationship)?.label === 'CodeElement',
    );
  };

  const declarativeAdviceFor = (name: string): GraphRelationship[] =>
    declarativeAdviceForNode(nodeNamed(name));

  const behaviorSignaturesForNode = (node: GraphNode | undefined): string[] =>
    declarativeAdviceForNode(node)
      .flatMap((relationship) => {
        const reason = decodeSpringAopReason(relationship.reason);
        return reason?.kind === 'behavior' ? [`${reason.annotation}:${reason.declaredOn}`] : [];
      })
      .sort();

  const behaviorSignaturesFor = (name: string): string[] =>
    behaviorSignaturesForNode(nodeNamed(name));

  it('attaches Java and Kotlin declarative behavior as explicit ADVISED_BY evidence', () => {
    const methodNames = [
      'transactionalOperation',
      'cachedOperation',
      'evictOperation',
      'securedOperation',
      'legacySecuredOperation',
      'interfaceSecuredOperation',
      'kotlinTransactionalOperation',
      'kotlinCachedOperation',
      'kotlinEvictOperation',
      'kotlinSecuredOperation',
      'kotlinLegacySecuredOperation',
      'kotlinSuspendTransaction',
      'kotlinExtensionTransaction',
      'kotlinFullyQualifiedTransaction',
    ];

    for (const methodName of methodNames) {
      const edges = declarativeAdviceFor(methodName);
      expect(edges, `${methodName} should retain its declarative Spring behavior`).toHaveLength(1);
      expect(decodeSpringAopReason(edges[0]?.reason)?.kind).toBe('behavior');
      expect(edges.map((edge) => relationshipTarget(edge)?.label)).toEqual(['CodeElement']);
    }
  });

  it('stores synthetic evidence locations in the graph zero-based line convention', () => {
    const evidence = relationshipTarget(declarativeAdviceFor('transactionalOperation')[0]!);

    // @Transactional is on source line 10 in OrderService.java.
    expect(evidence?.properties.startLine).toBe(9);
    expect(evidence?.properties.endLine).toBe(9);
  });

  it('fans class-level behavior out only to proxy-eligible methods', () => {
    expect(declarativeAdviceFor('ClassLevelService')).toHaveLength(1);
    expect(declarativeAdviceFor('inheritedTransaction')).toHaveLength(1);
    expect(declarativeAdviceFor('privateHelper')).toHaveLength(0);
    expect(declarativeAdviceFor('staticHelper')).toHaveLength(0);
    expect(declarativeAdviceFor('TransactionalOperations')).toHaveLength(1);
    expect(declarativeAdviceFor('interfaceInheritedTransaction')).toHaveLength(1);
  });

  it('captures Kotlin interface class fan-out and method-declared behaviors', () => {
    expect(nodeNamed('KotlinTransactionalOperations')?.label).toBe('Interface');
    expect(nodeNamed('KotlinMethodAnnotatedOperations')?.label).toBe('Interface');

    expect(behaviorSignaturesFor('KotlinTransactionalOperations')).toEqual([
      'org.springframework.transaction.annotation.Transactional:class',
    ]);
    expect(behaviorSignaturesFor('kotlinInterfaceInheritedTransaction')).toEqual([
      'org.springframework.transaction.annotation.Transactional:class',
    ]);
    expect(behaviorSignaturesFor('kotlinInterfaceSecuredOperation')).toEqual([
      'org.springframework.security.access.prepost.PreAuthorize:method',
      'org.springframework.transaction.annotation.Transactional:class',
    ]);
    expect(behaviorSignaturesFor('kotlinInterfaceExplicitTransaction')).toEqual([
      'org.springframework.transaction.annotation.Transactional:method',
    ]);
    expect(behaviorSignaturesFor('kotlinPrivateTransaction')).toEqual([]);
    expect(nodeNamed('kotlinTopLevelTransaction')?.label).toBe('Function');
    expect(behaviorSignaturesFor('kotlinTopLevelTransaction')).toEqual([]);
    expect(behaviorSignaturesFor('kotlinWildcardTransaction')).toEqual([
      'org.springframework.transaction.annotation.Transactional:method',
    ]);
    expect(behaviorSignaturesFor('kotlinScriptTransaction')).toEqual([
      'org.springframework.transaction.annotation.Transactional:method',
    ]);
  });

  it('treats Kotlin object members as singleton instance methods for AOP', () => {
    expect(behaviorSignaturesFor('KotlinObjectService')).toEqual([
      'org.springframework.transaction.annotation.Transactional:class',
    ]);
    expect(
      behaviorSignaturesForNode(
        methodNamedOn('KotlinObjectService', 'kotlinObjectInheritedTransaction'),
      ),
    ).toEqual(['org.springframework.transaction.annotation.Transactional:class']);
    expect(
      behaviorSignaturesForNode(
        methodNamedOn('KotlinObjectService', 'kotlinObjectExplicitTransaction'),
      ),
    ).toEqual([
      'org.springframework.transaction.annotation.Transactional:class',
      'org.springframework.transaction.annotation.Transactional:method',
    ]);
    expect(behaviorSignaturesFor('kotlinObjectPrivateHelper')).toEqual([]);

    const objectAdvice = nodeNamed('traceKotlinObjectOperations');
    const advisedMethods = advisedBy
      .filter((relationship) => relationship.targetId === objectAdvice?.id)
      .map((relationship) => result.graph.getNode(relationship.sourceId)?.properties.name)
      .sort();
    expect(advisedMethods).toEqual([
      'kotlinObjectExplicitTransaction',
      'kotlinObjectInheritedTransaction',
    ]);
  });

  it('resolves Kotlin aliases for behaviors, aspects, and advice annotations', () => {
    expect(behaviorSignaturesFor('kotlinAliasedTransactionalOperation')).toEqual([
      'org.springframework.transaction.annotation.Transactional:method',
    ]);

    const aliasedAspect = nodeNamed('KotlinAliasedAspect');
    const aspectMarker = declarations.find((relationship) => {
      const reason = decodeSpringAopReason(relationship.reason);
      return relationship.sourceId === aliasedAspect?.id && reason?.kind === 'aspect';
    });
    expect(aspectMarker).toBeDefined();

    const advice = nodeNamed('aliasedTransactionalAdvice');
    const advisedMethods = advisedBy
      .filter((relationship) => relationship.targetId === advice?.id)
      .map((relationship) => result.graph.getNode(relationship.sourceId)?.properties.name)
      .sort();
    expect(advisedMethods).toEqual([
      'kotlinAliasedTransactionalOperation',
      'kotlinExtensionTransaction',
      'kotlinFullyQualifiedTransaction',
      'kotlinInterfaceExplicitTransaction',
      'kotlinObjectExplicitTransaction',
      'kotlinScriptTransaction',
      'kotlinSuspendTransaction',
      'kotlinTransactionalOperation',
      'kotlinWildcardTransaction',
      'transactionalOperation',
    ]);
  });

  it('connects a statically understandable execution pointcut to every matching method', () => {
    const advice = nodeNamed('traceOrderOperations');
    expect(advice?.label).toBe('Method');

    const advisedMethods = advisedBy
      .filter((relationship) => relationship.targetId === advice?.id)
      .map((relationship) => String(result.graph.getNode(relationship.sourceId)?.properties.name))
      .sort();

    expect(advisedMethods).toEqual([
      'cachedOperation',
      'evictOperation',
      'legacySecuredOperation',
      'plainOperation',
      'securedOperation',
      'transactionalOperation',
    ]);

    const foreignMethod = nodeNamed('foreignOperation');
    const foreignOwnership = [...result.graph.iterRelationshipsByType('HAS_METHOD')].find(
      (relationship) => relationship.targetId === foreignMethod?.id,
    );
    expect(foreignMethod?.label).toBe('Method');
    expect(result.graph.getNode(foreignOwnership?.sourceId ?? '')?.properties.qualifiedName).toBe(
      'com.example.service.OrderService',
    );
    expect(advisedBy.some((relationship) => relationship.sourceId === foreignMethod?.id)).toBe(
      false,
    );

    const kotlinAdvice = nodeNamed('traceKotlinOperations');
    const kotlinAdvisedMethods = advisedBy
      .filter((relationship) => relationship.targetId === kotlinAdvice?.id)
      .map((relationship) => String(result.graph.getNode(relationship.sourceId)?.properties.name))
      .sort();
    expect(kotlinAdvisedMethods).toEqual([
      'kotlinCachedOperation',
      'kotlinEvictOperation',
      'kotlinExtensionTransaction',
      'kotlinFullyQualifiedTransaction',
      'kotlinLegacySecuredOperation',
      'kotlinSecuredOperation',
      'kotlinSuspendTransaction',
      'kotlinTransactionalOperation',
    ]);
  });

  it('matches unqualified wildcard type patterns by owner simple name', () => {
    const withinAdvice = nodeNamed('simpleNameWithinAdvice');
    const withinTargets = advisedBy
      .filter((relationship) => relationship.targetId === withinAdvice?.id)
      .map((relationship) => result.graph.getNode(relationship.sourceId)?.properties.name);
    expect(withinTargets).toContain('plainOperation');
    expect(withinTargets).toContain('kotlinCachedOperation');
    expect(withinTargets).not.toContain('kotlinInterfaceInheritedTransaction');

    const executionAdvice = nodeNamed('simpleNameExecutionAdvice');
    const executionTargets = advisedBy
      .filter((relationship) => relationship.targetId === executionAdvice?.id)
      .map((relationship) => result.graph.getNode(relationship.sourceId)?.properties.name);
    expect(executionTargets).toEqual(['kotlinCachedOperation']);
  });

  it('@annotation matches only directly declared method annotations across Java and Kotlin', () => {
    const transactionalAdvice = nodeNamed('transactionalAnnotationAdvice');

    const advisedByTransactionalAnnotation = advisedBy
      .filter((relationship) => relationship.targetId === transactionalAdvice?.id)
      .map((relationship) => result.graph.getNode(relationship.sourceId)?.properties.name)
      .sort();
    expect(advisedByTransactionalAnnotation).toEqual([
      'kotlinAliasedTransactionalOperation',
      'kotlinExtensionTransaction',
      'kotlinFullyQualifiedTransaction',
      'kotlinInterfaceExplicitTransaction',
      'kotlinObjectExplicitTransaction',
      'kotlinScriptTransaction',
      'kotlinSuspendTransaction',
      'kotlinTransactionalOperation',
      'kotlinWildcardTransaction',
      'transactionalOperation',
    ]);
    expect(advisedByTransactionalAnnotation).not.toContain('kotlinInterfaceInheritedTransaction');
  });

  it('supports pointcuts with companion annotation attributes', () => {
    const cachedReturnAdvice = nodeNamed('cachedReturnAdvice');

    const advisedByCachedReturn = advisedBy
      .filter((relationship) => relationship.targetId === cachedReturnAdvice?.id)
      .map((relationship) => result.graph.getNode(relationship.sourceId)?.properties.name);
    expect(advisedByCachedReturn).toEqual(['cachedOperation']);
  });

  it('resolves Kotlin raw-string advice pointcuts', () => {
    const rawStringAdvice = nodeNamed('rawStringPointcutAdvice');
    const advisedMethods = advisedBy
      .filter((relationship) => relationship.targetId === rawStringAdvice?.id)
      .map((relationship) => result.graph.getNode(relationship.sourceId)?.properties.name);

    expect(advisedMethods).toEqual(['kotlinCachedOperation']);
  });

  it('retains the Aspect declaration without assuming bean registration', () => {
    for (const aspectName of ['OrderAspect', 'KotlinOrderAspect']) {
      const aspect = nodeNamed(aspectName);
      const marker = declarations.find((relationship) => {
        const reason = decodeSpringAopReason(relationship.reason);
        return relationship.sourceId === aspect?.id && reason?.kind === 'aspect';
      });

      expect(marker, `${aspectName} should retain its Aspect marker`).toBeDefined();
      expect(decodeSpringAopReason(marker?.reason)).toMatchObject({
        kind: 'aspect',
        activation: 'unknown',
        registration: 'unknown',
      });
    }
  });

  it('preserves unknown pointcuts as evidence without guessing advised targets', () => {
    for (const adviceName of [
      'unresolvedNamedAdvice',
      'emptyPointcutAdvice',
      'unresolvedCompoundAdvice',
      'unresolvedSimpleTypeAdvice',
    ]) {
      const advice = nodeNamed(adviceName);
      expect(advice?.label).toBe('Method');
      expect(advisedBy.some((relationship) => relationship.targetId === advice?.id)).toBe(false);

      const evidence = declarations.filter((relationship) => {
        const reason = decodeSpringAopReason(relationship.reason);
        return (
          relationship.sourceId === advice?.id &&
          relationshipTarget(relationship)?.label === 'CodeElement' &&
          reason?.kind === 'pointcut' &&
          reason.match === 'unresolved' &&
          reason.resolution === 'unknown'
        );
      });
      expect(evidence, `${adviceName} should retain conservative pointcut evidence`).toHaveLength(
        1,
      );
    }
  });
});

describe('Spring AOP durable warm parse cache (#2416)', () => {
  it('replays identical Java/Kotlin ADVISED_BY edges without spawning workers', async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-spring-aop-warm-'));
    const repo = path.join(temp, 'repo');
    const storage = path.join(temp, 'storage');
    try {
      writeFixture(
        repo,
        'src/main/java/com/example/JavaService.java',
        `package com.example;

import org.springframework.transaction.annotation.Transactional;

public class JavaService {
  @Transactional
  public void javaTransaction() {}
}
`,
      );
      writeFixture(
        repo,
        'src/main/kotlin/com/example/KotlinAop.kt',
        `package com.example

import org.aspectj.lang.annotation.Aspect as AopAspect
import org.aspectj.lang.annotation.Before as AdviceBefore
import org.springframework.transaction.annotation.Transactional as Tx

class KotlinService {
  @Tx
  fun kotlinTransaction() {}
}

@AopAspect
object KotlinAspect {
  @AdviceBefore("""@annotation(org.springframework.transaction.annotation.Transactional)""")
  fun beforeTransaction() {}
}
`,
      );

      const coldCache: ParseCache = {
        version: PARSE_CACHE_VERSION,
        entries: new Map(),
        usedKeys: new Set(),
        storagePath: storage,
        onDiskKeys: new Set(),
      };
      const cold = await runPipelineFromRepo(repo, () => {}, {
        skipGraphPhases: true,
        workerPoolSize: 1,
        parseCache: coldCache,
      });
      expect(cold.usedWorkerPool).toBe(true);

      pruneCache(coldCache, coldCache.usedKeys);
      const savedKeys = await saveParseCache(storage, coldCache);
      expect(savedKeys.length).toBeGreaterThan(0);
      await pruneAndSaveDurableParsedFileStore(
        getDurableParsedFileDir(storage),
        PARSE_CACHE_VERSION,
        new Set(savedKeys),
      );

      const warmCache = await loadParseCache(storage);
      expect(warmCache.onDiskKeys).toEqual(new Set(savedKeys));
      const warm = await runPipelineFromRepo(repo, () => {}, {
        skipGraphPhases: true,
        workerPoolSize: 1,
        parseCache: warmCache,
      });
      expect(warm.usedWorkerPool).toBe(false);

      const project = (pipeline: PipelineResult) =>
        [...pipeline.graph.iterRelationshipsByType('ADVISED_BY')]
          .flatMap((edge) => {
            const reason = decodeSpringAopReason(edge.reason);
            if (reason?.kind !== 'behavior' && reason?.kind !== 'advice') return [];
            const source = pipeline.graph.getNode(edge.sourceId);
            const target = pipeline.graph.getNode(edge.targetId);
            return [
              {
                id: edge.id,
                sourceId: edge.sourceId,
                targetId: edge.targetId,
                confidence: edge.confidence,
                sourceName: source?.properties.name,
                sourceFilePath: source?.properties.filePath,
                targetName: target?.properties.name,
                targetFilePath: target?.properties.filePath,
                reason,
              },
            ];
          })
          .sort((left, right) => left.id.localeCompare(right.id));

      const coldEdges = project(cold);
      expect(project(warm)).toEqual(coldEdges);
      expect(
        coldEdges
          .map((edge) => `${edge.reason.kind}:${edge.sourceName}->${edge.targetName}`)
          .sort(),
      ).toEqual([
        'advice:javaTransaction->beforeTransaction',
        'advice:kotlinTransaction->beforeTransaction',
        'behavior:javaTransaction->@Transactional',
        'behavior:kotlinTransaction->@Transactional',
      ]);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  }, 120_000);
});

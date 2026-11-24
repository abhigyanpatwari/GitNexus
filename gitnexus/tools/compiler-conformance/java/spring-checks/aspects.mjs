import { compareCodeUnits } from '../../compare.mjs';
import assert from 'node:assert/strict';
import { runtimeParseIdentity, withIndexedBackend, springProject } from '../spring-support.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { decodeSpringAopReason } from '../../../../dist/core/ingestion/frameworks/spring/aop.js';
import { runPipelineFromRepo } from '../../../../dist/core/ingestion/pipeline.js';
import {
  loadParseCache,
  pruneCache,
  saveParseCache,
} from '../../../../dist/storage/parse-cache.js';
import {
  getDurableParsedFileDir,
  pruneAndSaveDurableParsedFileStore,
} from '../../../../dist/storage/parsedfile-store.js';
import { querySpringAopMetadata } from '../../../../dist/mcp/local/aop-metadata.js';
export async function verifyAop() {
  const parseIdentity = await runtimeParseIdentity();
  function writeFixture(root, relativePath, content) {
    const target = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(target), {
      recursive: true,
    });
    fs.writeFileSync(target, content);
  }
  // Spring AOP, transaction, cache, and method-security pipeline (#2416)

  let advisedBy;
  const nodeNamed = (name) => nodes.find((node) => node.properties.name === name);
  const relationshipTarget = (relationship) => result.graph.getNode(relationship.targetId);
  const methodNamedOn = (ownerName, methodName) => {
    const owner = nodeNamed(ownerName);
    const ownership = [...result.graph.iterRelationshipsByType('HAS_METHOD')].find(
      (relationship) =>
        relationship.sourceId === owner?.id &&
        result.graph.getNode(relationship.targetId)?.properties.name === methodName,
    );
    return ownership === undefined ? undefined : result.graph.getNode(ownership.targetId);
  };
  const declarativeAdviceForNode = (source) => {
    if (source === undefined) return [];
    return advisedBy.filter(
      (relationship) =>
        relationship.sourceId === source.id &&
        relationshipTarget(relationship)?.label === 'CodeElement',
    );
  };
  const declarativeAdviceFor = (name) => declarativeAdviceForNode(nodeNamed(name));
  const behaviorSignaturesForNode = (node) =>
    declarativeAdviceForNode(node)
      .flatMap((relationship) => {
        const reason = decodeSpringAopReason(relationship.reason);
        return reason?.kind === 'behavior' ? [`${reason.annotation}:${reason.declaredOn}`] : [];
      })
      .sort(compareCodeUnits);
  const behaviorSignaturesFor = (name) => behaviorSignaturesForNode(nodeNamed(name));
  const dir = springProject('aspects');
  const result = await runPipelineFromRepo(dir, () => {}, {
    skipGraphPhases: false,
  });
  const nodes = [...result.graph.iterNodes()];
  advisedBy = [...result.graph.iterRelationshipsByType('ADVISED_BY')];
  const declarations = [...result.graph.iterRelationshipsByType('DECLARES')]; // attaches Java and Kotlin declarative behavior as explicit ADVISED_BY evidence
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
    'kotlinCachePutOperation',
    'kotlinCachingOperation',
    'kotlinPostAuthorizeOperation',
    'kotlinPreFilterOperation',
    'kotlinPostFilterOperation',
    'kotlinJakartaRolesAllowedOperation',
    'kotlinJavaxRolesAllowedOperation',
    'kotlinJakartaTransaction',
    'kotlinJavaxTransaction',
    'kotlinSuspendTransaction',
    'kotlinExtensionTransaction',
    'kotlinFullyQualifiedTransaction',
  ];
  for (const methodName of methodNames) {
    const edges = declarativeAdviceFor(methodName);
    assert.equal(edges.length, 1, `${methodName} should retain its declarative Spring behavior`);
    assert.equal(decodeSpringAopReason(edges[0]?.reason)?.kind, 'behavior');
    assert.deepStrictEqual(
      edges.map((edge) => relationshipTarget(edge)?.label),
      ['CodeElement'],
    );
  }
  // stores synthetic evidence locations in the graph zero-based line convention

  const evidence = relationshipTarget(declarativeAdviceFor('transactionalOperation')[0]);

  // @Transactional is on source line 10 in OrderService.java.
  assert.equal(evidence?.properties.startLine, 9);
  assert.equal(evidence?.properties.endLine, 9);
  // fans class-level behavior out only to proxy-eligible methods

  assert.equal(declarativeAdviceFor('ClassLevelService').length, 1);
  assert.equal(declarativeAdviceFor('inheritedTransaction').length, 1);
  assert.equal(declarativeAdviceFor('privateHelper').length, 0);
  assert.equal(declarativeAdviceFor('staticHelper').length, 0);
  assert.equal(declarativeAdviceFor('TransactionalOperations').length, 1);
  assert.equal(declarativeAdviceFor('interfaceInheritedTransaction').length, 1);
  // captures Kotlin interface class fan-out and method-declared behaviors

  assert.equal(nodeNamed('KotlinTransactionalOperations')?.label, 'Interface');
  assert.equal(nodeNamed('KotlinMethodAnnotatedOperations')?.label, 'Interface');
  assert.deepStrictEqual(behaviorSignaturesFor('KotlinTransactionalOperations'), [
    'org.springframework.transaction.annotation.Transactional:class',
  ]);
  assert.deepStrictEqual(behaviorSignaturesFor('kotlinInterfaceInheritedTransaction'), [
    'org.springframework.transaction.annotation.Transactional:class',
  ]);
  assert.deepStrictEqual(behaviorSignaturesFor('kotlinInterfaceSecuredOperation'), [
    'org.springframework.security.access.prepost.PreAuthorize:method',
    'org.springframework.transaction.annotation.Transactional:class',
  ]);
  assert.deepStrictEqual(behaviorSignaturesFor('kotlinInterfaceExplicitTransaction'), [
    'org.springframework.transaction.annotation.Transactional:method',
  ]);
  assert.deepStrictEqual(behaviorSignaturesFor('kotlinPrivateTransaction'), []);
  assert.equal(nodeNamed('kotlinTopLevelTransaction')?.label, 'Function');
  assert.deepStrictEqual(behaviorSignaturesFor('kotlinTopLevelTransaction'), []);
  assert.deepStrictEqual(behaviorSignaturesFor('kotlinWildcardTransaction'), [
    'org.springframework.transaction.annotation.Transactional:method',
  ]);
  assert.deepStrictEqual(behaviorSignaturesFor('kotlinScriptTransaction'), [
    'org.springframework.transaction.annotation.Transactional:method',
  ]);
  // covers the complete Kotlin cache, security, and transaction behavior matrix

  const behaviorFor = (name) => {
    const [edge] = declarativeAdviceFor(name);
    const reason = decodeSpringAopReason(edge?.reason);
    return reason?.kind === 'behavior' ? reason.behavior : undefined;
  };
  assert.deepStrictEqual(
    {
      cachePut: behaviorFor('kotlinCachePutOperation'),
      caching: behaviorFor('kotlinCachingOperation'),
      postAuthorize: behaviorFor('kotlinPostAuthorizeOperation'),
      preFilter: behaviorFor('kotlinPreFilterOperation'),
      postFilter: behaviorFor('kotlinPostFilterOperation'),
      jakartaRoles: behaviorFor('kotlinJakartaRolesAllowedOperation'),
      javaxRoles: behaviorFor('kotlinJavaxRolesAllowedOperation'),
      jakartaTransaction: behaviorFor('kotlinJakartaTransaction'),
      javaxTransaction: behaviorFor('kotlinJavaxTransaction'),
    },
    {
      cachePut: 'cache-put',
      caching: 'caching',
      postAuthorize: 'authorization',
      preFilter: 'authorization',
      postFilter: 'authorization',
      jakartaRoles: 'authorization',
      javaxRoles: 'authorization',
      jakartaTransaction: 'transactional',
      javaxTransaction: 'transactional',
    },
  );
  // propagates Java and Kotlin behavior through implementations and overrides

  assert.deepStrictEqual(
    behaviorSignaturesForNode(methodNamedOn('SecuredOperationsImpl', 'interfaceSecuredOperation')),
    ['org.springframework.security.access.prepost.PreAuthorize:method'],
  );
  assert.deepStrictEqual(
    behaviorSignaturesForNode(
      methodNamedOn('TransactionalOperationsImpl', 'interfaceInheritedTransaction'),
    ),
    ['org.springframework.transaction.annotation.Transactional:class'],
  );
  assert.deepStrictEqual(
    behaviorSignaturesForNode(methodNamedOn('InheritedBehaviorService', 'overriddenTransaction')),
    ['org.springframework.transaction.annotation.Transactional:method'],
  );
  assert.deepStrictEqual(
    behaviorSignaturesForNode(
      methodNamedOn('KotlinTransactionalOperationsImpl', 'kotlinInterfaceSecuredOperation'),
    ),
    [
      'org.springframework.security.access.prepost.PreAuthorize:method',
      'org.springframework.transaction.annotation.Transactional:class',
    ],
  );
  assert.deepStrictEqual(
    behaviorSignaturesForNode(
      methodNamedOn('KotlinMethodAnnotatedOperationsImpl', 'kotlinInterfaceExplicitTransaction'),
    ),
    ['org.springframework.transaction.annotation.Transactional:method'],
  );
  assert.deepStrictEqual(
    behaviorSignaturesForNode(
      methodNamedOn('KotlinBehaviorService', 'kotlinOverriddenTransaction'),
    ),
    ['org.springframework.transaction.annotation.Transactional:method'],
  );
  // captures Kotlin companion methods as singleton behavior and fails closed on use-site targets

  assert.deepStrictEqual(behaviorSignaturesFor('kotlinCompanionTransaction'), [
    'org.springframework.transaction.annotation.Transactional:method',
  ]);
  assert.deepStrictEqual(behaviorSignaturesFor('kotlinReceiverTargetTransaction'), []);
  assert.deepStrictEqual(behaviorSignaturesFor('kotlinAliasedPlainOperation'), []);
  // matches execution(public ...) against an implicit-public Java interface method
  {
    const advice = nodeNamed('publicInterfaceAdvice');
    const targets = advisedBy
      .filter((relationship) => relationship.targetId === advice?.id)
      .map((relationship) => result.graph.getNode(relationship.sourceId)?.properties.name);
    assert.deepStrictEqual(targets, ['interfaceSecuredOperation']);
  }
  // treats Kotlin object members as singleton instance methods for AOP
  {
    assert.deepStrictEqual(behaviorSignaturesFor('KotlinObjectService'), [
      'org.springframework.transaction.annotation.Transactional:class',
    ]);
    assert.deepStrictEqual(
      behaviorSignaturesForNode(
        methodNamedOn('KotlinObjectService', 'kotlinObjectInheritedTransaction'),
      ),
      ['org.springframework.transaction.annotation.Transactional:class'],
    );
    assert.deepStrictEqual(
      behaviorSignaturesForNode(
        methodNamedOn('KotlinObjectService', 'kotlinObjectExplicitTransaction'),
      ),
      [
        'org.springframework.transaction.annotation.Transactional:class',
        'org.springframework.transaction.annotation.Transactional:method',
      ],
    );
    assert.deepStrictEqual(behaviorSignaturesFor('kotlinObjectPrivateHelper'), []);
    const objectAdvice = nodeNamed('traceKotlinObjectOperations');
    const advisedMethods = advisedBy
      .filter((relationship) => relationship.targetId === objectAdvice?.id)
      .map((relationship) => result.graph.getNode(relationship.sourceId)?.properties.name)
      .sort(compareCodeUnits);
    assert.deepStrictEqual(advisedMethods, [
      'kotlinObjectExplicitTransaction',
      'kotlinObjectInheritedTransaction',
    ]);
  }
  // resolves Kotlin aliases for behaviors, aspects, and advice annotations
  {
    assert.deepStrictEqual(behaviorSignaturesFor('kotlinAliasedTransactionalOperation'), [
      'org.springframework.transaction.annotation.Transactional:method',
    ]);
    const aliasedAspect = nodeNamed('KotlinAliasedAspect');
    const aspectMarker = declarations.find((relationship) => {
      const reason = decodeSpringAopReason(relationship.reason);
      return relationship.sourceId === aliasedAspect?.id && reason?.kind === 'aspect';
    });
    assert.notEqual(aspectMarker, undefined);
    const advice = nodeNamed('aliasedTransactionalAdvice');
    const advisedMethods = advisedBy
      .filter((relationship) => relationship.targetId === advice?.id)
      .map((relationship) => result.graph.getNode(relationship.sourceId)?.properties.name)
      .sort(compareCodeUnits);
    assert.deepStrictEqual(advisedMethods, [
      'kotlinAliasedTransactionalOperation',
      'kotlinCompanionTransaction',
      'kotlinExtensionTransaction',
      'kotlinFullyQualifiedTransaction',
      'kotlinInterfaceExplicitTransaction',
      'kotlinObjectExplicitTransaction',
      'kotlinOverriddenTransaction',
      'kotlinScriptTransaction',
      'kotlinSuspendTransaction',
      'kotlinTransactionalOperation',
      'kotlinWildcardTransaction',
      'overriddenTransaction',
      'transactionalOperation',
    ]);
  }
  // connects a statically understandable execution pointcut to every matching method
  {
    const advice = nodeNamed('traceOrderOperations');
    assert.equal(advice?.label, 'Method');
    const advisedMethods = advisedBy
      .filter((relationship) => relationship.targetId === advice?.id)
      .map((relationship) => String(result.graph.getNode(relationship.sourceId)?.properties.name))
      .sort(compareCodeUnits);
    assert.deepStrictEqual(advisedMethods, [
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
    assert.equal(foreignMethod?.label, 'Method');
    assert.equal(
      result.graph.getNode(foreignOwnership?.sourceId ?? '')?.properties.qualifiedName,
      'com.example.service.OrderService',
    );
    assert.equal(
      advisedBy.some((relationship) => relationship.sourceId === foreignMethod?.id),
      false,
    );
    const kotlinAdvice = nodeNamed('traceKotlinOperations');
    const kotlinAdvisedMethods = advisedBy
      .filter((relationship) => relationship.targetId === kotlinAdvice?.id)
      .map((relationship) => String(result.graph.getNode(relationship.sourceId)?.properties.name))
      .sort(compareCodeUnits);
    assert.deepStrictEqual(kotlinAdvisedMethods, [
      'kotlinCachePutOperation',
      'kotlinCachedOperation',
      'kotlinCachingOperation',
      'kotlinEvictOperation',
      'kotlinExtensionTransaction',
      'kotlinFullyQualifiedTransaction',
      'kotlinJakartaRolesAllowedOperation',
      'kotlinJakartaTransaction',
      'kotlinJavaxRolesAllowedOperation',
      'kotlinJavaxTransaction',
      'kotlinLegacySecuredOperation',
      'kotlinPostAuthorizeOperation',
      'kotlinPostFilterOperation',
      'kotlinPreFilterOperation',
      'kotlinSecuredOperation',
      'kotlinSuspendTransaction',
      'kotlinTransactionalOperation',
    ]);
  }
  // matches unqualified wildcard type patterns by owner simple name

  const withinAdvice = nodeNamed('simpleNameWithinAdvice');
  const withinTargets = advisedBy
    .filter((relationship) => relationship.targetId === withinAdvice?.id)
    .map((relationship) => result.graph.getNode(relationship.sourceId)?.properties.name);
  assert.ok(withinTargets.includes('plainOperation'));
  assert.ok(withinTargets.includes('kotlinCachedOperation'));
  assert.ok(!withinTargets.includes('kotlinInterfaceInheritedTransaction'));
  const executionAdvice = nodeNamed('simpleNameExecutionAdvice');
  const executionTargets = advisedBy
    .filter((relationship) => relationship.targetId === executionAdvice?.id)
    .map((relationship) => result.graph.getNode(relationship.sourceId)?.properties.name);
  assert.deepStrictEqual(executionTargets, ['kotlinCachedOperation']);
  // @annotation matches only directly declared method annotations across Java and Kotlin

  const transactionalAdvice = nodeNamed('transactionalAnnotationAdvice');
  const advisedByTransactionalAnnotation = advisedBy
    .filter((relationship) => relationship.targetId === transactionalAdvice?.id)
    .map((relationship) => result.graph.getNode(relationship.sourceId)?.properties.name)
    .sort(compareCodeUnits);
  assert.deepStrictEqual(advisedByTransactionalAnnotation, [
    'kotlinAliasedTransactionalOperation',
    'kotlinCompanionTransaction',
    'kotlinExtensionTransaction',
    'kotlinFullyQualifiedTransaction',
    'kotlinInterfaceExplicitTransaction',
    'kotlinObjectExplicitTransaction',
    'kotlinOverriddenTransaction',
    'kotlinScriptTransaction',
    'kotlinSuspendTransaction',
    'kotlinTransactionalOperation',
    'kotlinWildcardTransaction',
    'overriddenTransaction',
    'transactionalOperation',
  ]);
  assert.ok(!advisedByTransactionalAnnotation.includes('kotlinInterfaceInheritedTransaction'));
  // supports pointcuts with companion annotation attributes

  const cachedReturnAdvice = nodeNamed('cachedReturnAdvice');
  const advisedByCachedReturn = advisedBy
    .filter((relationship) => relationship.targetId === cachedReturnAdvice?.id)
    .map((relationship) => result.graph.getNode(relationship.sourceId)?.properties.name);
  assert.deepStrictEqual(advisedByCachedReturn, ['cachedOperation']);
  // resolves Kotlin raw-string advice pointcuts
  {
    const rawStringAdvice = nodeNamed('rawStringPointcutAdvice');
    const advisedMethods = advisedBy
      .filter((relationship) => relationship.targetId === rawStringAdvice?.id)
      .map((relationship) => result.graph.getNode(relationship.sourceId)?.properties.name);
    assert.deepStrictEqual(advisedMethods, ['kotlinCachedOperation']);
  }
  // retains the Aspect declaration without assuming bean registration

  for (const aspectName of ['OrderAspect', 'KotlinOrderAspect']) {
    const aspect = nodeNamed(aspectName);
    const marker = declarations.find((relationship) => {
      const reason = decodeSpringAopReason(relationship.reason);
      return relationship.sourceId === aspect?.id && reason?.kind === 'aspect';
    });
    assert.notEqual(marker, undefined, `${aspectName} should retain its Aspect marker`);
    assert.partialDeepStrictEqual(decodeSpringAopReason(marker?.reason), {
      kind: 'aspect',
      activation: 'unknown',
      registration: 'unknown',
    });
  }
  // preserves unknown pointcuts as evidence without guessing advised targets

  for (const adviceName of [
    'unresolvedNamedAdvice',
    'emptyPointcutAdvice',
    'unresolvedCompoundAdvice',
    'unresolvedSimpleTypeAdvice',
  ]) {
    const advice = nodeNamed(adviceName);
    assert.equal(advice?.label, 'Method');
    assert.equal(
      advisedBy.some((relationship) => relationship.targetId === advice?.id),
      false,
    );
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
    assert.equal(evidence.length, 1, `${adviceName} should retain conservative pointcut evidence`);
  }
  // Spring AOP durable warm parse cache (#2416)

  // replays identical Java/Kotlin ADVISED_BY edges without spawning workers

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

class KotlinCompanionHolder {
  companion object {
    @Tx
    fun companionTransaction() {}
  }
}

@AopAspect
object KotlinAspect {
  @AdviceBefore("""@annotation(org.springframework.transaction.annotation.Transactional)""")
  fun beforeTransaction() {}
}
`,
    );
    const coldCache = {
      identity: parseIdentity,
      entries: new Map(),
      usedKeys: new Set(),
      storagePath: storage,
      writeStoragePath: storage,
      onDiskKeys: new Set(),
    };
    const cold = await runPipelineFromRepo(repo, () => {}, {
      skipGraphPhases: true,
      workerPoolSize: 1,
      parseCache: coldCache,
    });
    assert.equal(cold.usedWorkerPool, true);
    pruneCache(coldCache, coldCache.usedKeys);
    const savedKeys = await saveParseCache(storage, coldCache);
    assert.ok(savedKeys.length > 0);
    await pruneAndSaveDurableParsedFileStore(
      getDurableParsedFileDir(storage),
      parseIdentity.base,
      new Set(savedKeys),
    );
    const warmCache = await loadParseCache(storage, parseIdentity, storage);
    assert.deepStrictEqual(warmCache.onDiskKeys, new Set(savedKeys));
    const warm = await runPipelineFromRepo(repo, () => {}, {
      skipGraphPhases: true,
      workerPoolSize: 1,
      parseCache: warmCache,
    });
    assert.equal(warm.usedWorkerPool, false);
    const project = (pipeline) =>
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
    assert.deepStrictEqual(project(warm), coldEdges);
    assert.deepStrictEqual(
      coldEdges
        .map((edge) => `${edge.reason.kind}:${edge.sourceName}->${edge.targetName}`)
        .sort(compareCodeUnits),
      [
        'advice:companionTransaction->beforeTransaction',
        'advice:javaTransaction->beforeTransaction',
        'advice:kotlinTransaction->beforeTransaction',
        'behavior:companionTransaction->@Transactional',
        'behavior:javaTransaction->@Transactional',
        'behavior:kotlinTransaction->@Transactional',
      ],
    );
  } finally {
    fs.rmSync(temp, {
      recursive: true,
      force: true,
    });
  }
}
export async function verifyAopBackend() {
  const SERVICE_ID = 'Class:src/PaymentService.java:PaymentService';
  const ASPECT_CLASS_ID = 'Class:src/AuditAspect.java:AuditAspect';
  const NOISY_ASPECT_CLASS_ID = 'Class:src/NoisyAspect.java:NoisyAspect';
  const PAY_ID = 'Method:src/PaymentService.java:PaymentService.pay#0';
  const CLASS_LEVEL_METHOD_ID = 'Method:src/PaymentService.java:PaymentService.list#0';
  const AUDIT_ID = 'Method:src/AuditAspect.java:AuditAspect.audit#0';
  const UNKNOWN_ADVICE_ID = 'Method:src/AuditAspect.java:AuditAspect.authorize#0';
  const RESOLVED_ADVICE_ID = 'Method:src/AuditAspect.java:AuditAspect.resolvedPointcut#0';
  const HIGH_FAN_IN_ADVICE_ID = 'Method:src/AuditAspect.java:AuditAspect.hotAdvice#0';
  const NOISY_ADVICE_ID = 'Method:src/NoisyAspect.java:NoisyAspect.noisyAdvice#0';
  const NOISY_ADVISED_SOURCE_ID = 'Method:src/NoisySource.java:NoisySource.run#0';
  const NOISY_ADVICE_TARGET_ID = 'Method:src/NoisyTarget.java:NoisyTarget.advise#0';
  const FOREIGN_ADVISED_SOURCE_ID = 'Method:src/ForeignSource.java:ForeignSource.run#0';
  const FOREIGN_ADVICE_TARGET_ID = 'Method:src/ForeignTarget.java:ForeignTarget.advise#0';
  const TRUNCATED_SOURCE_ID = 'Method:src/TruncatedSource.java:TruncatedSource.run#0';
  const TRUNCATED_TARGET_ID = 'Method:src/TruncatedTarget.java:TruncatedTarget.advise#0';
  const PLAIN_ID = 'Method:src/Plain.java:Plain.run#0';
  const CLASS_BEHAVIOR_ID = `CodeElement:spring-aop:${SERVICE_ID}:transactional`;
  const METHOD_BEHAVIOR_ID = `CodeElement:spring-aop:${PAY_ID}:cacheable`;
  const UNKNOWN_POINTCUT_ID = `CodeElement:spring-aop:${UNKNOWN_ADVICE_ID}:pointcut`;
  const RESOLVED_POINTCUT_ID = `CodeElement:spring-aop:${RESOLVED_ADVICE_ID}:pointcut`;
  const UNRELATED_DECLARATION_ID = `CodeElement:spring-bean:${PLAIN_ID}`;
  const ASPECT_EVIDENCE_ID = `CodeElement:spring-aop:${ASPECT_CLASS_ID}:aspect`;
  const NOISY_ASPECT_EVIDENCE_ID = `CodeElement:spring-aop:${NOISY_ASPECT_CLASS_ID}:aspect`;
  const NOISY_POINTCUT_ID = `CodeElement:spring-aop:${NOISY_ADVICE_ID}:pointcut`;
  const springReason = (value) => `spring-aop:v1:${JSON.stringify(value)}`;
  const CLASS_BEHAVIOR_REASON = springReason({
    kind: 'behavior',
    annotation: 'org.springframework.transaction.annotation.Transactional',
    behavior: 'transactional',
    declaredOn: 'class',
    activation: 'unknown',
    proxy: 'possible',
  });
  const METHOD_BEHAVIOR_REASON = springReason({
    kind: 'behavior',
    annotation: 'org.springframework.cache.annotation.Cacheable',
    behavior: 'cacheable',
    declaredOn: 'method',
    activation: 'unknown',
    proxy: 'possible',
  });
  const ADVICE_REASON = springReason({
    kind: 'advice',
    annotation: 'org.aspectj.lang.annotation.Around',
    advice: 'around',
    pointcut: 'execution(* com.example.PaymentService.pay(..))',
    match: 'static',
    activation: 'unknown',
    proxy: 'possible',
  });
  const UNKNOWN_POINTCUT_REASON = springReason({
    kind: 'pointcut',
    annotation: 'org.aspectj.lang.annotation.Before',
    pointcut: 'securedOperation()',
    match: 'unresolved',
    resolution: 'unknown',
  });
  const RESOLVED_POINTCUT_REASON = springReason({
    kind: 'pointcut',
    annotation: 'org.aspectj.lang.annotation.Pointcut',
    pointcut: 'execution(* com.example.PaymentService.pay(..))',
    match: 'static',
    resolution: 'resolved',
  });
  const ASPECT_REASON = springReason({
    kind: 'aspect',
    annotation: 'org.aspectj.lang.annotation.Aspect',
    activation: 'unknown',
    registration: 'unknown',
  });
  const HIGH_FAN_IN_ADVISED_IDS = Array.from(
    {
      length: 31,
    },
    (_, index) => `Method:src/FanInService.java:FanInService.advised${index}#0`,
  );
  const HIGH_FAN_IN_CALLER_IDS = Array.from(
    {
      length: 31,
    },
    (_, index) => `Method:src/LegacyCaller.java:LegacyCaller.call${index}#0`,
  );
  const SEED = [
    `CREATE (c:Class {id:'${SERVICE_ID}', name:'PaymentService', filePath:'src/PaymentService.java', startLine:0, endLine:20, isExported:false, content:'class PaymentService {}', description:'', frameworkAnnotations:[]})`,
    `CREATE (c:Class {id:'${ASPECT_CLASS_ID}', name:'AuditAspect', filePath:'src/AuditAspect.java', startLine:0, endLine:20, isExported:false, content:'class AuditAspect {}', description:'', frameworkAnnotations:[]})`,
    `CREATE (c:Class {id:'${NOISY_ASPECT_CLASS_ID}', name:'NoisyAspect', filePath:'src/NoisyAspect.java', startLine:0, endLine:20, isExported:false, content:'class NoisyAspect {}', description:'', frameworkAnnotations:[]})`,
    `CREATE (m:Method {id:'${PAY_ID}', name:'pay', filePath:'src/PaymentService.java', startLine:4, endLine:8, isExported:false, content:'void pay() {}', description:'', parameterCount:0, returnType:'void'})`,
    `CREATE (m:Method {id:'${CLASS_LEVEL_METHOD_ID}', name:'list', filePath:'src/PaymentService.java', startLine:10, endLine:12, isExported:false, content:'void list() {}', description:'', parameterCount:0, returnType:'void'})`,
    `CREATE (m:Method {id:'${AUDIT_ID}', name:'audit', filePath:'src/AuditAspect.java', startLine:4, endLine:8, isExported:false, content:'Object audit() {}', description:'', parameterCount:0, returnType:'Object'})`,
    `CREATE (m:Method {id:'${UNKNOWN_ADVICE_ID}', name:'authorize', filePath:'src/AuditAspect.java', startLine:10, endLine:12, isExported:false, content:'void authorize() {}', description:'', parameterCount:0, returnType:'void'})`,
    `CREATE (m:Method {id:'${RESOLVED_ADVICE_ID}', name:'resolvedPointcut', filePath:'src/AuditAspect.java', startLine:12, endLine:13, isExported:false, content:'void resolvedPointcut() {}', description:'', parameterCount:0, returnType:'void'})`,
    `CREATE (m:Method {id:'${HIGH_FAN_IN_ADVICE_ID}', name:'hotAdvice', filePath:'src/AuditAspect.java', startLine:14, endLine:16, isExported:false, content:'void hotAdvice() {}', description:'', parameterCount:0, returnType:'void'})`,
    `CREATE (m:Method {id:'${NOISY_ADVICE_ID}', name:'noisyAdvice', filePath:'src/NoisyAspect.java', startLine:4, endLine:8, isExported:false, content:'void noisyAdvice() {}', description:'', parameterCount:0, returnType:'void'})`,
    `CREATE (m:Method {id:'${NOISY_ADVISED_SOURCE_ID}', name:'run', filePath:'src/NoisySource.java', startLine:1, endLine:2, isExported:false, content:'void run() {}', description:'', parameterCount:0, returnType:'void'})`,
    `CREATE (m:Method {id:'${NOISY_ADVICE_TARGET_ID}', name:'advise', filePath:'src/NoisyTarget.java', startLine:1, endLine:2, isExported:false, content:'void advise() {}', description:'', parameterCount:0, returnType:'void'})`,
    `CREATE (m:Method {id:'${FOREIGN_ADVISED_SOURCE_ID}', name:'run', filePath:'src/ForeignSource.java', startLine:1, endLine:2, isExported:false, content:'void run() {}', description:'', parameterCount:0, returnType:'void'})`,
    `CREATE (m:Method {id:'${FOREIGN_ADVICE_TARGET_ID}', name:'advise', filePath:'src/ForeignTarget.java', startLine:1, endLine:2, isExported:false, content:'void advise() {}', description:'', parameterCount:0, returnType:'void'})`,
    `CREATE (m:Method {id:'${TRUNCATED_SOURCE_ID}', name:'run', filePath:'src/TruncatedSource.java', startLine:1, endLine:2, isExported:false, content:'void run() {}', description:'', parameterCount:0, returnType:'void'})`,
    `CREATE (m:Method {id:'${TRUNCATED_TARGET_ID}', name:'advise', filePath:'src/TruncatedTarget.java', startLine:1, endLine:2, isExported:false, content:'void advise() {}', description:'', parameterCount:0, returnType:'void'})`,
    ...HIGH_FAN_IN_ADVISED_IDS.map(
      (id, index) =>
        `CREATE (m:Method {id:'${id}', name:'advised${index}', filePath:'src/FanInService.java', startLine:${index}, endLine:${index}, isExported:false, content:'void advised${index}() {}', description:'', parameterCount:0, returnType:'void'})`,
    ),
    ...HIGH_FAN_IN_CALLER_IDS.map(
      (id, index) =>
        `CREATE (m:Method {id:'${id}', name:'call${index}', filePath:'src/LegacyCaller.java', startLine:${index}, endLine:${index}, isExported:false, content:'void call${index}() {}', description:'', parameterCount:0, returnType:'void'})`,
    ),
    `CREATE (m:Method {id:'${PLAIN_ID}', name:'run', filePath:'src/Plain.java', startLine:1, endLine:2, isExported:false, content:'void run() {}', description:'', parameterCount:0, returnType:'void'})`,
    `CREATE (e:CodeElement {id:'${CLASS_BEHAVIOR_ID}', name:'Transactional', filePath:'src/PaymentService.java', startLine:0, endLine:0, isExported:false, content:'', description:'Spring AOP behavior evidence'})`,
    `CREATE (e:CodeElement {id:'${METHOD_BEHAVIOR_ID}', name:'Cacheable', filePath:'src/PaymentService.java', startLine:4, endLine:4, isExported:false, content:'', description:'Spring AOP behavior evidence'})`,
    `CREATE (e:CodeElement {id:'${UNKNOWN_POINTCUT_ID}', name:'securedOperation()', filePath:'src/AuditAspect.java', startLine:10, endLine:10, isExported:false, content:'', description:'Spring AOP unresolved pointcut evidence'})`,
    `CREATE (e:CodeElement {id:'${RESOLVED_POINTCUT_ID}', name:'pay()', filePath:'src/AuditAspect.java', startLine:12, endLine:12, isExported:false, content:'', description:'Spring AOP resolved pointcut evidence'})`,
    `CREATE (e:CodeElement {id:'${UNRELATED_DECLARATION_ID}', name:'plain', filePath:'src/Plain.java', startLine:1, endLine:1, isExported:false, content:'', description:'Spring Bean factory declaration'})`,
    `CREATE (e:CodeElement {id:'${ASPECT_EVIDENCE_ID}', name:'Aspect', filePath:'src/AuditAspect.java', startLine:0, endLine:0, isExported:false, content:'', description:'Spring AOP aspect evidence'})`,
    `CREATE (e:CodeElement {id:'${NOISY_ASPECT_EVIDENCE_ID}', name:'Aspect', filePath:'src/NoisyAspect.java', startLine:0, endLine:0, isExported:false, content:'', description:'Spring AOP aspect evidence'})`,
    `CREATE (e:CodeElement {id:'${NOISY_POINTCUT_ID}', name:'securedOperation()', filePath:'src/NoisyAspect.java', startLine:4, endLine:4, isExported:false, content:'', description:'Spring AOP unresolved pointcut evidence'})`,
    `MATCH (c:Class {id:'${SERVICE_ID}'}), (e:CodeElement {id:'${CLASS_BEHAVIOR_ID}'}) CREATE (c)-[:CodeRelation {type:'ADVISED_BY', confidence:1.0, reason:'${CLASS_BEHAVIOR_REASON}', step:0}]->(e)`,
    `MATCH (m:Method {id:'${CLASS_LEVEL_METHOD_ID}'}), (e:CodeElement {id:'${CLASS_BEHAVIOR_ID}'}) CREATE (m)-[:CodeRelation {type:'ADVISED_BY', confidence:1.0, reason:'${CLASS_BEHAVIOR_REASON}', step:0}]->(e)`,
    `MATCH (m:Method {id:'${PAY_ID}'}), (e:CodeElement {id:'${METHOD_BEHAVIOR_ID}'}) CREATE (m)-[:CodeRelation {type:'ADVISED_BY', confidence:1.0, reason:'${METHOD_BEHAVIOR_REASON}', step:0}]->(e)`,
    // Duplicate evidence exercises read-side deduplication for indexes produced
    // by an interrupted/retried incremental write.
    `MATCH (m:Method {id:'${PAY_ID}'}), (e:CodeElement {id:'${METHOD_BEHAVIOR_ID}'}) CREATE (m)-[:CodeRelation {type:'ADVISED_BY', confidence:1.0, reason:'${METHOD_BEHAVIOR_REASON}', step:0}]->(e)`,
    `MATCH (m:Method {id:'${PAY_ID}'}), (a:Method {id:'${AUDIT_ID}'}) CREATE (m)-[:CodeRelation {type:'ADVISED_BY', confidence:0.9, reason:'${ADVICE_REASON}', step:0}]->(a)`,
    `MATCH (a:Method {id:'${UNKNOWN_ADVICE_ID}'}), (e:CodeElement {id:'${UNKNOWN_POINTCUT_ID}'}) CREATE (a)-[:CodeRelation {type:'DECLARES', confidence:1.0, reason:'${UNKNOWN_POINTCUT_REASON}', step:0}]->(e)`,
    `MATCH (a:Method {id:'${RESOLVED_ADVICE_ID}'}), (e:CodeElement {id:'${RESOLVED_POINTCUT_ID}'}) CREATE (a)-[:CodeRelation {type:'DECLARES', confidence:1.0, reason:'${RESOLVED_POINTCUT_REASON}', step:0}]->(e)`,
    `MATCH (c:Class {id:'${ASPECT_CLASS_ID}'}), (e:CodeElement {id:'${ASPECT_EVIDENCE_ID}'}) CREATE (c)-[:CodeRelation {type:'DECLARES', confidence:1.0, reason:'${ASPECT_REASON}', step:0}]->(e)`,
    `MATCH (m:Method {id:'${PLAIN_ID}'}), (e:CodeElement {id:'${UNRELATED_DECLARATION_ID}'}) CREATE (m)-[:CodeRelation {type:'DECLARES', confidence:1.0, reason:'spring-bean-factory:{"names":["plain"],"namesKnown":true}', step:0}]->(e)`,
    `MATCH (c:Class {id:'${NOISY_ASPECT_CLASS_ID}'}), (e:CodeElement {id:'${UNRELATED_DECLARATION_ID}'}) UNWIND range(1, 1001) AS ignored CREATE (c)-[:CodeRelation {type:'DECLARES', confidence:1.0, reason:'spring-bean-factory:{"names":["noise"],"namesKnown":true}', step:ignored}]->(e)`,
    `MATCH (c:Class {id:'${NOISY_ASPECT_CLASS_ID}'}), (e:CodeElement {id:'${NOISY_ASPECT_EVIDENCE_ID}'}) CREATE (c)-[:CodeRelation {type:'DECLARES', confidence:1.0, reason:'${ASPECT_REASON}', step:0}]->(e)`,
    `MATCH (m:Method {id:'${PLAIN_ID}'}), (e:CodeElement {id:'${NOISY_POINTCUT_ID}'}) UNWIND range(1, 1001) AS ignored CREATE (m)-[:CodeRelation {type:'DECLARES', confidence:1.0, reason:'spring-bean-factory:{"names":["noise"],"namesKnown":true}', step:ignored}]->(e)`,
    `MATCH (m:Method {id:'${NOISY_ADVICE_ID}'}), (e:CodeElement {id:'${NOISY_POINTCUT_ID}'}) CREATE (m)-[:CodeRelation {type:'DECLARES', confidence:1.0, reason:'${UNKNOWN_POINTCUT_REASON}', step:0}]->(e)`,
    `MATCH (m:Method {id:'${NOISY_ADVISED_SOURCE_ID}'}), (a:Method {id:'${NOISY_ADVICE_TARGET_ID}'}) CREATE (m)-[:CodeRelation {type:'ADVISED_BY', confidence:0.9, reason:'${ADVICE_REASON}', step:0}]->(a)`,
    `MATCH (m:Method {id:'${NOISY_ADVISED_SOURCE_ID}'}), (a:Method {id:'${FOREIGN_ADVICE_TARGET_ID}'}) UNWIND range(1, 1001) AS ignored CREATE (m)-[:CodeRelation {type:'ADVISED_BY', confidence:0.1, reason:'foreign-advice', step:ignored}]->(a)`,
    `MATCH (m:Method {id:'${FOREIGN_ADVISED_SOURCE_ID}'}), (a:Method {id:'${NOISY_ADVICE_TARGET_ID}'}) UNWIND range(1, 1001) AS ignored CREATE (m)-[:CodeRelation {type:'ADVISED_BY', confidence:0.1, reason:'foreign-advice', step:ignored}]->(a)`,
    `MATCH (m:Method {id:'${TRUNCATED_SOURCE_ID}'}), (a:Method {id:'${TRUNCATED_TARGET_ID}'}) UNWIND range(1, 1001) AS item CREATE (m)-[:CodeRelation {type:'ADVISED_BY', confidence:0.9, reason:'${ADVICE_REASON}', step:item}]->(a)`,
    ...HIGH_FAN_IN_ADVISED_IDS.map(
      (id) =>
        `MATCH (m:Method {id:'${id}'}), (a:Method {id:'${HIGH_FAN_IN_ADVICE_ID}'}) CREATE (m)-[:CodeRelation {type:'ADVISED_BY', confidence:0.9, reason:'${ADVICE_REASON}', step:0}]->(a)`,
    ),
    ...HIGH_FAN_IN_CALLER_IDS.map(
      (id) =>
        `MATCH (m:Method {id:'${id}'}), (a:Method {id:'${HIGH_FAN_IN_ADVICE_ID}'}) CREATE (m)-[:CodeRelation {type:'CALLS', confidence:1.0, reason:'test fixture', step:0}]->(a)`,
    ),
  ];
  await withIndexedBackend('spring-aop-mcp', SEED, async (handle, backend) => {
    // Spring AOP metadata enrichment

    // normalizes declarative behavior and explicit advice for an advised method
    {
      const metadata = await querySpringAopMetadata(handle.repoId, PAY_ID, 'Method');
      assert.deepStrictEqual(metadata, {
        framework: 'spring',
        proxied: 'possible',
        behaviors: [
          {
            annotation: 'org.springframework.cache.annotation.Cacheable',
            behavior: 'cacheable',
            declaredOn: 'method',
            activation: 'unknown',
            evidenceId: METHOD_BEHAVIOR_ID,
          },
        ],
        advices: [
          {
            annotation: 'org.aspectj.lang.annotation.Around',
            advice: 'around',
            pointcut: 'execution(* com.example.PaymentService.pay(..))',
            match: 'static',
            activation: 'unknown',
            adviceId: AUDIT_ID,
            adviceName: 'audit',
            adviceFilePath: 'src/AuditAspect.java',
            advisedId: PAY_ID,
            advisedName: 'pay',
            advisedFilePath: 'src/PaymentService.java',
          },
        ],
        resolvedPointcuts: [],
        unresolvedPointcuts: [],
      });
    }
    // returns the same canonical advice direction from the advice method
    {
      const metadata = await querySpringAopMetadata(handle.repoId, AUDIT_ID, 'Method');
      const observed = metadata?.advices;
      const expected = [
        {
          adviceId: AUDIT_ID,
          advisedId: PAY_ID,
          advice: 'around',
        },
      ];
      assert.equal(observed.length, expected.length);
      for (const [index, row] of expected.entries())
        assert.partialDeepStrictEqual(observed[index], row);
      assert.equal(Object.hasOwn(metadata, 'proxied'), false);
    }
    // exposes the same AOP metadata through context and impact
    {
      const [context, adviceContext, impact, adviceImpact] = await Promise.all([
        backend.callTool('context', {
          uid: PAY_ID,
        }),
        backend.callTool('context', {
          uid: AUDIT_ID,
        }),
        backend.callTool('impact', {
          target: 'pay',
          direction: 'upstream',
        }),
        backend.callTool('impact', {
          target: 'audit',
          direction: 'upstream',
          relationTypes: ['ADVISED_BY'],
          includeTests: true,
        }),
      ]);
      assert.equal(context.symbol.aop.behaviors.length, 1);
      assert.equal(context.symbol.aop.advices.length, 1);
      assert.partialDeepStrictEqual(context.symbol.aop, {
        framework: 'spring',
        proxied: 'possible',
        behaviors: [
          {
            behavior: 'cacheable',
          },
        ],
        advices: [
          {
            advice: 'around',
            adviceId: AUDIT_ID,
          },
        ],
      });
      {
        const observed = context.outgoing.advised_by;
        for (const row of [
          {
            uid: AUDIT_ID,
            name: 'audit',
          },
        ])
          assert.partialDeepStrictEqual(observed, [row]);
      }
      {
        const observed = adviceContext.incoming.advised_by;
        for (const row of [
          {
            uid: PAY_ID,
            name: 'pay',
          },
        ])
          assert.partialDeepStrictEqual(observed, [row]);
      }
      assert.equal(Object.hasOwn(adviceContext.symbol.aop, 'proxied'), false);
      assert.deepStrictEqual(impact.target.aop, context.symbol.aop);
      assert.deepStrictEqual(adviceImpact.target.aop, adviceContext.symbol.aop);
      {
        const observed = adviceImpact.byDepth[1];
        for (const row of [
          {
            id: PAY_ID,
            name: 'pay',
            relationType: 'ADVISED_BY',
          },
        ])
          assert.partialDeepStrictEqual(observed, [row]);
      }
    }
    // keeps legacy context relations when advice fan-in exceeds the context window
    {
      const context = await backend.callTool('context', {
        uid: HIGH_FAN_IN_ADVICE_ID,
      });
      assert.equal(context.incoming.calls.length, 30);
      assert.equal(context.incoming.advised_by.length, 30);
      assert.equal(context.symbol.aop.advices.length, 31);
    }
    // supports Class and CodeElement behavior evidence
    {
      const classMetadata = await querySpringAopMetadata(handle.repoId, SERVICE_ID, 'Class');
      const classLevelMethodMetadata = await querySpringAopMetadata(
        handle.repoId,
        CLASS_LEVEL_METHOD_ID,
        'Method',
      );
      const evidenceMetadata = await querySpringAopMetadata(
        handle.repoId,
        METHOD_BEHAVIOR_ID,
        'CodeElement',
      );
      {
        const observed = classMetadata?.behaviors;
        const expected = [
          {
            behavior: 'transactional',
            declaredOn: 'class',
          },
        ];
        assert.equal(observed.length, expected.length);
        for (const [index, row] of expected.entries())
          assert.partialDeepStrictEqual(observed[index], row);
      }
      assert.equal(classMetadata?.proxied, 'possible');
      {
        const observed = classLevelMethodMetadata?.behaviors;
        const expected = [
          {
            behavior: 'transactional',
            declaredOn: 'class',
          },
        ];
        assert.equal(observed.length, expected.length);
        for (const [index, row] of expected.entries())
          assert.partialDeepStrictEqual(observed[index], row);
      }
      assert.equal(classLevelMethodMetadata?.proxied, 'possible');
      {
        const observed = evidenceMetadata?.behaviors;
        const expected = [
          {
            behavior: 'cacheable',
            evidenceId: METHOD_BEHAVIOR_ID,
          },
        ];
        assert.equal(observed.length, expected.length);
        for (const [index, row] of expected.entries())
          assert.partialDeepStrictEqual(observed[index], row);
      }
      assert.equal(Object.hasOwn(evidenceMetadata, 'proxied'), false);
    }
    // surfaces standalone Aspect declarations without claiming proxy activation
    {
      const [classMetadata, evidenceMetadata, context] = await Promise.all([
        querySpringAopMetadata(handle.repoId, ASPECT_CLASS_ID, 'Class'),
        querySpringAopMetadata(handle.repoId, ASPECT_EVIDENCE_ID, 'CodeElement'),
        backend.callTool('context', {
          uid: ASPECT_CLASS_ID,
        }),
      ]);
      const expectedAspect = {
        annotation: 'org.aspectj.lang.annotation.Aspect',
        activation: 'unknown',
        registration: 'unknown',
        evidenceId: ASPECT_EVIDENCE_ID,
      };
      assert.deepStrictEqual(classMetadata?.aspect, expectedAspect);
      assert.equal(Object.hasOwn(classMetadata, 'proxied'), false);
      assert.deepStrictEqual(evidenceMetadata?.aspect, expectedAspect);
      assert.equal(Object.hasOwn(evidenceMetadata, 'proxied'), false);
      assert.deepStrictEqual(context.symbol.aop.aspect, expectedAspect);
      assert.equal(Object.hasOwn(context.symbol.aop, 'proxied'), false);
    }
    // surfaces unresolved pointcuts without guessing an advised target
    {
      const adviceMetadata = await querySpringAopMetadata(
        handle.repoId,
        UNKNOWN_ADVICE_ID,
        'Method',
      );
      const evidenceMetadata = await querySpringAopMetadata(
        handle.repoId,
        UNKNOWN_POINTCUT_ID,
        'CodeElement',
      );
      const expected = [
        {
          annotation: 'org.aspectj.lang.annotation.Before',
          pointcut: 'securedOperation()',
          adviceId: UNKNOWN_ADVICE_ID,
          adviceName: 'authorize',
          adviceFilePath: 'src/AuditAspect.java',
          evidenceId: UNKNOWN_POINTCUT_ID,
        },
      ];
      assert.deepStrictEqual(adviceMetadata, {
        framework: 'spring',
        behaviors: [],
        advices: [],
        resolvedPointcuts: [],
        unresolvedPointcuts: expected,
      });
      assert.deepStrictEqual(evidenceMetadata?.unresolvedPointcuts, expected);
    }
    // surfaces resolved standalone pointcut declarations from both endpoints
    {
      const [adviceMetadata, evidenceMetadata] = await Promise.all([
        querySpringAopMetadata(handle.repoId, RESOLVED_ADVICE_ID, 'Method'),
        querySpringAopMetadata(handle.repoId, RESOLVED_POINTCUT_ID, 'CodeElement'),
      ]);
      const expected = [
        {
          annotation: 'org.aspectj.lang.annotation.Pointcut',
          pointcut: 'execution(* com.example.PaymentService.pay(..))',
          match: 'static',
          resolution: 'resolved',
          adviceId: RESOLVED_ADVICE_ID,
          adviceName: 'resolvedPointcut',
          adviceFilePath: 'src/AuditAspect.java',
          evidenceId: RESOLVED_POINTCUT_ID,
        },
      ];
      assert.deepStrictEqual(adviceMetadata?.resolvedPointcuts, expected);
      assert.deepStrictEqual(evidenceMetadata?.resolvedPointcuts, expected);
    }
    // orders capped rows deterministically and reports positive truncation
    {
      const first = await querySpringAopMetadata(handle.repoId, TRUNCATED_SOURCE_ID, 'Method');
      const second = await querySpringAopMetadata(handle.repoId, TRUNCATED_SOURCE_ID, 'Method');
      assert.equal(first?.truncated, true);
      const observed = first?.advices;
      const expected = [
        {
          advisedId: TRUNCATED_SOURCE_ID,
          adviceId: TRUNCATED_TARGET_ID,
        },
      ];
      assert.equal(observed.length, expected.length);
      for (const [index, row] of expected.entries())
        assert.partialDeepStrictEqual(observed[index], row);
      assert.deepStrictEqual(second, first);
    }
    // does not let unrelated DECLARES exhaust the Spring AOP query budget

    const [aspectMetadata, pointcutMetadata] = await Promise.all([
      querySpringAopMetadata(handle.repoId, NOISY_ASPECT_CLASS_ID, 'Class'),
      querySpringAopMetadata(handle.repoId, NOISY_POINTCUT_ID, 'CodeElement'),
    ]);
    assert.deepStrictEqual(aspectMetadata?.aspect, {
      annotation: 'org.aspectj.lang.annotation.Aspect',
      activation: 'unknown',
      registration: 'unknown',
      evidenceId: NOISY_ASPECT_EVIDENCE_ID,
    });
    assert.equal(Object.hasOwn(aspectMetadata, 'truncated'), false);
    assert.deepStrictEqual(pointcutMetadata?.unresolvedPointcuts, [
      {
        annotation: 'org.aspectj.lang.annotation.Before',
        pointcut: 'securedOperation()',
        adviceId: NOISY_ADVICE_ID,
        adviceName: 'noisyAdvice',
        adviceFilePath: 'src/NoisyAspect.java',
        evidenceId: NOISY_POINTCUT_ID,
      },
    ]);
    assert.equal(Object.hasOwn(pointcutMetadata, 'truncated'), false);
    // does not let unrelated ADVISED_BY exhaust either AOP query direction
    {
      const [sourceMetadata, targetMetadata] = await Promise.all([
        querySpringAopMetadata(handle.repoId, NOISY_ADVISED_SOURCE_ID, 'Method'),
        querySpringAopMetadata(handle.repoId, NOISY_ADVICE_TARGET_ID, 'Method'),
      ]);
      const observed = sourceMetadata?.advices;
      const expected = [
        {
          advisedId: NOISY_ADVISED_SOURCE_ID,
          adviceId: NOISY_ADVICE_TARGET_ID,
        },
      ];
      assert.equal(observed.length, expected.length);
      for (const [index, row] of expected.entries())
        assert.partialDeepStrictEqual(observed[index], row);
      assert.deepStrictEqual(targetMetadata?.advices, sourceMetadata?.advices);
      assert.equal(Object.hasOwn(sourceMetadata, 'truncated'), false);
      assert.equal(Object.hasOwn(targetMetadata, 'truncated'), false);
    }
    // ignores unrelated DECLARES evidence and unsupported symbol kinds

    await assert.equal(await querySpringAopMetadata(handle.repoId, PLAIN_ID, 'Method'), undefined);
    await assert.equal(
      await querySpringAopMetadata(handle.repoId, 'Function:src/plain.ts:run', 'Function'),
      undefined,
    );
  });
}

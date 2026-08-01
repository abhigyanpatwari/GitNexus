import type { GraphNode } from 'gitnexus-shared';
import { describe, expect, it } from 'vitest';
import {
  decodeSpringAopReason,
  encodeSpringAopReason,
  isSpringAopEvidenceNode,
  parseSpringAopPointcut,
  springAopPointcutMatches,
  type SpringAopReason,
} from '../../src/core/ingestion/frameworks/spring/aop.js';
import {
  createSpringAopCandidateIndex,
  type SpringAopOwnedMethod,
} from '../../src/core/ingestion/frameworks/spring/aop-candidates.js';

const owner: GraphNode = {
  id: 'Class:com.example.service.OrderService',
  label: 'Class',
  properties: {
    name: 'OrderService',
    qualifiedName: 'com.example.service.OrderService',
    filePath: 'src/OrderService.java',
    startLine: 1,
    endLine: 20,
    isExported: true,
  },
};

const method: GraphNode = {
  id: 'Method:com.example.service.OrderService.run',
  label: 'Method',
  properties: {
    name: 'run',
    qualifiedName: 'com.example.service.OrderService.run',
    filePath: 'src/OrderService.java',
    startLine: 3,
    endLine: 5,
    isExported: true,
    visibility: 'public',
    parameterCount: 1,
  },
};

describe('Spring AOP static pointcuts (#2416)', () => {
  it('parses the deliberately narrow execution, within, and known @annotation subset', () => {
    expect(parseSpringAopPointcut('execution(public * com.example..OrderService.r*( * ))')).toEqual(
      {
        kind: 'execution',
        ownerPattern: 'com.example..OrderService',
        methodPattern: 'r*',
        visibility: 'public',
        parameterCount: 1,
      },
    );
    expect(parseSpringAopPointcut('within(com.example..service.*)')).toEqual({
      kind: 'within',
      ownerPattern: 'com.example..service.*',
    });
    expect(
      parseSpringAopPointcut(
        '@annotation(org.springframework.transaction.annotation.Transactional)',
      ),
    ).toEqual({
      kind: 'annotation',
      annotation: 'org.springframework.transaction.annotation.Transactional',
    });
  });

  it('matches owner, method, visibility, arity, and resolved method annotations', () => {
    const execution = parseSpringAopPointcut('execution(public * com.example..OrderService.r*(*))');
    const within = parseSpringAopPointcut('within(com.example..OrderService)');
    const annotation = parseSpringAopPointcut(
      '@annotation(org.springframework.transaction.annotation.Transactional)',
    );

    expect(execution && springAopPointcutMatches(execution, owner, method)).toBe(true);
    expect(within && springAopPointcutMatches(within, owner, method)).toBe(true);
    expect(
      annotation &&
        springAopPointcutMatches(
          annotation,
          owner,
          method,
          new Set(['org.springframework.transaction.annotation.Transactional']),
        ),
    ).toBe(true);
  });

  it('matches unqualified wildcard type patterns against the owner simple name', () => {
    const within = parseSpringAopPointcut('within(*Service)');
    const execution = parseSpringAopPointcut('execution(* *Service.run(..))');

    expect(within && springAopPointcutMatches(within, owner, method)).toBe(true);
    expect(execution && springAopPointcutMatches(execution, owner, method)).toBe(true);
  });

  it.each(['within(OrderService)', 'execution(* OrderService.run(..))'])(
    'fails closed when a simple exact type needs unavailable import context: %s',
    (expression) => {
      expect(parseSpringAopPointcut(expression)).toBeNull();
    },
  );

  it.each([
    'namedPointcut()',
    'execution(* com.example..OrderService.*(..)) && args(orderId)',
    'execution(String com.example.OrderService.run(..))',
    '@annotation(com.example.DynamicMarker)',
    'bean(orderService)',
  ])('fails closed for unsupported or dynamic expression %s', (expression) => {
    expect(parseSpringAopPointcut(expression)).toBeNull();
  });

  it('rejects overlong input instead of truncating away a dynamic suffix', () => {
    const start = 'execution(* ';
    const end = '.run(..))';
    const validPrefix = `${start}${'a'.repeat(1_000 - start.length - end.length)}${end}`;
    expect(validPrefix).toHaveLength(1_000);
    expect(parseSpringAopPointcut(`${validPrefix} && args(value)`)).toBeNull();
  });

  it('matches adversarial wildcard input without regex backtracking', () => {
    const wildcardChain = '*a'.repeat(10);
    const execution = parseSpringAopPointcut(
      `execution(* com.example..OrderService.${wildcardChain}z(..))`,
    );
    const within = parseSpringAopPointcut(`within(com.example.${wildcardChain}z)`);
    const adversarialMethod = {
      ...method,
      properties: { ...method.properties, name: 'a'.repeat(24) },
    };
    const adversarialOwner = {
      ...owner,
      properties: {
        ...owner.properties,
        qualifiedName: `com.example.${'a'.repeat(24)}`,
      },
    };

    const startedAt = performance.now();
    expect(execution && springAopPointcutMatches(execution, owner, adversarialMethod)).toBe(false);
    expect(within && springAopPointcutMatches(within, adversarialOwner, method)).toBe(false);
    expect(performance.now() - startedAt).toBeLessThan(100);
  });
});

describe('Spring AOP pointcut candidate index (#2416)', () => {
  it('selects only methods that directly declare an @annotation behavior', () => {
    const annotated = { method, owner } satisfies SpringAopOwnedMethod;
    const plain = {
      owner,
      method: {
        ...method,
        id: 'Method:com.example.service.OrderService.plain',
        properties: { ...method.properties, name: 'plain' },
      },
    } satisfies SpringAopOwnedMethod;
    const pointcut = parseSpringAopPointcut(
      '@annotation(org.springframework.transaction.annotation.Transactional)',
    );
    expect(pointcut).not.toBeNull();

    const index = createSpringAopCandidateIndex(
      [annotated, plain],
      new Map([[method.id, new Set(['org.springframework.transaction.annotation.Transactional'])]]),
    );

    expect(index.candidatesFor(pointcut!)).toEqual([annotated]);
  });

  it('narrows exact and literal-prefix owner pointcuts without excluding matches', () => {
    const ownedMethod = (qualifiedName: string): SpringAopOwnedMethod => {
      const ownerName = qualifiedName.slice(qualifiedName.lastIndexOf('.') + 1);
      return {
        owner: {
          ...owner,
          id: `Class:${qualifiedName}`,
          properties: { ...owner.properties, name: ownerName, qualifiedName },
        },
        method: {
          ...method,
          id: `Method:${qualifiedName}.run`,
          properties: { ...method.properties, qualifiedName: `${qualifiedName}.run` },
        },
      };
    };
    const order = ownedMethod('com.example.service.OrderService');
    const payment = ownedMethod('com.example.billing.PaymentService');
    const legacy = ownedMethod('org.legacy.LegacyService');
    const candidates = [order, payment, legacy];
    const index = createSpringAopCandidateIndex(candidates, new Map());
    const exact = parseSpringAopPointcut('within(com.example.service.OrderService)');
    const prefixed = parseSpringAopPointcut('within(com.example..*Service)');
    const leadingWildcard = parseSpringAopPointcut('within(*..*Service)');
    expect(exact && index.candidatesFor(exact)).toEqual([order]);
    expect(prefixed && index.candidatesFor(prefixed)).toEqual([payment, order]);
    expect(leadingWildcard && index.candidatesFor(leadingWildcard)).toEqual(candidates);
  });

  it('preserves brute-force results across exact, wildcard, descendant, and annotation pointcuts', () => {
    const ownedMethod = (
      qualifiedName: string,
      methodName: string,
      filePath: string,
    ): SpringAopOwnedMethod => ({
      owner: {
        ...owner,
        id: `Class:${filePath}:${qualifiedName}`,
        properties: { ...owner.properties, qualifiedName, filePath },
      },
      method: {
        ...method,
        id: `Method:${filePath}:${qualifiedName}.${methodName}`,
        properties: {
          ...method.properties,
          name: methodName,
          qualifiedName: `${qualifiedName}.${methodName}`,
          filePath,
        },
      },
    });
    const candidates = [
      ownedMethod('com.example.service.OrderService', 'run', 'OrderService.java'),
      ownedMethod('com.example.service.OrderService', 'read', 'OrderService.kt'),
      ownedMethod('com.example.billing.InvoiceService', 'run', 'InvoiceService.kt'),
      ownedMethod('org.legacy.LegacyService', 'run', 'LegacyService.java'),
    ];
    const transactional = 'org.springframework.transaction.annotation.Transactional';
    const methodAnnotations = new Map([[candidates[1]!.method.id, new Set([transactional])]]);
    const index = createSpringAopCandidateIndex(candidates, methodAnnotations);
    const expressions = [
      'within(com.example.service.OrderService)',
      'within(com.example..*Service)',
      'within(*..*Service)',
      'execution(public * com.example..*Service.r*( * ))',
      `@annotation(${transactional})`,
    ];

    for (const expression of expressions) {
      const pointcut = parseSpringAopPointcut(expression);
      expect(pointcut, expression).not.toBeNull();
      const matchingIds = (pool: readonly SpringAopOwnedMethod[]) =>
        pool
          .filter((candidate) =>
            springAopPointcutMatches(
              pointcut!,
              candidate.owner,
              candidate.method,
              methodAnnotations.get(candidate.method.id),
            ),
          )
          .map((candidate) => candidate.method.id)
          .sort();

      expect(matchingIds(index.candidatesFor(pointcut!)), expression).toEqual(
        matchingIds(candidates),
      );
    }
  });
});

describe('Spring AOP persisted reason contract (#2416)', () => {
  const reasons: readonly SpringAopReason[] = [
    {
      kind: 'behavior',
      annotation: 'org.springframework.transaction.annotation.Transactional',
      behavior: 'transactional',
      declaredOn: 'method',
      activation: 'unknown',
      proxy: 'possible',
    },
    {
      kind: 'behavior',
      annotation: 'org.springframework.cache.annotation.Caching',
      behavior: 'caching',
      declaredOn: 'method',
      activation: 'unknown',
      proxy: 'possible',
    },
    {
      kind: 'advice',
      annotation: 'org.aspectj.lang.annotation.Around',
      advice: 'around',
      pointcut: 'execution(* com.example..OrderService.*(..))',
      match: 'static',
      activation: 'unknown',
      proxy: 'possible',
    },
    {
      kind: 'pointcut',
      annotation: 'org.aspectj.lang.annotation.Before',
      pointcut: 'namedPointcut()',
      match: 'unresolved',
      resolution: 'unknown',
    },
    {
      kind: 'pointcut',
      annotation: 'org.aspectj.lang.annotation.After',
      pointcut: null,
      match: 'unresolved',
      resolution: 'unknown',
    },
    {
      kind: 'aspect',
      annotation: 'org.aspectj.lang.annotation.Aspect',
      activation: 'unknown',
      registration: 'unknown',
    },
  ];

  it.each(reasons)('round-trips the $kind reason', (reason) => {
    expect(decodeSpringAopReason(encodeSpringAopReason(reason))).toEqual(reason);
  });

  it.each([
    'spring-aop:v2:{}',
    'spring-aop:v1:not-json',
    `spring-aop:v1:${JSON.stringify({
      kind: 'behavior',
      annotation: 'com.example.FakeTransactional',
      behavior: 'transactional',
      declaredOn: 'method',
      activation: 'unknown',
      proxy: 'possible',
    })}`,
    `spring-aop:v1:${JSON.stringify({
      kind: 'pointcut',
      annotation: 'org.aspectj.lang.annotation.Before',
      pointcut: 'execution(* com.example.Service.run(..))',
      match: 'static',
      resolution: 'unknown',
    })}`,
  ])('rejects malformed, foreign, or internally inconsistent reason %s', (reason) => {
    expect(decodeSpringAopReason(reason)).toBeUndefined();
  });

  it('identifies owned evidence by its stable ID namespace, not mutable prose', () => {
    expect(
      isSpringAopEvidenceNode({
        ...method,
        id: 'CodeElement:spring-aop:evidence',
        label: 'CodeElement',
      }),
    ).toBe(true);
    expect(
      isSpringAopEvidenceNode({
        ...method,
        id: 'CodeElement:ordinary',
        label: 'CodeElement',
        properties: { ...method.properties, description: 'Spring AOP: lookalike' },
      }),
    ).toBe(false);
  });
});

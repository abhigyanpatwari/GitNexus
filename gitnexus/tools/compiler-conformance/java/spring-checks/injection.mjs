import { compareCodeUnits } from '../../compare.mjs';
import { compareSpringJava } from '../spring-web-java.mjs';
import assert from 'node:assert/strict';
import { runPipelineFromRepo } from '../../../../dist/core/ingestion/pipeline.js';
import { getRelationships, springProject } from '../spring-support.mjs';
import { isDeepStrictEqual } from 'node:util';

/**
 * End-to-end pipeline coverage for Spring DI collection injection (#2200).
 * Real Java sources run through the ACTUAL pipeline (parse worker → field
 * extraction → heritage → `di` phase): an `@Autowired List<IFoo>` field must
 * yield a Property node carrying the extraction contract
 * (`declaredType`/`rawDeclaredType`/`annotations`) and exactly one INJECTS
 * edge per implementer of `IFoo` — while a non-annotated collection field of
 * the very same type contributes nothing. Both prior no-op incarnations of
 * this feature (stripped `declaredType` only; no annotation gate) fail here.
 */

/** A consumer whose collection fields carry NO injection annotation. */

function findProperty(result, name) {
  let found;
  result.graph.forEachNode((n) => {
    if (n.label === 'Property' && n.properties.name === name) found = n;
  });
  if (!found) throw new Error(`Consumer.${name} should be a Property node`);
  return found;
}

/** All INJECTS edges as sorted `sourceName->targetName` pairs (set-equality food). */
function injectsPairs(result) {
  const nameById = new Map();
  result.graph.forEachNode((n) => nameById.set(n.id, String(n.properties.name)));
  return result.graph.relationships
    .filter((r) => r.type === 'INJECTS')
    .map((r) => `${nameById.get(r.sourceId)}->${nameById.get(r.targetId)}`)
    .sort(compareCodeUnits);
}

function injectsDetails(result) {
  const nameById = new Map();
  result.graph.forEachNode((node) => nameById.set(node.id, String(node.properties.name)));
  return result.graph.relationships
    .filter((relationship) => relationship.type === 'INJECTS')
    .map((relationship) => ({
      pair: `${nameById.get(relationship.sourceId)}->${nameById.get(relationship.targetId)}`,
      confidence: relationship.confidence,
      reason: relationship.reason,
    }))
    .sort((left, right) => left.pair.localeCompare(right.pair));
}

function injectionEdges(result) {
  return getRelationships(result, 'INJECTS').map((edge) => ({
    source: edge.source,
    target: edge.target,
    type: edge.rel.type,
    confidence: edge.rel.confidence,
    reason: edge.rel.reason,
  }));
}

export async function verifyDi() {
  // Spring DI collection-injection pipeline (#2200)
  {
    const dir = springProject('collection-injection');
    const result = await runPipelineFromRepo(dir, () => {}, {});
    assert.equal(
      compareSpringJava(dir, result).heritage.length,
      2,
      'javac identifies both implementations of IFoo',
    );
    // extracts the annotated field with the full Property contract (declaredType / rawDeclaredType / annotations)

    // THE extraction pin: both no-op incarnations broke exactly here — the
    // graph never carried a matchable generic type or the gating annotation.
    const foos = findProperty(result, 'foos');
    assert.partialDeepStrictEqual(foos.properties, {
      declaredType: 'List',
      rawDeclaredType: 'List<IFoo>',
    });
    assert.ok(foos.properties.annotations.includes('@Autowired'));
    // extracts the non-annotated field with the same type contract but NO annotations key

    const plain = findProperty(result, 'plain');
    assert.partialDeepStrictEqual(plain.properties, {
      declaredType: 'List',
      rawDeclaredType: 'List<IFoo>',
    });
    // Empty annotation lists are OMITTED (production conditional-spread shape).
    assert.equal(plain.properties.annotations, undefined);
    // emits exactly the two Consumer→implementer INJECTS edges — nothing from `plain`, no self-edges

    // Full set-equality on ALL INJECTS edges in the graph: an extra edge
    // (e.g. one fanned out from the non-annotated `plain` field, or a
    // self-edge) fails this, as does a missing implementer.
    assert.deepStrictEqual(injectsPairs(result), ['Consumer->FooA', 'Consumer->FooB']);
  }
  // Spring DI wildcard-import collection fallback (#2200, #2414)
  {
    const dir = springProject('collection-wildcards');
    const result = await runPipelineFromRepo(dir, () => {}, {});
    assert.equal(
      compareSpringJava(dir, result).heritage.length,
      2,
      'javac identifies both implementations of IFoo',
    );
    // preserves collection edges when multiple wildcard imports prevent annotation FQN resolution

    assert.deepStrictEqual(injectsPairs(result), [
      'WildcardConsumer->FooA',
      'WildcardConsumer->FooB',
    ]);
  }
  // Spring DI pipeline negative control: no injection annotations anywhere (#2200)
  {
    const dir = springProject('unannotated-collection');
    const result = await runPipelineFromRepo(dir, () => {}, {});
    assert.equal(
      compareSpringJava(dir, result).heritage.length,
      2,
      'javac identifies both implementations of IFoo',
    );
    // emits zero INJECTS edges when no field carries an injection annotation

    // The interface + implementers exist, so fan-out WOULD fire if the
    // annotation gate regressed — the pre-U2 false-positive class.
    assert.deepStrictEqual(injectsPairs(result), []);
  }
  // Spring standard injection pipeline (#2414)
  {
    const dir = springProject('java-injection');
    const result = await runPipelineFromRepo(dir, () => {}, {}); // resolves implicit constructor, concrete, field, setter, qualifier, and primary injection
    const details = injectsDetails(result);
    assert.deepStrictEqual(
      details.map((detail) => detail.pair),
      [
        'AmbiguousConsumer->JsonFormatter',
        'AmbiguousConsumer->XmlFormatter',
        'ConstructorConsumer->ConcreteRepo',
        'ConstructorConsumer->FastGateway',
        'DigitBeanNameConsumer->S3Client',
        'EmptyParenConsumer->EmptyParenService',
        'ExplicitConstructorConsumer->ConcreteRepo',
        'FieldConsumer->FastGateway',
        'QualifiedCollectionConsumer->SlowGateway',
        'QualifiedConsumer->SlowGateway',
        'SetterConsumer->ConcreteRepo',
      ],
    );
    {
      const observed = details.find((detail) => detail.pair === 'ConstructorConsumer->FastGateway');
      assert.partialDeepStrictEqual(observed, {
        confidence: 0.95,
      });
      assert.ok(observed.reason.includes('selected @Primary'));
    }
    {
      const observed = details.find((detail) => detail.pair === 'QualifiedConsumer->SlowGateway');
      assert.partialDeepStrictEqual(observed, {
        confidence: 0.95,
      });
      assert.ok(observed.reason.includes('qualifier "slowGateway"'));
    }
    assert.ok(
      details
        .find((detail) => detail.pair === 'SetterConsumer->ConcreteRepo')
        ?.reason.includes('@Inject method'),
    );
    // surfaces unresolved single-bean ambiguity as multiple low-confidence candidates

    const ambiguous = injectsDetails(result).filter((detail) =>
      detail.pair.startsWith('AmbiguousConsumer->'),
    );
    assert.equal(ambiguous.length, 2);
    assert.equal(
      ambiguous.every((detail) => detail.confidence === 0.5),
      true,
    );
    assert.equal(
      ambiguous.every((detail) => detail.reason.includes('ambiguous candidates')),
      true,
    );
    // fails closed for unmanaged implicit constructors and unresolved dynamic qualifiers

    const pairs = injectsDetails(result).map((detail) => detail.pair);
    assert.equal(
      pairs.some((pair) => pair.startsWith('PlainConstructorConsumer->')),
      false,
    );
    assert.equal(
      pairs.some((pair) => pair.startsWith('DynamicQualifierConsumer->')),
      false,
    );
    assert.equal(
      pairs.some((pair) => pair.startsWith('DynamicCollectionQualifierConsumer->')),
      false,
    );
  }
  // Kotlin Spring standard injection pipeline (#2414)
  {
    const dir = springProject('kotlin-injection');
    const result = await runPipelineFromRepo(dir, () => {}, {}); // resolves Kotlin primary/secondary constructors, properties, methods, qualifiers, primary, nullable types, and projections
    const details = injectsDetails(result);
    assert.deepStrictEqual(
      details.map((detail) => detail.pair),
      [
        'CollectionConsumer->FastGateway',
        'CollectionConsumer->SlowGateway',
        'ConstructorConsumer->ConcreteRepo',
        'ConstructorConsumer->FastGateway',
        'ExplicitConstructorConsumer->ConcreteRepo',
        'FieldConsumer->FastGateway',
        'MethodConsumer->ConcreteRepo',
        'MutableCollectionConsumer->FastGateway',
        'MutableCollectionConsumer->SlowGateway',
        'NamedConsumer->SlowGateway',
        'QualifiedConsumer->SlowGateway',
        'QualifiedFieldConsumer->SlowGateway',
        'SetterPropertyConsumer->ConcreteRepo',
      ],
    );
    {
      const observed = details.find((detail) => detail.pair === 'ConstructorConsumer->FastGateway');
      assert.partialDeepStrictEqual(observed, {
        confidence: 0.95,
      });
      assert.ok(observed.reason.includes('selected @Primary'));
    }
    {
      const observed = details.find((detail) => detail.pair === 'QualifiedConsumer->SlowGateway');
      assert.partialDeepStrictEqual(observed, {
        confidence: 0.95,
      });
      assert.ok(observed.reason.includes('qualifier "slowGateway"'));
    }
    assert.ok(
      details
        .find((detail) => detail.pair === 'SetterPropertyConsumer->ConcreteRepo')
        ?.reason.includes('@Inject property'),
    );
    // fails closed for unmanaged or ambiguous constructors, unsupported getter targets, and dynamic qualifiers

    const pairs = injectsPairs(result);
    assert.equal(
      pairs.some((pair) => pair.startsWith('PlainConstructorConsumer->')),
      false,
    );
    assert.equal(
      pairs.some((pair) => pair.startsWith('MultipleConstructorConsumer->')),
      false,
    );
    assert.equal(
      pairs.some((pair) => pair.startsWith('GetterTargetConsumer->')),
      false,
    );
    assert.equal(
      pairs.some((pair) => pair.startsWith('DynamicQualifierConsumer->')),
      false,
    );
  }
}
export async function verifyDynamicLookup() {
  // Spring dynamic lookup production integration

  // resolves Java imports, assignability, concrete targets, ranges, and nested callables
  {
    const root = springProject('dynamic-java');
    const result = await runPipelineFromRepo(root, () => {});
    const edges = injectionEdges(result);
    const observed = edges;
    for (const row of [
      {
        source: 'javaCollection',
        target: 'Impl',
        type: 'INJECTS',
        confidence: 0.8,
        reason: 'Spring dynamic lookup: SpringContextUtil.getBeans(Parent)',
      },
      {
        source: 'javaCollection',
        target: 'SecondImpl',
        type: 'INJECTS',
        confidence: 0.8,
        reason: 'Spring dynamic lookup: SpringContextUtil.getBeans(Parent)',
      },
      {
        source: 'javaSingle',
        target: 'Concrete',
        type: 'INJECTS',
        confidence: 0.9,
        reason: 'Spring dynamic lookup: ctx.getBean(Concrete)',
      },
    ])
      assert.ok(
        observed.some((item) => isDeepStrictEqual(item, row)),
        'Missing row ' + JSON.stringify(row),
      );
    for (const row of [
      {
        source: 'javaBase',
        target: 'Concrete',
        confidence: 0.8,
      },
      {
        source: 'javaRecord',
        target: 'RecordBean',
        confidence: 0.9,
      },
      {
        source: 'javaAmbiguousSingle',
        target: 'Impl',
        confidence: 0.5,
      },
      {
        source: 'javaAmbiguousSingle',
        target: 'SecondImpl',
        confidence: 0.5,
      },
      {
        source: 'run',
        target: 'Impl',
        confidence: 0.8,
      },
      {
        source: 'samePackageLookup',
        target: 'Impl',
        confidence: 0.8,
      },
    ])
      assert.partialDeepStrictEqual(observed, [row]);
    assert.equal(
      edges.some((edge) => edge.source === 'adjacentMiss'),
      false,
    );
    assert.equal(
      edges.some((edge) => edge.source === 'javaOuter'),
      false,
    );
    assert.equal(
      edges.some((edge) => edge.source === 'javaFalsePositives'),
      false,
    );
    assert.equal(
      edges.some((edge) => edge.source === 'ambiguousLookup'),
      false,
    );
    assert.equal(
      edges
        .filter((edge) => edge.source === 'javaAmbiguousSingle')
        .every((edge) => edge.reason.includes('ambiguous candidates: Impl, SecondImpl')),
      true,
    );
    assert.equal(
      edges.some(
        (edge) =>
          edge.source === 'javaCollection' &&
          (edge.target === 'Child' || edge.target === 'OtherImpl'),
      ),
      false,
    );
    assert.equal(
      edges.some((edge) => edge.target === 'Concrete' && edge.confidence === 0.5),
      false,
    );
    assert.equal(
      edges.filter((edge) => edge.source === 'JavaCaller' && edge.target === 'Concrete').length,
      1,
    );
  }
  // resolves Kotlin class literals through the same graph semantics
  {
    const root = springProject('dynamic-kotlin');
    const result = await runPipelineFromRepo(root, () => {});
    const edges = injectionEdges(result);
    const observed = edges;
    for (const row of [
      {
        source: 'kotlinCollection',
        target: 'Impl',
        type: 'INJECTS',
        confidence: 0.8,
        reason: 'Spring dynamic lookup: SpringContextUtil.getBeans(Parent)',
      },
      {
        source: 'kotlinSingle',
        target: 'Concrete',
        type: 'INJECTS',
        confidence: 0.9,
        reason: 'Spring dynamic lookup: ctx.getBean(Concrete)',
      },
    ])
      assert.ok(
        observed.some((item) => isDeepStrictEqual(item, row)),
        'Missing row ' + JSON.stringify(row),
      );
    for (const row of [
      {
        source: 'kotlinBase',
        target: 'Concrete',
        confidence: 0.8,
      },
      {
        source: 'run',
        target: 'Impl',
        confidence: 0.8,
      },
    ])
      assert.partialDeepStrictEqual(observed, [row]);
    assert.equal(
      edges.some((edge) => edge.source === 'adjacentMiss'),
      false,
    );
    assert.equal(
      edges.some((edge) => edge.source === 'kotlinOuter'),
      false,
    );
    assert.equal(
      edges.some((edge) => edge.source === 'kotlinFalsePositives'),
      false,
    );
    assert.equal(
      edges.filter((edge) => edge.source === 'constructor' && edge.target === 'Concrete').length,
      1,
    );
  }
}

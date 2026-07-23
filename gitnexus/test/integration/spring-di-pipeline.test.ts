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
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import type { PipelineResult } from '../../src/types/pipeline.js';
import type { GraphNode } from 'gitnexus-shared';

const IFOO = `package com.example;

public interface IFoo {}
`;

const FOO_A = `package com.example;

public class FooA implements IFoo {}
`;

const FOO_B = `package com.example;

public class FooB implements IFoo {}
`;

const CONSUMER = `package com.example;
import java.util.List;
import org.springframework.beans.factory.annotation.Autowired;

public class Consumer {
  @Autowired private List<IFoo> foos;
  private List<IFoo> plain;
}
`;

const WILDCARD_CONSUMER = `package com.example;
import java.util.*;
import org.springframework.beans.factory.annotation.*;

public class WildcardConsumer {
  @Autowired private List<IFoo> foos;
}
`;

/** A consumer whose collection fields carry NO injection annotation. */
const PLAIN_CONSUMER = `package com.example;
import java.util.List;

public class PlainConsumer {
  private List<IFoo> plain;
  private List<IFoo> cache;
}
`;

function findProperty(result: PipelineResult, name: string): GraphNode | undefined {
  let found: GraphNode | undefined;
  result.graph.forEachNode((n) => {
    if (n.label === 'Property' && n.properties.name === name) found = n;
  });
  return found;
}

/** All INJECTS edges as sorted `sourceName->targetName` pairs (set-equality food). */
function injectsPairs(result: PipelineResult): string[] {
  const nameById = new Map<string, string>();
  result.graph.forEachNode((n) => nameById.set(n.id, String(n.properties.name)));
  return result.graph.relationships
    .filter((r) => r.type === 'INJECTS')
    .map((r) => `${nameById.get(r.sourceId)}->${nameById.get(r.targetId)}`)
    .sort();
}

function injectsDetails(result: PipelineResult) {
  const nameById = new Map<string, string>();
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

describe('Spring DI collection-injection pipeline (#2200)', () => {
  let dir: string;
  let result: PipelineResult;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-spring-di-'));
    fs.writeFileSync(path.join(dir, 'IFoo.java'), IFOO);
    fs.writeFileSync(path.join(dir, 'FooA.java'), FOO_A);
    fs.writeFileSync(path.join(dir, 'FooB.java'), FOO_B);
    fs.writeFileSync(path.join(dir, 'Consumer.java'), CONSUMER);
    result = await runPipelineFromRepo(dir, () => {}, {});
  }, 60_000);

  afterAll(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('extracts the annotated field with the full Property contract (declaredType / rawDeclaredType / annotations)', () => {
    // THE extraction pin: both no-op incarnations broke exactly here — the
    // graph never carried a matchable generic type or the gating annotation.
    const foos = findProperty(result, 'foos');
    expect(foos, 'Consumer.foos should be a Property node').toBeTruthy();
    expect(foos!.properties).toMatchObject({
      declaredType: 'List',
      rawDeclaredType: 'List<IFoo>',
    });
    expect(foos!.properties.annotations).toContain('@Autowired');
  });

  it('extracts the non-annotated field with the same type contract but NO annotations key', () => {
    const plain = findProperty(result, 'plain');
    expect(plain, 'Consumer.plain should be a Property node').toBeTruthy();
    expect(plain!.properties).toMatchObject({
      declaredType: 'List',
      rawDeclaredType: 'List<IFoo>',
    });
    // Empty annotation lists are OMITTED (production conditional-spread shape).
    expect(plain!.properties.annotations).toBeUndefined();
  });

  it('emits exactly the two Consumer→implementer INJECTS edges — nothing from `plain`, no self-edges', () => {
    // Full set-equality on ALL INJECTS edges in the graph: an extra edge
    // (e.g. one fanned out from the non-annotated `plain` field, or a
    // self-edge) fails this, as does a missing implementer.
    expect(injectsPairs(result)).toEqual(['Consumer->FooA', 'Consumer->FooB']);
  });
});

describe('Spring DI wildcard-import collection fallback (#2200, #2414)', () => {
  let dir: string;
  let result: PipelineResult;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-spring-di-wildcard-'));
    fs.writeFileSync(path.join(dir, 'IFoo.java'), IFOO);
    fs.writeFileSync(path.join(dir, 'FooA.java'), FOO_A);
    fs.writeFileSync(path.join(dir, 'FooB.java'), FOO_B);
    fs.writeFileSync(path.join(dir, 'WildcardConsumer.java'), WILDCARD_CONSUMER);
    result = await runPipelineFromRepo(dir, () => {}, {});
  }, 60_000);

  afterAll(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('preserves collection edges when multiple wildcard imports prevent annotation FQN resolution', () => {
    expect(injectsPairs(result)).toEqual(['WildcardConsumer->FooA', 'WildcardConsumer->FooB']);
  });
});

describe('Spring DI pipeline negative control: no injection annotations anywhere (#2200)', () => {
  let dir: string;
  let result: PipelineResult;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-spring-di-neg-'));
    fs.writeFileSync(path.join(dir, 'IFoo.java'), IFOO);
    fs.writeFileSync(path.join(dir, 'FooA.java'), FOO_A);
    fs.writeFileSync(path.join(dir, 'FooB.java'), FOO_B);
    fs.writeFileSync(path.join(dir, 'PlainConsumer.java'), PLAIN_CONSUMER);
    result = await runPipelineFromRepo(dir, () => {}, {});
  }, 60_000);

  afterAll(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('emits zero INJECTS edges when no field carries an injection annotation', () => {
    // The interface + implementers exist, so fan-out WOULD fire if the
    // annotation gate regressed — the pre-U2 false-positive class.
    expect(injectsPairs(result)).toEqual([]);
  });
});

describe('Spring standard injection pipeline (#2414)', () => {
  let dir: string;
  let result: PipelineResult;

  const sources: Record<string, string> = {
    'PaymentGateway.java': `package com.example;
public interface PaymentGateway {}
`,
    'FastGateway.java': `package com.example;
import org.springframework.stereotype.Service;
import org.springframework.context.annotation.Primary;
@Service @Primary
public class FastGateway implements PaymentGateway {}
`,
    'SlowGateway.java': `package com.example;
import org.springframework.stereotype.Service;
@Service("slowGateway")
public class SlowGateway implements PaymentGateway {}
`,
    'ConcreteRepo.java': `package com.example;
import org.springframework.stereotype.Repository;
@Repository
public class ConcreteRepo {}
`,
    'S3Client.java': `package com.example;
import org.springframework.stereotype.Service;
@Service
public class S3Client {}
`,
    'DigitBeanNameConsumer.java': `package com.example;
import org.springframework.stereotype.Service;
import org.springframework.beans.factory.annotation.Qualifier;
@Service
public class DigitBeanNameConsumer {
  public DigitBeanNameConsumer(@Qualifier("s3Client") S3Client client) {}
}
`,
    'EmptyParenService.java': `package com.example;
import org.springframework.stereotype.Service;
@Service()
public class EmptyParenService {}
`,
    'EmptyParenConsumer.java': `package com.example;
import org.springframework.stereotype.Service;
import org.springframework.beans.factory.annotation.Qualifier;
@Service
public class EmptyParenConsumer {
  public EmptyParenConsumer(
    @Qualifier("emptyParenService") EmptyParenService service
  ) {}
}
`,
    'ConstructorConsumer.java': `package com.example;
import org.springframework.stereotype.Service;
@Service
public class ConstructorConsumer {
  public ConstructorConsumer(PaymentGateway gateway, ConcreteRepo repo) {}
}
`,
    'ExplicitConstructorConsumer.java': `package com.example;
import org.springframework.stereotype.Service;
import org.springframework.beans.factory.annotation.Autowired;
@Service
public class ExplicitConstructorConsumer {
  public ExplicitConstructorConsumer() {}
  @Autowired public ExplicitConstructorConsumer(ConcreteRepo repo) {}
}
`,
    'QualifiedConsumer.java': `package com.example;
import org.springframework.stereotype.Service;
import org.springframework.beans.factory.annotation.Qualifier;
@Service
public class QualifiedConsumer {
  public QualifiedConsumer(@Qualifier("slowGateway") PaymentGateway gateway) {}
}
`,
    'DynamicQualifierConsumer.java': `package com.example;
import org.springframework.stereotype.Service;
import org.springframework.beans.factory.annotation.Qualifier;
@Service
public class DynamicQualifierConsumer {
  private static final String GATEWAY = "slowGateway";
  public DynamicQualifierConsumer(@Qualifier(GATEWAY) PaymentGateway gateway) {}
}
`,
    'DynamicCollectionQualifierConsumer.java': `package com.example;
import java.util.List;
import org.springframework.stereotype.Service;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
@Service
public class DynamicCollectionQualifierConsumer {
  private static final String GATEWAY = "slowGateway";
  @Autowired @Qualifier(GATEWAY) private List<PaymentGateway> gateways;
}
`,
    'PlainConstructorConsumer.java': `package com.example;
public class PlainConstructorConsumer {
  public PlainConstructorConsumer(PaymentGateway gateway) {}
}
`,
    'FieldConsumer.java': `package com.example;
import org.springframework.stereotype.Service;
import org.springframework.beans.factory.annotation.Autowired;
@Service
public class FieldConsumer {
  @Autowired private PaymentGateway gateway;
}
`,
    'QualifiedCollectionConsumer.java': `package com.example;
import java.util.List;
import org.springframework.stereotype.Service;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
@Service
public class QualifiedCollectionConsumer {
  @Autowired @Qualifier("slowGateway") private List<PaymentGateway> gateways;
}
`,
    'SetterConsumer.java': `package com.example;
import org.springframework.stereotype.Service;
import jakarta.inject.Inject;
@Service
public class SetterConsumer {
  @Inject public void setRepo(ConcreteRepo repo) {}
}
`,
    'Formatter.java': `package com.example;
public interface Formatter {}
`,
    'JsonFormatter.java': `package com.example;
import org.springframework.stereotype.Service;
@Service
public class JsonFormatter implements Formatter {}
`,
    'XmlFormatter.java': `package com.example;
import org.springframework.stereotype.Service;
@Service
public class XmlFormatter implements Formatter {}
`,
    'AmbiguousConsumer.java': `package com.example;
import org.springframework.stereotype.Service;
@Service
public class AmbiguousConsumer {
  public AmbiguousConsumer(Formatter formatter) {}
}
`,
  };

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-spring-standard-di-'));
    for (const [fileName, source] of Object.entries(sources)) {
      fs.writeFileSync(path.join(dir, fileName), source);
    }
    result = await runPipelineFromRepo(dir, () => {}, {});
  }, 60_000);

  afterAll(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('resolves implicit constructor, concrete, field, setter, qualifier, and primary injection', () => {
    const details = injectsDetails(result);
    expect(details.map((detail) => detail.pair)).toEqual([
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
    ]);

    expect(
      details.find((detail) => detail.pair === 'ConstructorConsumer->FastGateway'),
    ).toMatchObject({ confidence: 0.95, reason: expect.stringContaining('selected @Primary') });
    expect(
      details.find((detail) => detail.pair === 'QualifiedConsumer->SlowGateway'),
    ).toMatchObject({
      confidence: 0.95,
      reason: expect.stringContaining('qualifier "slowGateway"'),
    });
    expect(
      details.find((detail) => detail.pair === 'SetterConsumer->ConcreteRepo')?.reason,
    ).toContain('@Inject method');
  });

  it('surfaces unresolved single-bean ambiguity as multiple low-confidence candidates', () => {
    const ambiguous = injectsDetails(result).filter((detail) =>
      detail.pair.startsWith('AmbiguousConsumer->'),
    );
    expect(ambiguous).toHaveLength(2);
    expect(ambiguous.every((detail) => detail.confidence === 0.5)).toBe(true);
    expect(ambiguous.every((detail) => detail.reason.includes('ambiguous candidates'))).toBe(true);
  });

  it('fails closed for unmanaged implicit constructors and unresolved dynamic qualifiers', () => {
    const pairs = injectsDetails(result).map((detail) => detail.pair);
    expect(pairs.some((pair) => pair.startsWith('PlainConstructorConsumer->'))).toBe(false);
    expect(pairs.some((pair) => pair.startsWith('DynamicQualifierConsumer->'))).toBe(false);
    expect(pairs.some((pair) => pair.startsWith('DynamicCollectionQualifierConsumer->'))).toBe(
      false,
    );
  });
});

describe('Kotlin Spring standard injection pipeline (#2414)', () => {
  let dir: string;
  let result: PipelineResult;

  const sources: Record<string, string> = {
    'PaymentGateway.kt': `package com.example
interface PaymentGateway
`,
    'FastGateway.kt': `package com.example
import org.springframework.context.annotation.Primary
import org.springframework.stereotype.Service
@Service @Primary
class FastGateway : PaymentGateway
`,
    'SlowGateway.kt': `package com.example
import org.springframework.stereotype.Service
@Service("slowGateway")
class SlowGateway : PaymentGateway
`,
    'ConcreteRepo.kt': `package com.example
import org.springframework.stereotype.Repository
@Repository
class ConcreteRepo
`,
    'ConstructorConsumer.kt': `package com.example
import org.springframework.stereotype.Service
@Service
class ConstructorConsumer(
  val gateway: PaymentGateway,
  repo: ConcreteRepo?,
)
`,
    'ExplicitConstructorConsumer.kt': `package com.example
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.stereotype.Service
@Service
class ExplicitConstructorConsumer() {
  @Autowired constructor(repo: ConcreteRepo) : this()
}
`,
    'QualifiedConsumer.kt': `package com.example
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.stereotype.Service
@Service
class QualifiedConsumer(
  @param:Qualifier("slowGateway") gateway: PaymentGateway,
)
`,
    'NamedConsumer.kt': `package com.example
import jakarta.inject.Named
import org.springframework.stereotype.Service
@Service
class NamedConsumer(@Named("slowGateway") gateway: PaymentGateway)
`,
    'FieldConsumer.kt': `package com.example
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.stereotype.Service
@Service
class FieldConsumer {
  @field:Autowired
  lateinit var gateway: PaymentGateway
}
`,
    'QualifiedFieldConsumer.kt': `package com.example
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.stereotype.Service
@Service
class QualifiedFieldConsumer {
  @field:Autowired
  @field:Qualifier("slowGateway")
  lateinit var gateway: PaymentGateway
}
`,
    'SetterPropertyConsumer.kt': `package com.example
import jakarta.inject.Inject
import org.springframework.stereotype.Service
@Service
class SetterPropertyConsumer {
  @set:Inject
  var repo: ConcreteRepo? = null
}
`,
    'MethodConsumer.kt': `package com.example
import javax.inject.Inject
import org.springframework.stereotype.Service
@Service
class MethodConsumer {
  @Inject fun setRepo(repo: ConcreteRepo) {}
}
`,
    'CollectionConsumer.kt': `package com.example
import org.springframework.stereotype.Service
@Service
class CollectionConsumer(val gateways: List<out PaymentGateway>)
`,
    'MutableCollectionConsumer.kt': `package com.example
import org.springframework.stereotype.Service
@Service
class MutableCollectionConsumer(val gateways: MutableList<PaymentGateway?>?)
`,
    'PlainConstructorConsumer.kt': `package com.example
class PlainConstructorConsumer(gateway: PaymentGateway)
`,
    'MultipleConstructorConsumer.kt': `package com.example
import org.springframework.stereotype.Service
@Service
class MultipleConstructorConsumer(gateway: PaymentGateway) {
  constructor(repo: ConcreteRepo) : this(FastGateway())
}
`,
    'GetterTargetConsumer.kt': `package com.example
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.stereotype.Service
@Service
class GetterTargetConsumer {
  @get:Autowired
  var gateway: PaymentGateway? = null
}
`,
    'DynamicQualifierConsumer.kt': `package com.example
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.stereotype.Service
const val GATEWAY = "slowGateway"
@Service
class DynamicQualifierConsumer(@Qualifier(GATEWAY) gateway: PaymentGateway)
`,
  };

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-kotlin-spring-standard-di-'));
    for (const [fileName, source] of Object.entries(sources)) {
      fs.writeFileSync(path.join(dir, fileName), source);
    }
    result = await runPipelineFromRepo(dir, () => {}, {});
  }, 60_000);

  afterAll(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('resolves Kotlin primary/secondary constructors, properties, methods, qualifiers, primary, nullable types, and projections', () => {
    const details = injectsDetails(result);
    expect(details.map((detail) => detail.pair)).toEqual([
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
    ]);

    expect(
      details.find((detail) => detail.pair === 'ConstructorConsumer->FastGateway'),
    ).toMatchObject({ confidence: 0.95, reason: expect.stringContaining('selected @Primary') });
    expect(
      details.find((detail) => detail.pair === 'QualifiedConsumer->SlowGateway'),
    ).toMatchObject({
      confidence: 0.95,
      reason: expect.stringContaining('qualifier "slowGateway"'),
    });
    expect(
      details.find((detail) => detail.pair === 'SetterPropertyConsumer->ConcreteRepo')?.reason,
    ).toContain('@Inject property');
  });

  it('fails closed for unmanaged or ambiguous constructors, unsupported getter targets, and dynamic qualifiers', () => {
    const pairs = injectsPairs(result);
    expect(pairs.some((pair) => pair.startsWith('PlainConstructorConsumer->'))).toBe(false);
    expect(pairs.some((pair) => pair.startsWith('MultipleConstructorConsumer->'))).toBe(false);
    expect(pairs.some((pair) => pair.startsWith('GetterTargetConsumer->'))).toBe(false);
    expect(pairs.some((pair) => pair.startsWith('DynamicQualifierConsumer->'))).toBe(false);
  });
});

import { compareCodeUnits } from '../../compare.mjs';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { runPipelineFromRepo } from '../../../../dist/core/ingestion/pipeline.js';
import { SPRING_CONFIG_DESCRIPTION } from '../../../../dist/core/ingestion/frameworks/spring/config-bindings.js';
import { createTempDir } from '../../../../test/helpers/test-db.ts';
import { springFixture, withIndexedBackend, springProject } from '../spring-support.mjs';
export async function verifyConfig() {
  const FIXTURE = springFixture('spring-config-app');
  const SHADOW_FIXTURE = springFixture('spring-config-shadow-app');
  // Spring configuration binding pipeline
  {
    let uses;
    const nodeNamed = (name, fileSuffix) =>
      nodes.find(
        (node) =>
          node.properties.name === name &&
          (fileSuffix === undefined || String(node.properties.filePath).endsWith(fileSuffix)),
      );
    const targetsFrom = (source) =>
      uses
        .filter((edge) => edge.sourceId === source.id)
        .map((edge) => String(result.graph.getNode(edge.targetId)?.properties.name))
        .sort(compareCodeUnits);
    const targetFilesFrom = (source, targetName) =>
      uses
        .filter((edge) => edge.sourceId === source.id)
        .map((edge) => result.graph.getNode(edge.targetId))
        .filter((node) => node?.properties.name === targetName)
        .map((node) => String(node?.properties.filePath))
        .sort(compareCodeUnits);
    const result = await runPipelineFromRepo(FIXTURE, () => {}, {
      skipGraphPhases: true,
    });
    const nodes = [...result.graph.iterNodes()];
    uses = [...result.graph.iterRelationshipsByType('USES')].filter((edge) =>
      edge.reason.startsWith('spring-config:'),
    );
    // creates key-only Property nodes for properties and profile YAML files

    const propertiesKey = nodeNamed('payment.timeout', 'application.properties');
    assert.notEqual(propertiesKey, undefined);
    assert.equal(Object.hasOwn(propertiesKey?.properties, 'language'), false);
    assert.ok(
      nodeNamed('service.endpoint', 'application-dev.yml')?.properties.description.includes(
        'profile: dev',
      ),
    );
    assert.equal(
      nodeNamed('service.retry.max-attempts', 'application-dev.yml')?.properties.startLine,
      3,
    );
    assert.equal(
      nodes.some((node) => JSON.stringify(node.properties).includes('service.example.test')),
      false,
    );
    // links Value fields to exact keys and leaves missing placeholders unresolved

    const timeout = nodeNamed('timeout', 'ConfigConsumers.java');
    const missing = nodeNamed('missing', 'ConfigConsumers.java');
    assert.notEqual(timeout, undefined);
    assert.notEqual(missing, undefined);
    if (timeout === undefined || missing === undefined) throw new Error('fixture fields missing');
    assert.deepStrictEqual(targetsFrom(timeout), ['payment.timeout']);
    assert.deepStrictEqual(targetsFrom(missing), []);
    assert.ok(
      (missing?.properties.description).includes('Spring config unresolved: payment.missing'),
    );
    const ktTimeout = nodeNamed('timeout', 'ConfigConsumers.kt');
    const ktMissing = nodeNamed('missing', 'ConfigConsumers.kt');
    assert.notEqual(ktTimeout, undefined);
    assert.notEqual(ktMissing, undefined);
    if (ktTimeout === undefined || ktMissing === undefined) {
      throw new Error('kotlin fixture fields missing');
    }
    assert.deepStrictEqual(targetsFrom(ktTimeout), ['payment.timeout']);
    assert.deepStrictEqual(targetsFrom(ktMissing), []);
    assert.ok(
      (ktMissing?.properties.description).includes('Spring config unresolved: payment.missing'),
    );
    // links ConfigurationProperties classes and relaxed field names to their prefix
    {
      const owner = nodeNamed('ServiceProperties', 'ConfigConsumers.java');
      const endpoint = nodeNamed('endpoint', 'ConfigConsumers.java');
      const retry = nodeNamed('retry', 'ConfigConsumers.java');
      assert.notEqual(owner, undefined);
      if (owner === undefined || endpoint === undefined || retry === undefined) {
        throw new Error('fixture ConfigurationProperties symbols missing');
      }
      assert.deepStrictEqual(targetsFrom(owner), [
        'service.endpoint',
        'service.endpoint',
        'service.retry.max-attempts',
      ]);
      assert.deepStrictEqual(targetsFrom(endpoint), ['service.endpoint', 'service.endpoint']);
      assert.deepStrictEqual(targetFilesFrom(endpoint, 'service.endpoint'), [
        'src/main/resources/application-dev.yml',
        'src/main/resources/application.properties',
      ]);
      assert.deepStrictEqual(targetsFrom(retry), ['service.retry.max-attempts']);
      const ktOwner = nodeNamed('ServiceProperties', 'ConfigConsumers.kt');
      const ktEndpoint = nodeNamed('endpoint', 'ConfigConsumers.kt');
      const ktRetry = nodeNamed('retry', 'ConfigConsumers.kt');
      assert.notEqual(ktOwner, undefined);
      if (ktOwner === undefined || ktEndpoint === undefined || ktRetry === undefined) {
        throw new Error('kotlin fixture ConfigurationProperties symbols missing');
      }
      assert.deepStrictEqual(targetsFrom(ktOwner), [
        'service.endpoint',
        'service.endpoint',
        'service.retry.max-attempts',
      ]);
      assert.deepStrictEqual(targetsFrom(ktEndpoint), ['service.endpoint', 'service.endpoint']);
      assert.deepStrictEqual(targetFilesFrom(ktEndpoint, 'service.endpoint'), [
        'src/main/resources/application-dev.yml',
        'src/main/resources/application.properties',
      ]);
      assert.deepStrictEqual(targetsFrom(ktRetry), ['service.retry.max-attempts']);
    }
    // keeps the class-level binding when no field relaxed-name matches
    {
      const owner = nodeNamed('UnmatchedServiceProperties', 'ConfigConsumers.java');
      const unrelated = nodeNamed('unrelated', 'ConfigConsumers.java');
      if (owner === undefined || unrelated === undefined) {
        throw new Error('unmatched ConfigurationProperties symbols missing');
      }
      assert.deepStrictEqual(targetsFrom(owner), [
        'service.endpoint',
        'service.endpoint',
        'service.retry.max-attempts',
      ]);
      assert.deepStrictEqual(targetsFrom(unrelated), []);
      const ktOwner = nodeNamed('UnmatchedServiceProperties', 'ConfigConsumers.kt');
      const ktUnrelated = nodeNamed('unrelated', 'ConfigConsumers.kt');
      if (ktOwner === undefined || ktUnrelated === undefined) {
        throw new Error('kotlin unmatched ConfigurationProperties symbols missing');
      }
      assert.deepStrictEqual(targetsFrom(ktOwner), [
        'service.endpoint',
        'service.endpoint',
        'service.retry.max-attempts',
      ]);
      assert.deepStrictEqual(targetsFrom(ktUnrelated), []);
    }
  }
  // Spring configuration annotation attribution
  {
    // fails closed when a same-package annotation shadows a Spring wildcard import

    const result = await runPipelineFromRepo(SHADOW_FIXTURE, () => {}, {
      skipGraphPhases: true,
    });
    const fake = [...result.graph.iterNodes()].find(
      (node) =>
        node.properties.name === 'fake' &&
        String(node.properties.filePath).endsWith('Shadowed.java'),
    );
    assert.notEqual(fake, undefined);
    if (fake === undefined) throw new Error('shadow fixture field missing');
    assert.deepStrictEqual(
      [...result.graph.iterRelationshipsByType('USES')].filter(
        (edge) => edge.sourceId === fake.id && edge.reason.startsWith('spring-config:'),
      ),
      [],
    );
    assert.ok(!String(fake.properties.description ?? '').includes('Spring config unresolved:'));
  }
  // Spring configuration file safety bounds

  // fails closed for malformed and oversized configuration files
  const repo = await createTempDir();
  const previousSize = process.env.GITNEXUS_MAX_FILE_SIZE;
  try {
    const resources = path.join(repo.dbPath, 'src', 'main', 'resources');
    await mkdir(resources, {
      recursive: true,
    });
    await writeFile(path.join(resources, 'application-broken.yml'), 'broken: [\n', 'utf8');
    await writeFile(
      path.join(resources, 'application-oversized.properties'),
      `oversized.key=${'x'.repeat(2 * 1024 * 1024)}\n`,
      'utf8',
    );

    // Let the scanner admit the file so this exercises springConfig's
    // stricter 2 MiB cap rather than the scanner's default 512 KiB cap.
    process.env.GITNEXUS_MAX_FILE_SIZE = '4096';
    const result = await runPipelineFromRepo(repo.dbPath, () => {}, {
      skipGraphPhases: true,
    });
    const configNodes = [...result.graph.iterNodes()].filter((node) =>
      String(node.properties.description ?? '').startsWith(SPRING_CONFIG_DESCRIPTION),
    );
    assert.deepStrictEqual(configNodes, []);
  } finally {
    if (previousSize === undefined) delete process.env.GITNEXUS_MAX_FILE_SIZE;
    else process.env.GITNEXUS_MAX_FILE_SIZE = previousSize;
    await repo.cleanup();
  }
}
export async function verifyConditionals() {
  // Spring profiles, conditionals, and auto-configuration pipeline (#2415)

  const nodeNamed = (name) => nodes.find((node) => node.properties.name === name);
  const nodesQualified = (qualifiedName) =>
    nodes.filter((node) => node.properties.qualifiedName === qualifiedName);
  const outgoingConditions = (name) => {
    const source = nodeNamed(name);
    if (source === undefined) return [];
    return conditions
      .filter((edge) => edge.sourceId === source.id)
      .map((edge) => ({
        target: String(result.graph.getNode(edge.targetId)?.properties.name),
        reason: edge.reason,
      }));
  };
  const dir = springProject('conditions');
  const result = await runPipelineFromRepo(dir, () => {}, {
    skipGraphPhases: true,
  });
  const nodes = [...result.graph.iterNodes()];
  const conditions = [...result.graph.iterRelationshipsByType('CONDITIONAL_ON')];
  const declarations = [...result.graph.iterRelationshipsByType('DECLARES')]; // captures Java and Kotlin profile gates as explicit unknown-activation evidence
  {
    const rows = outgoingConditions('ProfiledJavaConfig');
    assert.equal(rows.length, 1);
    assert.partialDeepStrictEqual(rows[0], {
      target: '@Profile',
    });
    assert.ok(rows[0].reason.includes('activation=unknown'));
  }
  {
    const rows = outgoingConditions('ProfiledKotlinConfig');
    assert.equal(rows.length, 1);
    assert.partialDeepStrictEqual(rows[0], {
      target: '@Profile',
    });
    assert.ok(rows[0].reason.includes('activation=unknown'));
  }
  for (const [className, annotationLine] of [
    ['ProfiledJavaConfig', 11],
    ['ProfiledKotlinConfig', 10],
  ]) {
    const owner = nodeNamed(className);
    const edge = conditions.find((candidate) => candidate.sourceId === owner?.id);
    const condition = edge === undefined ? undefined : result.graph.getNode(edge.targetId);
    assert.equal(condition?.properties.startLine, annotationLine);
  }
  // strips Trojan-Source controls from condition descriptions before MCP exposure

  const conditionDescriptions = nodes
    .filter((node) => node.label === 'Annotation')
    .map((node) => String(node.properties.description));
  assert.ok(conditionDescriptions.length > 0);
  assert.equal(
    conditionDescriptions.every(
      (description) => !/[\u200b-\u200d\u202a-\u202e\u2066-\u2069\ufeff]/u.test(description),
    ),
    true,
  );
  assert.equal(
    conditions.every(
      (edge) => !/[\u200b-\u200d\u202a-\u202e\u2066-\u2069\ufeff]/u.test(edge.reason),
    ),
    true,
  );
  // connects Java/Kotlin property conditions, including raw/text-block strings, to config keys

  {
    const rows = outgoingConditions('paymentService');
    assert.equal(rows.length, 1);
    assert.partialDeepStrictEqual(rows[0], {
      target: 'feature.payments.enabled',
    });
    assert.ok(rows[0].reason.includes('@ConditionalOnProperty'));
  }
  {
    const rows = outgoingConditions('searchService');
    assert.equal(rows.length, 1);
    assert.partialDeepStrictEqual(rows[0], {
      target: 'feature.search.enabled',
    });
    assert.ok(rows[0].reason.includes('@ConditionalOnProperty'));
  }
  {
    const rows = outgoingConditions('booleanSearchService');
    assert.equal(rows.length, 1);
    assert.partialDeepStrictEqual(rows[0], {
      target: 'feature.search.enabled',
    });
    assert.ok(rows[0].reason.includes('@ConditionalOnBooleanProperty'));
  }
  {
    const rows = outgoingConditions('textBlockPaymentService');
    assert.equal(rows.length, 1);
    assert.partialDeepStrictEqual(rows[0], {
      target: 'feature.payments.enabled',
    });
    assert.ok(rows[0].reason.includes('@ConditionalOnProperty'));
  }
  // preserves non-property conditional variants for both languages

  {
    const observed = outgoingConditions('JavaAutoConfig');
    const expected = [
      {
        target: '@ConditionalOnClass',
      },
    ];
    assert.equal(observed.length, expected.length);
    for (const [index, row] of expected.entries())
      assert.partialDeepStrictEqual(observed[index], row);
  }
  {
    const observed = outgoingConditions('KotlinAutoConfig');
    const expected = [
      {
        target: '@ConditionalOnMissingBean',
      },
    ];
    assert.equal(observed.length, expected.length);
    for (const [index, row] of expected.entries())
      assert.partialDeepStrictEqual(observed[index], row);
  }
  // uses metadata DECLARES evidence without claiming annotation-based registration

  const metadataDeclarations = declarations.filter(
    (edge) =>
      edge.reason === 'spring-auto-configuration-import' ||
      edge.reason === 'spring-auto-configuration-factory',
  );
  const targetNames = metadataDeclarations
    .map((edge) => String(result.graph.getNode(edge.targetId)?.properties.name))
    .sort(compareCodeUnits);
  assert.deepStrictEqual(targetNames, [
    'JavaAutoConfig',
    'KotlinAutoConfig',
    'LegacyStarterAutoConfiguration',
    'SharedAutoConfiguration',
    'SharedAutoConfiguration',
    'StarterAutoConfiguration',
  ]);
  assert.equal(
    metadataDeclarations.some(
      (edge) =>
        result.graph.getNode(edge.targetId)?.properties.name === 'OrdinaryApplicationConfig',
    ),
    false,
  );
  assert.equal(
    metadataDeclarations.every((edge) =>
      String(result.graph.getNode(edge.sourceId)?.properties.filePath).includes('META-INF'),
    ),
    true,
  );
  assert.ok(
    nodesQualified('com.vendor.StarterAutoConfiguration')[0]?.properties.description.includes(
      'implementation source unavailable',
    ),
  );
  // never falls back from metadata FQN to an unrelated simple-name match

  const declaration = declarations.find(
    (edge) =>
      result.graph.getNode(edge.targetId)?.properties.qualifiedName ===
      'com.vendor.StarterAutoConfiguration',
  );
  assert.notEqual(declaration, undefined);
  assert.ok(result.graph.getNode(declaration.targetId)?.properties.filePath.includes('META-INF'));
  assert.equal(
    declarations.some(
      (edge) =>
        result.graph.getNode(edge.targetId)?.properties.qualifiedName ===
        'com.local.StarterAutoConfiguration',
    ),
    false,
  );
  // deduplicates missing source classes by normalized FQN across metadata files

  const shared = nodesQualified('com.vendor.SharedAutoConfiguration');
  assert.equal(shared.length, 1);
  assert.equal(declarations.filter((edge) => edge.targetId === shared[0]?.id).length, 2);
  assert.deepStrictEqual(
    declarations
      .filter((edge) => edge.targetId === shared[0]?.id)
      .map((edge) => edge.reason)
      .sort(compareCodeUnits),
    ['spring-auto-configuration-factory', 'spring-auto-configuration-import'],
  );
  // fails closed when duplicate real classes share one FQN

  const duplicates = nodesQualified('com.duplicate.DuplicateAutoConfiguration');
  assert.equal(duplicates.length, 2);
  assert.equal(
    declarations.some((edge) => duplicates.some((duplicate) => duplicate.id === edge.targetId)),
    false,
  );
  assert.equal(
    duplicates.some((node) =>
      String(node.properties.description).includes('implementation source unavailable'),
    ),
    false,
  );
  // recognizes AutoConfiguration as a Spring Bean candidate in Java and Kotlin

  assert.deepStrictEqual(nodeNamed('JavaAutoConfig')?.properties.frameworkAnnotations, [
    'org.springframework.boot.autoconfigure.AutoConfiguration',
  ]);
  assert.deepStrictEqual(nodeNamed('KotlinAutoConfig')?.properties.frameworkAnnotations, [
    'org.springframework.boot.autoconfigure.AutoConfiguration',
  ]);
}
export async function verifyConfigBackend() {
  const CONSUMER_ID = 'Property:src/Config.java:DirectValues.timeout';
  const CONFIG_ID = 'Property:spring-config:application.properties:payment.timeout';
  const SEED = [
    `CREATE (p:\`Property\` {id:'${CONSUMER_ID}', name:'timeout', filePath:'src/Config.java', startLine:4, endLine:4, content:'', description:'', declaredType:'int'})`,
    `CREATE (p:\`Property\` {id:'${CONFIG_ID}', name:'payment.timeout', filePath:'application.properties', startLine:1, endLine:1, content:'', description:'Spring configuration property', declaredType:''})`,
    `MATCH (consumer:\`Property\` {id:'${CONSUMER_ID}'}), (config:\`Property\` {id:'${CONFIG_ID}'}) CREATE (consumer)-[:CodeRelation {type:'USES', confidence:1.0, reason:'spring-config:@Value payment.timeout'}]->(config)`,
  ];
  await withIndexedBackend('spring-config-mcp', SEED, async (handle, backend) => {
    // Spring configuration context and impact visibility

    // shows configuration dependencies in context without special query flags
    {
      const context = await backend.callTool('context', {
        uid: CONSUMER_ID,
      });
      const observed = context.outgoing.uses;
      const expected = [
        {
          uid: CONFIG_ID,
          name: 'payment.timeout',
          filePath: 'application.properties',
        },
      ];
      assert.equal(observed.length, expected.length);
      for (const [index, row] of expected.entries())
        assert.partialDeepStrictEqual(observed[index], row);
    }
    // shows consumers in upstream impact from a configuration key
    {
      const impact = await backend.callTool('impact', {
        target_uid: CONFIG_ID,
        target: 'payment.timeout',
        direction: 'upstream',
      });
      assert.notEqual(impact.risk, 'UNKNOWN');
      const observed = impact.byDepth[1];
      const expected = [
        {
          id: CONSUMER_ID,
          name: 'timeout',
          relationType: 'USES',
        },
      ];
      assert.equal(observed.length, expected.length);
      for (const [index, row] of expected.entries())
        assert.partialDeepStrictEqual(observed[index], row);
    }
  });
}

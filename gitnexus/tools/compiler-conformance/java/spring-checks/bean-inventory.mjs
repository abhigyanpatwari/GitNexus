import assert from 'node:assert/strict';
import { runPipelineFromRepo } from '../../../../dist/core/ingestion/pipeline.js';
import { decodeSpringBeanFactoryReason } from '../../../../dist/core/ingestion/frameworks/spring/bean-factories.js';
import { springFixture, withIndexedBackend, springProject } from '../spring-support.mjs';
export async function verifyBean() {
  const { graph } = await runPipelineFromRepo(springFixture('spring-bean-app'), () => {});
  const symbols = new Map([...graph.iterNodes()].map((node) => [node.properties.name, node]));
  const expected = {
    'org.springframework.stereotype.Component': ['WidgetComponent', 'KotlinWidgetComponent'],
    'org.springframework.stereotype.Service': [
      'BillingService',
      'NestedService',
      'ExplicitAlongsideWildcard',
      'WildcardService',
      'KotlinBillingService',
      'KotlinAbstractService',
      'KotlinServiceId',
      'KotlinNestedService',
    ],
    'org.springframework.stereotype.Repository': ['WidgetRepository', 'KotlinWildcardRepository'],
    'org.springframework.stereotype.Controller': ['PageController'],
    'org.springframework.web.bind.annotation.RestController': [
      'ApiController',
      'KotlinApiController',
    ],
    'org.springframework.context.annotation.Configuration': [
      'AppConfiguration',
      'KotlinConfiguration',
    ],
  };
  for (const [annotation, names] of Object.entries(expected)) {
    for (const name of names) {
      const node = symbols.get(name);
      assert.ok(node, name);
      if (!name.startsWith('Kotlin')) assert.equal(node.label, 'Class', name);
      assert.deepEqual(node.properties.frameworkAnnotations, [annotation], name);
    }
  }
  for (const name of [
    'PlainUtility',
    'WildcardCandidate',
    'MultipleWildcardService',
    'MemberShadowedService',
    'ConflictingBean',
    'ComposedService',
    'ExplicitCustomService',
    'TopLevelShadowedComponent',
    'InheritedMemberShadowedService',
    'StaticImportShadowedService',
    'KotlinServiceContract',
    'KotlinServiceObject',
    'KotlinServiceState',
    'KotlinServiceMarker',
    'KotlinComposedCandidate',
    'KotlinMemberShadowedService',
    'KotlinShadowedService',
    'KotlinMultipleWildcardService',
  ]) {
    const node = symbols.get(name);
    assert.ok(node, name);
    if (!name.startsWith('Kotlin')) assert.equal(node.label, 'Class', name);
    assert.equal(Object.hasOwn(node.properties, 'frameworkAnnotations'), false, name);
  }
  const ping = [...graph.iterNodes()].find(
    (node) => node.label === 'Route' && node.properties.name === '/ping',
  );
  assert.ok(ping);
  assert.ok(
    [...graph.iterRelationshipsByType('HANDLES_ROUTE')].some((edge) => edge.targetId === ping.id),
  );
}
export async function verifyBeanResource() {
  function nodeNames(result) {
    const names = new Map();
    result.graph.forEachNode((node) => names.set(node.id, String(node.properties.name)));
    return names;
  }
  function injectionDetails(result) {
    const names = nodeNames(result);
    return result.graph.relationships
      .filter((relationship) => relationship.type === 'INJECTS')
      .map((relationship) => ({
        pair: `${names.get(relationship.sourceId)}->${names.get(relationship.targetId)}`,
        confidence: relationship.confidence,
        reason: relationship.reason,
      }))
      .sort((left, right) => left.pair.localeCompare(right.pair));
  }
  function beanDeclarations(result) {
    const names = nodeNames(result);
    return result.graph.relationships
      .filter((relationship) => relationship.type === 'DECLARES')
      .flatMap((relationship) => {
        const metadata = decodeSpringBeanFactoryReason(relationship.reason);
        return metadata === undefined
          ? []
          : [
              {
                factory: names.get(relationship.sourceId),
                bean: names.get(relationship.targetId),
                metadata,
              },
            ];
      })
      .sort((left, right) => String(left.factory).localeCompare(String(right.factory)));
  }
  // Spring Bean factories and Resource injection pipeline (#2413, #2633)
  const dir = springProject('bean-resources');
  const result = await runPipelineFromRepo(dir, () => {}, {}); // creates Java and Kotlin Bean declarations with names, aliases, and returned types
  const declarations = beanDeclarations(result);
  for (const [factory, names, providedType] of [
    ['gateway', ['gateway'], 'Gateway'],
    ['namedGateway', ['slowGateway', 'gatewayAlias'], 'Gateway'],
    ['kotlinGateway', ['kotlinGateway'], 'KGateway'],
    ['inferredGateway', ['inferredGateway'], 'KGatewayImpl'],
  ]) {
    const metadata = declarations.find((declaration) => declaration.factory === factory)?.metadata;
    assert.deepEqual(metadata?.names, names, factory);
    assert.equal(metadata?.providedType, providedType, factory);
  }
  const indirectGateway = declarations.find(
    (declaration) => declaration.factory === 'indirectGateway',
  );
  assert.deepEqual(indirectGateway?.metadata.names, ['indirectGateway']);
  assert.equal(Object.hasOwn(indirectGateway?.metadata, 'providedType'), false);
  assert.equal(
    declarations.some((declaration) => declaration.metadata.names.includes('localGateway')),
    false,
  );
  // uses Bean factory names and return types for Java Resource and Qualifier resolution
  {
    const details = injectionDetails(result);
    const pairs = details.map((detail) => detail.pair);
    assert.ok(pairs.includes('ExplicitResourceConsumer->slowGateway'));
    assert.ok(pairs.includes('DefaultResourceConsumer->gateway'));
    assert.ok(pairs.includes('SetterResourceConsumer->setterGateway'));
    assert.ok(pairs.includes('CollectionResourceConsumer->gatewayList'));
    assert.ok(pairs.includes('ConcreteFactoryResourceConsumer->concreteGateway'));
    assert.ok(pairs.includes('TypeOverrideResourceConsumer->repo'));
    assert.ok(pairs.includes('ClassResourceConsumer->ClassGateway'));
    assert.ok(pairs.includes('QualifierConsumer->slowGateway'));
    assert.ok(pairs.includes('service->slowGateway'));
    assert.equal(
      pairs.some((pair) => pair.startsWith('AppConfiguration->')),
      false,
    );
    assert.deepStrictEqual(
      pairs.filter((pair) => pair.startsWith('aggregate->')),
      [
        'aggregate->ClassGateway',
        'aggregate->concreteGateway',
        'aggregate->gateway',
        'aggregate->selfAwareGateway',
        'aggregate->setterGateway',
        'aggregate->slowGateway',
      ],
    );
    assert.equal(
      pairs.some((pair) => pair === 'selfAwareGateway->selfAwareGateway'),
      false,
    );
    assert.equal(
      pairs.some((pair) => pair.startsWith('selfAwareGateway->')),
      true,
    );
    assert.deepStrictEqual(
      pairs.filter((pair) => pair.startsWith('CollectionResourceConsumer->')),
      ['CollectionResourceConsumer->gatewayList'],
    );
  }
  // uses default-name type fallback conservatively and keeps explicit/runtime misses unresolved
  {
    const details = injectionDetails(result);
    const fallback = details.filter((detail) =>
      detail.pair.startsWith('FallbackResourceConsumer->'),
    );
    assert.ok(fallback.length > 1);
    assert.equal(
      fallback.every((detail) => detail.confidence === 0.5),
      true,
    );
    assert.equal(
      fallback.every((detail) => detail.reason.includes('type fallback')),
      true,
    );
    assert.equal(
      details.some((detail) => detail.pair.startsWith('MissingResourceConsumer->')),
      false,
    );
    assert.equal(
      details.some((detail) => detail.pair.startsWith('RuntimeResourceConsumer->')),
      false,
    );
    assert.equal(
      details.some((detail) => detail.pair.startsWith('ConflictingResourceConsumer->')),
      false,
    );
    assert.equal(
      details.some((detail) => detail.pair.startsWith('GenericResourceConsumer->')),
      false,
    );
    assert.equal(
      details.some((detail) => detail.pair.startsWith('LocalResourceConsumer->')),
      false,
    );
  }
  // provides Kotlin parity for explicit/default/setter/collection Resource sites
  {
    const pairs = injectionDetails(result).map((detail) => detail.pair);
    assert.ok(pairs.includes('KotlinExplicitResourceConsumer->kotlinNamed'));
    assert.ok(pairs.includes('KotlinDefaultResourceConsumer->kotlinGateway'));
    assert.ok(pairs.includes('KotlinSetterResourceConsumer->inferredGateway'));
    assert.ok(pairs.includes('KotlinCollectionResourceConsumer->kotlinList'));
    assert.ok(pairs.includes('KotlinConcreteFactoryResourceConsumer->kotlinConcreteGateway'));
    assert.ok(pairs.includes('KotlinClassResourceConsumer->KClassGateway'));
    assert.ok(pairs.includes('kotlinService->kotlinNamed'));
    assert.equal(
      pairs.some((pair) => pair.startsWith('KotlinConfiguration->')),
      false,
    );
    assert.equal(
      pairs.some((pair) => pair.startsWith('KotlinGetterResourceConsumer->')),
      false,
    );
    assert.equal(
      pairs.some((pair) => pair.startsWith('KotlinGenericResourceConsumer->')),
      false,
    );
    assert.equal(
      pairs.some((pair) => pair.startsWith('KotlinConflictingResourceConsumer->')),
      false,
    );
    assert.equal(
      pairs.some((pair) => pair === 'kotlinSelfAwareGateway->kotlinSelfAwareGateway'),
      false,
    );
    assert.equal(
      pairs.some((pair) => pair.startsWith('kotlinSelfAwareGateway->')),
      true,
    );
    assert.deepStrictEqual(
      pairs.filter((pair) => pair.startsWith('KotlinCollectionResourceConsumer->')),
      ['KotlinCollectionResourceConsumer->kotlinList'],
    );
  }
}
export async function verifyBeanBackend() {
  const BEAN_ID = 'Class:src/BillingService.java:BillingService';
  const KOTLIN_BEAN_ID = 'Class:src/KotlinBillingService.kt:KotlinBillingService';
  const PLAIN_ID = 'Class:src/PlainUtility.java:PlainUtility';
  const NON_JAVA_ID = 'Class:src/AppProvider.ts:AppProvider';
  const CONFLICT_ID = 'Class:src/ConflictingBean.java:ConflictingBean';
  const FACTORY_METHOD_ID = 'Method:src/AppConfiguration.java:AppConfiguration.billingService#0';
  const FACTORY_BEAN_ID = `CodeElement:spring-bean:${FACTORY_METHOD_ID}`;
  const FACTORY_REASON =
    'spring-bean-factory:{"names":["billingService","billingAlias"],"namesKnown":true,"providedType":"BillingService"}';
  const SEED = [
    `CREATE (c:Class {id:'${BEAN_ID}', name:'BillingService', filePath:'src/BillingService.java', startLine:0, endLine:3, isExported:false, content:'class BillingService {}', description:'', frameworkAnnotations:['org.springframework.stereotype.Service']})`,
    `CREATE (c:Class {id:'${KOTLIN_BEAN_ID}', name:'KotlinBillingService', filePath:'src/KotlinBillingService.kt', startLine:0, endLine:3, isExported:false, content:'class KotlinBillingService', description:'', frameworkAnnotations:['org.springframework.stereotype.Service']})`,
    `CREATE (c:Class {id:'${PLAIN_ID}', name:'PlainUtility', filePath:'src/PlainUtility.java', startLine:0, endLine:1, isExported:false, content:'class PlainUtility {}', description:'', frameworkAnnotations:[]})`,
    `CREATE (c:Class {id:'${NON_JAVA_ID}', name:'AppProvider', filePath:'src/AppProvider.ts', startLine:0, endLine:1, isExported:true, content:'class AppProvider {}', description:'', frameworkAnnotations:['@nestjs/common.Injectable']})`,
    `CREATE (c:Class {id:'${CONFLICT_ID}', name:'ConflictingBean', filePath:'src/ConflictingBean.java', startLine:0, endLine:1, isExported:false, content:'class ConflictingBean {}', description:'', frameworkAnnotations:['org.springframework.stereotype.Service', 'org.springframework.stereotype.Component']})`,
    `CREATE (m:Method {id:'${FACTORY_METHOD_ID}', name:'billingService', filePath:'src/AppConfiguration.java', startLine:4, endLine:6, isExported:false, content:'@Bean BillingService billingService()', description:'', parameterCount:0, returnType:'BillingService'})`,
    `CREATE (b:CodeElement {id:'${FACTORY_BEAN_ID}', name:'billingService', filePath:'src/AppConfiguration.java', startLine:4, endLine:6, isExported:false, content:'', description:'Spring Bean factory declaration'})`,
    `MATCH (m:Method {id:'${FACTORY_METHOD_ID}'}), (b:CodeElement {id:'${FACTORY_BEAN_ID}'}) CREATE (m)-[:CodeRelation {type:'DECLARES', confidence:1.0, reason:'${FACTORY_REASON}', step:0}]->(b)`,
  ];
  await withIndexedBackend('spring-bean-mcp', SEED, async (handle, backend) => {
    // Bean metadata MCP enrichment

    // returns the same nested Bean shape for Java and Kotlin from context and impact

    const javaContext = await backend.callTool('context', {
      uid: BEAN_ID,
    });
    const kotlinContext = await backend.callTool('context', {
      uid: KOTLIN_BEAN_ID,
    });
    const kotlinImpact = await backend.callTool('impact', {
      target: 'KotlinBillingService',
      direction: 'upstream',
    });
    const javaImpact = await backend.callTool('impact', {
      target: 'BillingService',
      direction: 'upstream',
    });
    const expectedBean = {
      framework: 'spring',
      role: 'service',
      annotation: 'org.springframework.stereotype.Service',
    };
    assert.deepStrictEqual(javaContext.symbol.bean, expectedBean);
    assert.deepStrictEqual(kotlinContext.symbol.bean, expectedBean);
    assert.deepStrictEqual(javaImpact.target.bean, expectedBean);
    assert.deepStrictEqual(kotlinImpact.target.bean, expectedBean);
    // omits Bean metadata for an ordinary Class

    const context = await backend.callTool('context', {
      uid: PLAIN_ID,
    });
    const impact = await backend.callTool('impact', {
      target: 'PlainUtility',
      direction: 'upstream',
    });
    assert.equal(Object.hasOwn(context.symbol, 'bean'), false);
    assert.equal(Object.hasOwn(impact.target, 'bean'), false);
    // omits Spring Bean metadata for non-Spring and conflicting evidence

    const nonJava = await backend.callTool('context', {
      uid: NON_JAVA_ID,
    });
    const conflict = await backend.callTool('impact', {
      target: 'ConflictingBean',
      direction: 'upstream',
    });
    assert.equal(Object.hasOwn(nonJava.symbol, 'bean'), false);
    assert.equal(Object.hasOwn(conflict.target, 'bean'), false);
    // enriches both Bean factory methods and their synthetic declarations

    const methodContext = await backend.callTool('context', {
      uid: FACTORY_METHOD_ID,
    });
    const declarationContext = await backend.callTool('context', {
      uid: FACTORY_BEAN_ID,
    });
    const expectedFactoryBean = {
      framework: 'spring',
      role: 'factory-method',
      annotation: 'org.springframework.context.annotation.Bean',
      names: ['billingService', 'billingAlias'],
      providedType: 'BillingService',
    };
    assert.deepStrictEqual(methodContext.symbol.bean, expectedFactoryBean);
    assert.deepStrictEqual(declarationContext.symbol.bean, expectedFactoryBean);
  });
}

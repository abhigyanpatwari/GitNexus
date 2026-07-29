import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decodeSpringBeanFactoryReason } from '../../src/core/ingestion/frameworks/spring/bean-factories.js';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import type { PipelineResult } from '../../src/types/pipeline.js';

function nodeNames(result: PipelineResult): Map<string, string> {
  const names = new Map<string, string>();
  result.graph.forEachNode((node) => names.set(node.id, String(node.properties.name)));
  return names;
}

function injectionDetails(result: PipelineResult) {
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

function beanDeclarations(result: PipelineResult) {
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

describe('Spring Bean factories and Resource injection pipeline (#2413, #2633)', () => {
  let dir: string;
  let result: PipelineResult;

  const sources: Record<string, string> = {
    'Gateway.java': 'package com.example; public interface Gateway {}\n',
    'DefaultGateway.java':
      'package com.example; public class DefaultGateway implements Gateway {}\n',
    'ConcreteRepo.java': 'package com.example; public class ConcreteRepo {}\n',
    'ClassGateway.java': `package com.example;
import org.springframework.stereotype.Service;
@Service("classGateway")
public class ClassGateway implements Gateway {}
`,
    'AppConfiguration.java': `package com.example;
import java.util.List;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
@Configuration
public class AppConfiguration {
  @Bean Gateway gateway() { return new DefaultGateway(); }
  @Bean(name = {"slowGateway", "gatewayAlias"})
  Gateway namedGateway() { return new DefaultGateway(); }
  @Bean Gateway setterGateway() { return new DefaultGateway(); }
  @Bean List<Gateway> gatewayList() { return List.of(); }
  @Bean ConcreteRepo repo() { return new ConcreteRepo(); }
  @Bean @Autowired
  ConcreteRepo service(@Qualifier("gatewayAlias") Gateway gateway) {
    return new ConcreteRepo();
  }
  @Bean ConcreteRepo aggregate(List<Gateway> gateways) {
    return new ConcreteRepo();
  }
}
`,
    'ExplicitResourceConsumer.java': `package com.example;
import jakarta.annotation.Resource;
public class ExplicitResourceConsumer {
  @Resource(name = "slowGateway") Gateway selected;
}
`,
    'DefaultResourceConsumer.java': `package com.example;
import javax.annotation.Resource;
public class DefaultResourceConsumer {
  @Resource Gateway gateway;
}
`,
    'SetterResourceConsumer.java': `package com.example;
import jakarta.annotation.Resource;
public class SetterResourceConsumer {
  @Resource void setSetterGateway(Gateway value) {}
}
`,
    'CollectionResourceConsumer.java': `package com.example;
import java.util.List;
import javax.annotation.Resource;
public class CollectionResourceConsumer {
  @Resource(name = "gatewayList") List<Gateway> gateways;
}
`,
    'TypeOverrideResourceConsumer.java': `package com.example;
import jakarta.annotation.Resource;
public class TypeOverrideResourceConsumer {
  @Resource(type = ConcreteRepo.class) Object repo;
}
`,
    'FallbackResourceConsumer.java': `package com.example;
import jakarta.annotation.Resource;
public class FallbackResourceConsumer {
  @Resource Gateway unknownGateway;
}
`,
    'MissingResourceConsumer.java': `package com.example;
import jakarta.annotation.Resource;
public class MissingResourceConsumer {
  @Resource(name = "missing") Gateway gateway;
}
`,
    'RuntimeResourceConsumer.java': `package com.example;
import jakarta.annotation.Resource;
public class RuntimeResourceConsumer {
  @Resource(lookup = "java:global/gateway") Gateway gateway;
}
`,
    'QualifierConsumer.java': `package com.example;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
public class QualifierConsumer {
  @Autowired @Qualifier("gatewayAlias") Gateway gateway;
}
`,
    'ConflictingResourceConsumer.java': `package com.example;
import jakarta.annotation.Resource;
import org.springframework.beans.factory.annotation.Autowired;
public class ConflictingResourceConsumer {
  @Autowired @Resource Gateway gateway;
}
`,
    'ClassResourceConsumer.java': `package com.example;
import jakarta.annotation.Resource;
public class ClassResourceConsumer {
  @Resource(name = "classGateway") Gateway gateway;
}
`,
    'LocalSpringNames.java': `package com.local;
@interface Bean {}
@interface Resource {}
interface LocalGateway {}
class LocalConfiguration {
  @Bean LocalGateway localGateway() { return null; }
}
class LocalResourceConsumer {
  @Resource LocalGateway localGateway;
}
`,
    'KGateway.kt': `package com.kotlin
interface KGateway
class KGatewayImpl : KGateway
class KRepo
`,
    'KClassGateway.kt': `package com.kotlin
import org.springframework.stereotype.Service
@Service("kotlinClassGateway")
class KClassGateway : KGateway
`,
    'KotlinConfiguration.kt': `package com.kotlin
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
@Configuration
class KotlinConfiguration {
  @Bean fun kotlinGateway(): KGateway = KGatewayImpl()
  @Bean(name = ["kotlinNamed", "kotlinAlias"])
  fun namedGateway(): KGateway = KGatewayImpl()
  @Bean fun inferredGateway() = KGatewayImpl()
  private fun buildGateway(): KGateway = KGatewayImpl()
  @Bean fun indirectGateway() = buildGateway()
  @Bean fun kotlinList(): List<KGateway> = emptyList()
  @Bean @Autowired
  fun kotlinService(@param:Qualifier("kotlinAlias") gateway: KGateway): KRepo = KRepo()
}
`,
    'KotlinExplicitResourceConsumer.kt': `package com.kotlin
import jakarta.annotation.Resource
class KotlinExplicitResourceConsumer {
  @field:Resource(name = "kotlinNamed")
  lateinit var selected: KGateway
}
`,
    'KotlinDefaultResourceConsumer.kt': `package com.kotlin
import javax.annotation.Resource
class KotlinDefaultResourceConsumer {
  @field:Resource
  lateinit var kotlinGateway: KGateway
}
`,
    'KotlinSetterResourceConsumer.kt': `package com.kotlin
import jakarta.annotation.Resource
class KotlinSetterResourceConsumer {
  @Resource fun setInferredGateway(value: KGatewayImpl) {}
}
`,
    'KotlinCollectionResourceConsumer.kt': `package com.kotlin
import jakarta.annotation.Resource
class KotlinCollectionResourceConsumer {
  @set:Resource
  var kotlinList: List<KGateway>? = null
}
`,
    'KotlinGetterResourceConsumer.kt': `package com.kotlin
import jakarta.annotation.Resource
class KotlinGetterResourceConsumer {
  @get:Resource
  var kotlinGateway: KGateway? = null
}
`,
    'KotlinClassResourceConsumer.kt': `package com.kotlin
import jakarta.annotation.Resource
class KotlinClassResourceConsumer {
  @field:Resource(name = "kotlinClassGateway")
  lateinit var gateway: KGateway
}
`,
    'KotlinLocalSpringNames.kt': `package com.kotlinlocal
annotation class Bean
annotation class Resource
interface LocalGateway
class LocalConfiguration {
  @Bean fun localGateway(): LocalGateway = TODO()
}
class LocalResourceConsumer {
  @field:Resource lateinit var localGateway: LocalGateway
}
`,
  };

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-spring-bean-resource-'));
    for (const [fileName, source] of Object.entries(sources)) {
      fs.writeFileSync(path.join(dir, fileName), source);
    }
    result = await runPipelineFromRepo(dir, () => {}, {});
  }, 90_000);

  afterAll(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('creates Java and Kotlin Bean declarations with names, aliases, and returned types', () => {
    const declarations = beanDeclarations(result);
    expect(
      declarations.find((declaration) => declaration.factory === 'gateway')?.metadata,
    ).toMatchObject({ names: ['gateway'], providedType: 'Gateway' });
    expect(
      declarations.find((declaration) => declaration.factory === 'namedGateway')?.metadata,
    ).toMatchObject({ names: ['slowGateway', 'gatewayAlias'], providedType: 'Gateway' });
    expect(
      declarations.find((declaration) => declaration.factory === 'kotlinGateway')?.metadata,
    ).toMatchObject({ names: ['kotlinGateway'], providedType: 'KGateway' });
    expect(
      declarations.find((declaration) => declaration.factory === 'inferredGateway')?.metadata,
    ).toMatchObject({ names: ['inferredGateway'], providedType: 'KGatewayImpl' });
    const indirectGateway = declarations.find(
      (declaration) => declaration.factory === 'indirectGateway',
    );
    expect(indirectGateway?.metadata).toMatchObject({ names: ['indirectGateway'] });
    expect(indirectGateway?.metadata).not.toHaveProperty('providedType');
    expect(
      declarations.some((declaration) => declaration.metadata.names.includes('localGateway')),
    ).toBe(false);
  });

  it('uses Bean factory names and return types for Java Resource and Qualifier resolution', () => {
    const details = injectionDetails(result);
    const pairs = details.map((detail) => detail.pair);
    expect(pairs).toContain('ExplicitResourceConsumer->slowGateway');
    expect(pairs).toContain('DefaultResourceConsumer->gateway');
    expect(pairs).toContain('SetterResourceConsumer->setterGateway');
    expect(pairs).toContain('CollectionResourceConsumer->gatewayList');
    expect(pairs).toContain('TypeOverrideResourceConsumer->repo');
    expect(pairs).toContain('ClassResourceConsumer->ClassGateway');
    expect(pairs).toContain('QualifierConsumer->slowGateway');
    expect(pairs).toContain('service->slowGateway');
    expect(pairs.some((pair) => pair.startsWith('AppConfiguration->'))).toBe(false);
    expect(pairs.filter((pair) => pair.startsWith('aggregate->'))).toEqual([
      'aggregate->ClassGateway',
      'aggregate->gateway',
      'aggregate->setterGateway',
      'aggregate->slowGateway',
    ]);
    expect(pairs.filter((pair) => pair.startsWith('CollectionResourceConsumer->'))).toEqual([
      'CollectionResourceConsumer->gatewayList',
    ]);
  });

  it('uses default-name type fallback conservatively and keeps explicit/runtime misses unresolved', () => {
    const details = injectionDetails(result);
    const fallback = details.filter((detail) =>
      detail.pair.startsWith('FallbackResourceConsumer->'),
    );
    expect(fallback.length).toBeGreaterThan(1);
    expect(fallback.every((detail) => detail.confidence === 0.5)).toBe(true);
    expect(fallback.every((detail) => detail.reason.includes('type fallback'))).toBe(true);
    expect(details.some((detail) => detail.pair.startsWith('MissingResourceConsumer->'))).toBe(
      false,
    );
    expect(details.some((detail) => detail.pair.startsWith('RuntimeResourceConsumer->'))).toBe(
      false,
    );
    expect(details.some((detail) => detail.pair.startsWith('ConflictingResourceConsumer->'))).toBe(
      false,
    );
    expect(details.some((detail) => detail.pair.startsWith('LocalResourceConsumer->'))).toBe(false);
  });

  it('provides Kotlin parity for explicit/default/setter/collection Resource sites', () => {
    const pairs = injectionDetails(result).map((detail) => detail.pair);
    expect(pairs).toContain('KotlinExplicitResourceConsumer->kotlinNamed');
    expect(pairs).toContain('KotlinDefaultResourceConsumer->kotlinGateway');
    expect(pairs).toContain('KotlinSetterResourceConsumer->inferredGateway');
    expect(pairs).toContain('KotlinCollectionResourceConsumer->kotlinList');
    expect(pairs).toContain('KotlinClassResourceConsumer->KClassGateway');
    expect(pairs).toContain('kotlinService->kotlinNamed');
    expect(pairs.some((pair) => pair.startsWith('KotlinConfiguration->'))).toBe(false);
    expect(pairs.some((pair) => pair.startsWith('KotlinGetterResourceConsumer->'))).toBe(false);
    expect(pairs.filter((pair) => pair.startsWith('KotlinCollectionResourceConsumer->'))).toEqual([
      'KotlinCollectionResourceConsumer->kotlinList',
    ]);
  });
});

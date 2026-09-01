import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { GraphNode } from 'gitnexus-shared';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';

const SECRET_ENV_VALUE = 'KOTLIN_ACTUATOR_ENV_CANARY_2418';

function writeFixture(root: string, relativePath: string, content: string): void {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function writeJson(root: string, relativePath: string, value: unknown): void {
  writeFixture(root, relativePath, JSON.stringify(value));
}

function handler(
  className: string,
  name: string,
  descriptor: string,
  method: string,
  route: string,
) {
  return {
    predicate: `{${method} [${route}]}`,
    details: {
      handlerMethod: { className, name, descriptor },
      requestMappingConditions: { methods: [method], patterns: [route] },
    },
  };
}

function kotlinRuntimeFixture(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-spring-actuator-kotlin-'));
  writeFixture(
    repo,
    'src/main/kotlin/com/example/KotlinControllers.kt',
    `package com.example

import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.RestController

@RestController
class KotlinController {
  @GetMapping("/regular")
  fun regular(): String = helper()
  fun helper(): String = leaf()
  fun leaf(): String = "ok"

  @GetMapping("/suspend")
  suspend fun suspended(limit: Int): String = "ok"

  fun withDefault(limit: Int = 10): String = "ok"
  fun overloaded(): String = "zero"
  fun overloaded(limit: Int): String = "one"

  @get:GetMapping("/status")
  val status: String get() = "ok"

  @get:GetMapping("/ready")
  val isReady: Boolean get() = true

  companion object {
    fun companionHandler(): String = "ok"
  }
}

class NamedHolder {
  companion object Factory {
    fun namedHandler(): String = "ok"
  }
}

@RestController
object SingletonController {
  @GetMapping("/singleton")
  fun singletonHandler(): String = "ok"
}
`,
  );
  writeFixture(
    repo,
    'src/main/kotlin/com/example/TopLevelHandlers.kt',
    `@file:JvmName("CustomHandlers")
package com.example

fun topLevelHandler(): String = "ok"
`,
  );
  writeFixture(
    repo,
    'src/main/kotlin/com/example/StandardHandlers.kt',
    `package com.example

fun standardTopLevelHandler(): String = "ok"
`,
  );
  writeFixture(
    repo,
    'src/main/kotlin/com/example/KotlinConfig.kt',
    `package com.example

import org.springframework.boot.context.properties.ConfigurationProperties
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.stereotype.Service

@Service
class KotlinService

@Configuration
class KotlinConfig {
  @Bean
  fun billingService(): KotlinService = KotlinService()
}

@ConfigurationProperties(prefix = "app.kotlin")
class KotlinProperties {
  var url: String = ""
}
`,
  );
  writeFixture(
    repo,
    'src/main/resources/application.properties',
    'app.kotlin.url=https://static\n',
  );

  writeJson(repo, 'actuator/mappings.json', {
    contexts: {
      application: {
        mappings: {
          dispatcherServlets: {
            dispatcherServlet: [
              handler(
                'com.example.KotlinController',
                'regular',
                '()Ljava/lang/String;',
                'GET',
                '/runtime-regular',
              ),
              handler(
                'com.example.KotlinController',
                'suspended',
                '(ILkotlin/coroutines/Continuation;)Ljava/lang/Object;',
                'GET',
                '/runtime-suspend',
              ),
              handler(
                'com.example.KotlinController$Companion',
                'companionHandler',
                '()Ljava/lang/String;',
                'GET',
                '/runtime-companion',
              ),
              handler(
                'com.example.NamedHolder$Factory',
                'namedHandler',
                '()Ljava/lang/String;',
                'GET',
                '/runtime-named-companion',
              ),
              handler(
                'com.example.SingletonController',
                'singletonHandler',
                '()Ljava/lang/String;',
                'GET',
                '/runtime-singleton',
              ),
              handler(
                'com.example.CustomHandlers',
                'topLevelHandler',
                '()Ljava/lang/String;',
                'GET',
                '/runtime-file-facade',
              ),
              handler(
                'com.example.StandardHandlersKt',
                'standardTopLevelHandler',
                '()Ljava/lang/String;',
                'GET',
                '/runtime-standard-facade',
              ),
              handler(
                'com.example.KotlinController',
                'getStatus',
                '()Ljava/lang/String;',
                'GET',
                '/runtime-property',
              ),
              handler(
                'com.example.KotlinController',
                'isReady',
                '()Z',
                'GET',
                '/runtime-boolean-property',
              ),
              handler(
                'com.example.KotlinController',
                'withDefault$default',
                '(Lcom/example/KotlinController;IILjava/lang/Object;)Ljava/lang/String;',
                'GET',
                '/runtime-default',
              ),
              handler(
                'com.example.KotlinController',
                'overloaded$default',
                '(Lcom/example/KotlinController;IILjava/lang/Object;)Ljava/lang/String;',
                'GET',
                '/runtime-ambiguous-default',
              ),
            ],
          },
        },
      },
    },
  });
  writeJson(repo, 'actuator/beans.json', {
    contexts: {
      application: {
        beans: {
          kotlinService: {
            type: 'com.example.KotlinService',
            scope: 'singleton',
            dependencies: [],
          },
          billingService: {
            type: 'com.example.KotlinService',
            scope: 'singleton',
            dependencies: [],
          },
        },
      },
    },
  });
  writeJson(repo, 'actuator/conditions.json', {
    contexts: {
      application: {
        positiveMatches: {
          'com.example.KotlinConfig#billingService': [{ message: SECRET_ENV_VALUE }],
          'com.example.KotlinController$Companion#companionHandler': [
            { message: SECRET_ENV_VALUE },
          ],
          'com.example.NamedHolder$Factory#namedHandler': [{ message: SECRET_ENV_VALUE }],
        },
        negativeMatches: {},
      },
    },
  });
  writeJson(repo, 'actuator/configprops.json', {
    contexts: {
      application: {
        beans: {
          kotlin: {
            prefix: 'app.kotlin',
            inputs: { url: { value: SECRET_ENV_VALUE, origin: SECRET_ENV_VALUE } },
          },
        },
      },
    },
  });
  writeJson(repo, 'actuator/env.json', {
    propertySources: [
      {
        name: SECRET_ENV_VALUE,
        properties: {
          'app.kotlin.url': { value: SECRET_ENV_VALUE, origin: SECRET_ENV_VALUE },
          'app.kotlin.password': { value: SECRET_ENV_VALUE, origin: SECRET_ENV_VALUE },
        },
      },
    ],
  });
  return repo;
}

describe('Spring Boot Actuator Kotlin runtime enrichment', () => {
  const tempRepos: string[] = [];

  afterEach(() => {
    for (const repo of tempRepos.splice(0)) fs.rmSync(repo, { recursive: true, force: true });
  });

  it('binds Kotlin JVM owner and callable shapes without leaking runtime values', async () => {
    const repo = kotlinRuntimeFixture();
    tempRepos.push(repo);
    const result = await runPipelineFromRepo(repo, () => {}, {
      springActuatorPath: 'actuator',
    });
    const nodes = [...result.graph.iterNodes()];
    const kotlinControllerFile = nodes.find(
      (node) =>
        node.label === 'File' &&
        node.properties.filePath === 'src/main/kotlin/com/example/KotlinControllers.kt',
    );
    const route = (name: string): GraphNode | undefined =>
      nodes.find((node) => node.label === 'Route' && node.properties.name === name);

    for (const name of [
      '/runtime-regular',
      '/runtime-suspend',
      '/runtime-companion',
      '/runtime-named-companion',
      '/runtime-singleton',
      '/runtime-file-facade',
      '/runtime-standard-facade',
      '/runtime-property',
      '/runtime-boolean-property',
      '/runtime-default',
    ]) {
      expect(route(name)?.properties.handlerSymbolId, name).toEqual(expect.any(String));
      expect(route(name)?.properties.runtimeConfirmed, name).toBe(true);
    }
    expect(route('/runtime-ambiguous-default')?.properties).not.toHaveProperty('handlerSymbolId');

    const propertyHandler = result.graph.getNode(
      String(route('/runtime-property')?.properties.handlerSymbolId),
    );
    expect(propertyHandler?.label).toBe('Property');
    expect(propertyHandler?.properties.name).toBe('status');
    const booleanHandler = result.graph.getNode(
      String(route('/runtime-boolean-property')?.properties.handlerSymbolId),
    );
    expect(booleanHandler?.label).toBe('Property');
    expect(booleanHandler?.properties.name).toBe('isReady');
    expect(
      [...result.graph.iterRelationshipsByType('ENTRY_POINT_OF')].some(
        (edge) =>
          edge.sourceId === route('/runtime-property')?.id ||
          edge.sourceId === route('/runtime-boolean-property')?.id,
      ),
    ).toBe(false);

    const regularRoute = route('/runtime-regular');
    expect(
      [...result.graph.iterRelationshipsByType('HANDLES_ROUTE')].some(
        (edge) => edge.sourceId === kotlinControllerFile?.id && edge.targetId === regularRoute?.id,
      ),
    ).toBe(true);
    expect(
      [...result.graph.iterRelationshipsByType('ENTRY_POINT_OF')].some(
        (edge) =>
          edge.sourceId === regularRoute?.id &&
          result.graph.getNode(edge.targetId)?.properties.entryPointId ===
            regularRoute?.properties.handlerSymbolId,
      ),
    ).toBe(true);

    const described = (name: string): GraphNode | undefined =>
      nodes.find(
        (node) =>
          node.properties.name === name &&
          String(node.properties.description ?? '').includes('Spring Actuator'),
      );
    expect(described('KotlinService')?.properties.description).toContain(
      'Spring Actuator beans runtime-confirmed',
    );
    expect(
      nodes.some(
        (node) =>
          node.properties.name === 'billingService' &&
          String(node.properties.description ?? '').includes(
            'Spring Actuator beans runtime-confirmed',
          ),
      ),
    ).toBe(true);
    expect(described('billingService')?.properties.description).toContain(
      'Spring Actuator conditions matched',
    );
    expect(described('companionHandler')?.properties.description).toContain(
      'Spring Actuator conditions matched',
    );
    expect(described('namedHandler')?.properties.description).toContain(
      'Spring Actuator conditions matched',
    );
    expect(described('app.kotlin.url')?.properties.description).toContain(
      'Spring Actuator configprops runtime-confirmed',
    );
    expect(described('app.kotlin.password')?.properties.description).toContain(
      'Spring Actuator env runtime-confirmed',
    );

    expect(JSON.stringify([...result.graph.iterNodes()])).not.toContain(SECRET_ENV_VALUE);
    expect(nodes.some((node) => String(node.properties.filePath).includes('/actuator/'))).toBe(
      false,
    );
  }, 60_000);
});

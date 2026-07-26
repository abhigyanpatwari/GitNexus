import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GraphNode, GraphRelationship } from 'gitnexus-shared';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import type { PipelineResult } from '../../src/types/pipeline.js';

function writeFixture(root: string, relativePath: string, content: string): void {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

describe('Spring profiles, conditionals, and auto-configuration pipeline (#2415)', () => {
  let dir: string;
  let result: PipelineResult;
  let nodes: GraphNode[];
  let conditions: GraphRelationship[];
  let declarations: GraphRelationship[];

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-spring-conditionals-'));
    writeFixture(
      dir,
      'src/main/resources/application.properties',
      'feature.payments.enabled=true\nfeature.search.enabled=true\n',
    );
    writeFixture(
      dir,
      'src/main/java/com/example/SpringConditions.java',
      `package com.example;

import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnClass;
import org.springframework.boot.autoconfigure.condition.ConditionalOnBooleanProperty;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Profile;

@Profile({"prod\u202e", "staging\u200b"})
class ProfiledJavaConfig {}

@Configuration
class JavaBeanConfig {
  @Bean
  @ConditionalOnProperty(prefix = "feature.payments", name = {"enabled"}, havingValue = "true")
  Object paymentService() { return new Object(); }

  @Bean
  @ConditionalOnBooleanProperty(prefix = "feature.search", name = "enabled")
  Object booleanSearchService() { return new Object(); }

  @Bean
  @ConditionalOnProperty(prefix = """
      feature.payments
      """, name = """
      enabled
      """)
  Object textBlockPaymentService() { return new Object(); }
}

@AutoConfiguration
@ConditionalOnClass(name = "com.acme.Driver")
class JavaAutoConfig {}

@Configuration
class OrdinaryApplicationConfig {}
`,
    );
    writeFixture(
      dir,
      'src/main/kotlin/com/example/KotlinConditions.kt',
      `package com.example

import org.springframework.boot.autoconfigure.AutoConfiguration
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.context.annotation.Profile

@Profile("dev")
class ProfiledKotlinConfig

@Configuration
class KotlinBeanConfig {
  @Bean
  @ConditionalOnProperty(prefix = """feature.search""", name = ["""enabled"""])
  fun searchService(): Any = Any()
}

@AutoConfiguration
@ConditionalOnMissingBean(name = ["client"])
class KotlinAutoConfig
`,
    );
    writeFixture(
      dir,
      'src/main/java/com/local/StarterAutoConfiguration.java',
      `package com.local;
class StarterAutoConfiguration {}
`,
    );
    for (const moduleName of ['module-a', 'module-b']) {
      writeFixture(
        dir,
        `${moduleName}/src/main/java/com/duplicate/DuplicateAutoConfiguration.java`,
        `package com.duplicate;
class DuplicateAutoConfiguration {}
`,
      );
    }
    writeFixture(
      dir,
      'src/main/resources/META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports',
      `com.example.JavaAutoConfig
com.vendor.StarterAutoConfiguration
com.vendor.SharedAutoConfiguration
com.duplicate.DuplicateAutoConfiguration
`,
    );
    writeFixture(
      dir,
      'src/main/resources/META-INF/spring.factories',
      `org.springframework.boot.autoconfigure.EnableAutoConfiguration=\\
com.example.KotlinAutoConfig,\\
com.vendor.LegacyStarterAutoConfiguration,\\
com.vendor.SharedAutoConfiguration,\\
com.duplicate.DuplicateAutoConfiguration
`,
    );

    result = await runPipelineFromRepo(dir, () => {}, { skipGraphPhases: true });
    nodes = [...result.graph.iterNodes()];
    conditions = [...result.graph.iterRelationshipsByType('CONDITIONAL_ON')];
    declarations = [...result.graph.iterRelationshipsByType('DECLARES')];
  }, 60_000);

  afterAll(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  const nodeNamed = (name: string): GraphNode | undefined =>
    nodes.find((node) => node.properties.name === name);
  const nodesQualified = (qualifiedName: string): GraphNode[] =>
    nodes.filter((node) => node.properties.qualifiedName === qualifiedName);

  const outgoingConditions = (
    name: string,
  ): Array<{
    target: string;
    reason: string;
  }> => {
    const source = nodeNamed(name);
    if (source === undefined) return [];
    return conditions
      .filter((edge) => edge.sourceId === source.id)
      .map((edge) => ({
        target: String(result.graph.getNode(edge.targetId)?.properties.name),
        reason: edge.reason,
      }));
  };

  it('captures Java and Kotlin profile gates as explicit unknown-activation evidence', () => {
    expect(outgoingConditions('ProfiledJavaConfig')).toEqual([
      expect.objectContaining({
        target: '@Profile',
        reason: expect.stringContaining('activation=unknown'),
      }),
    ]);
    expect(outgoingConditions('ProfiledKotlinConfig')).toEqual([
      expect.objectContaining({
        target: '@Profile',
        reason: expect.stringContaining('activation=unknown'),
      }),
    ]);

    for (const [className, annotationLine] of [
      ['ProfiledJavaConfig', 11],
      ['ProfiledKotlinConfig', 10],
    ] as const) {
      const owner = nodeNamed(className);
      const edge = conditions.find((candidate) => candidate.sourceId === owner?.id);
      const condition = edge === undefined ? undefined : result.graph.getNode(edge.targetId);
      expect(condition?.properties.startLine).toBe(annotationLine);
    }
  });

  it('strips Trojan-Source controls from condition descriptions before MCP exposure', () => {
    const conditionDescriptions = nodes
      .filter((node) => node.label === 'Annotation')
      .map((node) => String(node.properties.description));
    expect(conditionDescriptions.length).toBeGreaterThan(0);
    expect(
      conditionDescriptions.every(
        (description) => !/[\u200b-\u200d\u202a-\u202e\u2066-\u2069\ufeff]/u.test(description),
      ),
    ).toBe(true);
    expect(
      conditions.every(
        (edge) => !/[\u200b-\u200d\u202a-\u202e\u2066-\u2069\ufeff]/u.test(edge.reason),
      ),
    ).toBe(true);
  });

  it('connects Java/Kotlin property conditions, including raw/text-block strings, to config keys', () => {
    expect(outgoingConditions('paymentService')).toEqual([
      expect.objectContaining({
        target: 'feature.payments.enabled',
        reason: expect.stringContaining('@ConditionalOnProperty'),
      }),
    ]);
    expect(outgoingConditions('searchService')).toEqual([
      expect.objectContaining({
        target: 'feature.search.enabled',
        reason: expect.stringContaining('@ConditionalOnProperty'),
      }),
    ]);
    expect(outgoingConditions('booleanSearchService')).toEqual([
      expect.objectContaining({
        target: 'feature.search.enabled',
        reason: expect.stringContaining('@ConditionalOnBooleanProperty'),
      }),
    ]);
    expect(outgoingConditions('textBlockPaymentService')).toEqual([
      expect.objectContaining({
        target: 'feature.payments.enabled',
        reason: expect.stringContaining('@ConditionalOnProperty'),
      }),
    ]);
  });

  it('preserves non-property conditional variants for both languages', () => {
    expect(outgoingConditions('JavaAutoConfig')).toEqual([
      expect.objectContaining({ target: '@ConditionalOnClass' }),
    ]);
    expect(outgoingConditions('KotlinAutoConfig')).toEqual([
      expect.objectContaining({ target: '@ConditionalOnMissingBean' }),
    ]);
  });

  it('uses metadata DECLARES evidence without claiming annotation-based registration', () => {
    const targetNames = declarations
      .map((edge) => String(result.graph.getNode(edge.targetId)?.properties.name))
      .sort();
    expect(targetNames).toEqual([
      'JavaAutoConfig',
      'KotlinAutoConfig',
      'LegacyStarterAutoConfiguration',
      'SharedAutoConfiguration',
      'SharedAutoConfiguration',
      'StarterAutoConfiguration',
    ]);
    expect(
      declarations.some(
        (edge) =>
          result.graph.getNode(edge.targetId)?.properties.name === 'OrdinaryApplicationConfig',
      ),
    ).toBe(false);
    expect(
      declarations.every((edge) =>
        String(result.graph.getNode(edge.sourceId)?.properties.filePath).includes('META-INF'),
      ),
    ).toBe(true);
    expect(
      nodesQualified('com.vendor.StarterAutoConfiguration')[0]?.properties.description,
    ).toContain('implementation source unavailable');
  });

  it('never falls back from metadata FQN to an unrelated simple-name match', () => {
    const declaration = declarations.find(
      (edge) =>
        result.graph.getNode(edge.targetId)?.properties.qualifiedName ===
        'com.vendor.StarterAutoConfiguration',
    );
    expect(declaration).toBeDefined();
    expect(result.graph.getNode(declaration!.targetId)?.properties.filePath).toContain('META-INF');
    expect(
      declarations.some(
        (edge) =>
          result.graph.getNode(edge.targetId)?.properties.qualifiedName ===
          'com.local.StarterAutoConfiguration',
      ),
    ).toBe(false);
  });

  it('deduplicates missing source classes by normalized FQN across metadata files', () => {
    const shared = nodesQualified('com.vendor.SharedAutoConfiguration');
    expect(shared).toHaveLength(1);
    expect(declarations.filter((edge) => edge.targetId === shared[0]?.id)).toHaveLength(2);
    expect(
      declarations
        .filter((edge) => edge.targetId === shared[0]?.id)
        .map((edge) => edge.reason)
        .sort(),
    ).toEqual(['spring-auto-configuration-factory', 'spring-auto-configuration-import']);
  });

  it('fails closed when duplicate real classes share one FQN', () => {
    const duplicates = nodesQualified('com.duplicate.DuplicateAutoConfiguration');
    expect(duplicates).toHaveLength(2);
    expect(
      declarations.some((edge) => duplicates.some((duplicate) => duplicate.id === edge.targetId)),
    ).toBe(false);
    expect(
      duplicates.some((node) =>
        String(node.properties.description).includes('implementation source unavailable'),
      ),
    ).toBe(false);
  });

  it('recognizes AutoConfiguration as a Spring Bean candidate in Java and Kotlin', () => {
    expect(nodeNamed('JavaAutoConfig')?.properties.frameworkAnnotations).toEqual([
      'org.springframework.boot.autoconfigure.AutoConfiguration',
    ]);
    expect(nodeNamed('KotlinAutoConfig')?.properties.frameworkAnnotations).toEqual([
      'org.springframework.boot.autoconfigure.AutoConfiguration',
    ]);
  });
});

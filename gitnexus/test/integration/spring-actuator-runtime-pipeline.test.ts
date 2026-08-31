import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { GraphNode } from 'gitnexus-shared';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';

const SECRET_ENV_VALUE = 'ACTUATOR_ENV_SECRET_2418';
const SECRET_CONFIG_VALUE = 'ACTUATOR_CONFIG_SECRET_2418';
const SECRET_CONDITION_MESSAGE = 'runtime condition details must stay private';

function writeFixture(root: string, relativePath: string, content: string): void {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function writeJson(root: string, relativePath: string, value: unknown): void {
  writeFixture(root, relativePath, JSON.stringify(value));
}

function runtimeFixture(): { repo: string; actuatorDir: string } {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-spring-actuator-'));
  writeFixture(
    repo,
    'src/main/java/com/example/RuntimeApplication.java',
    `package com.example;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.stereotype.Service;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
class OrderController {
  @GetMapping("/orders")
  String list() { return "ok"; }
}

class SiblingController {
  String list() { return "not-the-handler"; }
}

@Service
class BillingService {}

@Configuration
class RuntimeConfig {
  @Bean
  @ConditionalOnProperty(prefix = "app.billing", name = "enabled")
  BillingService billingService() { return new BillingService(); }
}

class SiblingConfig {
  BillingService billingService() { return new BillingService(); }
}

@ConfigurationProperties(prefix = "app.billing")
class BillingProperties {
  String url;
}
`,
  );
  writeFixture(
    repo,
    'src/main/resources/application.properties',
    'app.billing.enabled=true\napp.billing.url=https://static.example\n',
  );

  const actuatorDir = path.join(repo, 'runtime-actuator');
  writeJson(repo, 'runtime-actuator/mappings.json', {
    contexts: {
      application: {
        mappings: {
          dispatcherServlets: {
            dispatcherServlet: [
              {
                predicate: '{GET [/orders]}',
                details: {
                  handlerMethod: {
                    className: 'com.example.OrderController',
                    name: 'list',
                    descriptor: '()Ljava/lang/String;',
                  },
                  requestMappingConditions: { methods: ['GET'], patterns: ['/orders'] },
                },
              },
              {
                predicate: '{GET [/runtime-bound]}',
                details: {
                  handlerMethod: {
                    className: 'com.example.OrderController',
                    name: 'list',
                    descriptor: '()Ljava/lang/String;',
                  },
                  requestMappingConditions: {
                    methods: ['GET'],
                    patterns: ['/runtime-bound'],
                  },
                },
              },
              {
                predicate: '{POST [/runtime-only]}',
                details: {
                  handlerMethod: {
                    className: 'com.vendor.RuntimeController',
                    name: 'create',
                    descriptor: '()V',
                  },
                  requestMappingConditions: {
                    methods: ['POST'],
                    patterns: ['/runtime-only'],
                  },
                },
              },
            ],
          },
        },
      },
    },
  });
  writeJson(repo, 'runtime-actuator/beans.json', {
    contexts: {
      application: {
        beans: {
          billingService: {
            type: 'com.example.BillingService',
            scope: 'singleton',
            dependencies: [],
          },
          runtimeOnlyBean: {
            type: 'com.vendor.RuntimeOnlyBean',
            scope: 'singleton',
            dependencies: [],
          },
        },
      },
    },
  });
  writeJson(repo, 'runtime-actuator/conditions.json', {
    contexts: {
      application: {
        positiveMatches: {
          'com.example.RuntimeConfig#billingService': [
            { condition: 'OnPropertyCondition', message: SECRET_CONDITION_MESSAGE },
          ],
        },
        negativeMatches: {},
      },
    },
  });
  writeJson(repo, 'runtime-actuator/configprops.json', {
    contexts: {
      application: {
        beans: {
          billing: {
            prefix: 'app.billing',
            properties: { url: SECRET_CONFIG_VALUE },
            inputs: {
              url: { value: SECRET_CONFIG_VALUE, origin: 'systemEnvironment' },
              enabled: { value: true },
            },
          },
        },
      },
    },
  });
  writeJson(repo, 'runtime-actuator/env.json', {
    activeProfiles: [],
    propertySources: [
      {
        name: 'systemEnvironment',
        properties: {
          'app.billing.url': { value: SECRET_ENV_VALUE, origin: 'env' },
          'db.password': { value: SECRET_ENV_VALUE, origin: 'env' },
        },
      },
    ],
  });
  return { repo, actuatorDir };
}

describe('Spring Boot Actuator runtime enrichment (#2418)', () => {
  const tempRepos: string[] = [];

  afterEach(() => {
    for (const repo of tempRepos.splice(0)) {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('is disabled by default and does not add runtime evidence', async () => {
    const { repo } = runtimeFixture();
    tempRepos.push(repo);

    const result = await runPipelineFromRepo(repo, () => {}, { skipGraphPhases: true });

    expect(
      [...result.graph.iterNodes()].some(
        (node) => node.properties.runtimeSource === 'spring-actuator',
      ),
    ).toBe(false);
    expect(
      [...result.graph.iterRelationships()].some((edge) =>
        edge.reason.startsWith('spring-actuator:'),
      ),
    ).toBe(false);
  }, 60_000);

  it('confirms static routes/beans/properties, adds runtime-only evidence, and drops values', async () => {
    const { repo, actuatorDir } = runtimeFixture();
    tempRepos.push(repo);

    const result = await runPipelineFromRepo(repo, () => {}, {
      skipGraphPhases: true,
      springActuatorPath: actuatorDir,
    });
    const nodes = [...result.graph.iterNodes()];
    const nodeNamed = (name: string, label?: GraphNode['label']): GraphNode | undefined =>
      nodes.find(
        (node) => node.properties.name === name && (label === undefined || node.label === label),
      );

    expect(nodeNamed('/orders', 'Route')?.properties).toMatchObject({
      method: 'GET',
      runtimeConfirmed: true,
      runtimeSource: 'spring-actuator',
    });
    expect(nodeNamed('/runtime-only', 'Route')?.properties).toMatchObject({
      method: 'POST',
      runtimeConfirmed: true,
    });
    const owner = nodeNamed('OrderController', 'Class');
    const ownerMethodId = [...result.graph.iterRelationshipsByType('HAS_METHOD')].find(
      (edge) =>
        edge.sourceId === owner?.id &&
        result.graph.getNode(edge.targetId)?.properties.name === 'list',
    )?.targetId;
    expect(nodeNamed('/runtime-bound', 'Route')?.properties.handlerSymbolId).toBe(ownerMethodId);
    expect(nodeNamed('BillingService', 'Class')?.properties.runtimeConfirmed).toBe(true);
    expect(nodeNamed('runtimeOnlyBean', 'CodeElement')?.properties.runtimeConfirmed).toBe(true);
    const configOwner = nodeNamed('RuntimeConfig', 'Class');
    const configMethodId = [...result.graph.iterRelationshipsByType('HAS_METHOD')].find(
      (edge) =>
        edge.sourceId === configOwner?.id &&
        result.graph.getNode(edge.targetId)?.properties.name === 'billingService',
    )?.targetId;
    expect(result.graph.getNode(configMethodId ?? '')?.properties.runtimeStatus).toContain(
      'matched',
    );
    const siblingOwner = nodeNamed('SiblingConfig', 'Class');
    const siblingMethodId = [...result.graph.iterRelationshipsByType('HAS_METHOD')].find(
      (edge) =>
        edge.sourceId === siblingOwner?.id &&
        result.graph.getNode(edge.targetId)?.properties.name === 'billingService',
    )?.targetId;
    expect(result.graph.getNode(siblingMethodId ?? '')?.properties.runtimeStatus).toBeUndefined();
    expect(nodeNamed('app.billing.url', 'Property')?.properties.runtimeConfirmed).toBe(true);
    expect(nodeNamed('db.password', 'Property')?.properties.runtimeConfirmed).toBe(true);

    const graphText = JSON.stringify({
      nodes,
      relationships: [...result.graph.iterRelationships()],
    });
    expect(graphText).not.toContain(SECRET_ENV_VALUE);
    expect(graphText).not.toContain(SECRET_CONFIG_VALUE);
    expect(graphText).not.toContain(SECRET_CONDITION_MESSAGE);
    expect(graphText).not.toContain('systemEnvironment');

    // The configured snapshot directory is excluded before source ingestion,
    // so env/configprops values cannot leak into File-node content or FTS.
    expect(
      nodes.some((node) => String(node.properties.filePath).includes('runtime-actuator/')),
    ).toBe(false);
    expect(
      [...result.graph.iterRelationshipsByType('DECLARES')].some((edge) =>
        edge.reason.startsWith('spring-actuator:mappings:'),
      ),
    ).toBe(true);
  }, 60_000);

  it('reports invalid JSON without echoing payload source text', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-spring-actuator-invalid-'));
    tempRepos.push(repo);
    writeFixture(repo, 'index.ts', 'export const value = 1;\n');
    writeFixture(repo, 'actuator/env.json', `{"value":"${SECRET_ENV_VALUE}`);

    await expect(
      runPipelineFromRepo(repo, () => {}, {
        skipGraphPhases: true,
        springActuatorPath: 'actuator',
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes('not valid JSON') &&
        !error.message.includes(SECRET_ENV_VALUE),
    );
  }, 60_000);

  it('accepts a bundle file and excludes that file from source ingestion', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-spring-actuator-bundle-'));
    tempRepos.push(repo);
    writeFixture(repo, 'index.ts', 'export const value = 1;\n');
    writeJson(repo, 'runtime-snapshot.json', {
      env: {
        propertySources: [
          {
            name: 'bundle-source',
            properties: { 'bundle.secret-key': { value: SECRET_ENV_VALUE } },
          },
        ],
      },
    });

    const result = await runPipelineFromRepo(repo, () => {}, {
      skipGraphPhases: true,
      springActuatorPath: 'runtime-snapshot.json',
    });
    const nodes = [...result.graph.iterNodes()];

    expect(
      nodes.find(
        (node) => node.label === 'Property' && node.properties.name === 'bundle.secret-key',
      )?.properties.runtimeConfirmed,
    ).toBe(true);
    expect(nodes.some((node) => node.properties.filePath === 'runtime-snapshot.json')).toBe(false);
    expect(JSON.stringify(nodes)).not.toContain(SECRET_ENV_VALUE);
    expect(JSON.stringify(nodes)).not.toContain('bundle-source');
  }, 60_000);

  it('keeps repository sources when the Actuator directory is the repository root', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-spring-actuator-root-'));
    tempRepos.push(repo);
    writeFixture(repo, 'index.ts', 'export const retained = true;\n');
    writeJson(repo, 'mappings.json', { contexts: {} });

    const result = await runPipelineFromRepo(repo, () => {}, {
      skipGraphPhases: true,
      springActuatorPath: repo,
    });
    const files = [...result.graph.iterNodes()].filter((node) => node.label === 'File');

    expect(files.some((node) => node.properties.filePath === 'index.ts')).toBe(true);
    expect(files.some((node) => node.properties.filePath === 'mappings.json')).toBe(false);
  }, 60_000);

  it('keeps repository sources when the Actuator directory is an ancestor', async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-spring-actuator-parent-'));
    tempRepos.push(parent);
    const repo = path.join(parent, 'repo');
    fs.mkdirSync(repo);
    writeFixture(repo, 'index.ts', 'export const retained = true;\n');
    writeJson(parent, 'mappings.json', { contexts: {} });

    const result = await runPipelineFromRepo(repo, () => {}, {
      skipGraphPhases: true,
      springActuatorPath: parent,
    });

    expect(
      [...result.graph.iterNodes()].some(
        (node) => node.label === 'File' && node.properties.filePath === 'index.ts',
      ),
    ).toBe(true);
  }, 60_000);
});

import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { GraphNode, GraphRelationship } from 'gitnexus-shared';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import { SPRING_CONFIG_DESCRIPTION } from '../../src/core/ingestion/frameworks/spring/config-bindings.js';
import type { PipelineResult } from '../../types/pipeline.js';
import { createTempDir } from '../helpers/test-db.js';

const FIXTURE = path.resolve(__dirname, '..', 'fixtures', 'spring-config-app');
const SHADOW_FIXTURE = path.resolve(__dirname, '..', 'fixtures', 'spring-config-shadow-app');

describe('Spring configuration binding pipeline', () => {
  let result: PipelineResult;
  let nodes: GraphNode[];
  let uses: GraphRelationship[];

  beforeAll(async () => {
    result = await runPipelineFromRepo(FIXTURE, () => {}, { skipGraphPhases: true });
    nodes = [...result.graph.iterNodes()];
    uses = [...result.graph.iterRelationshipsByType('USES')].filter((edge) =>
      edge.reason.startsWith('spring-config:'),
    );
  }, 60_000);

  const nodeNamed = (name: string, fileSuffix?: string): GraphNode | undefined =>
    nodes.find(
      (node) =>
        node.properties.name === name &&
        (fileSuffix === undefined || String(node.properties.filePath).endsWith(fileSuffix)),
    );

  const targetsFrom = (source: GraphNode): string[] =>
    uses
      .filter((edge) => edge.sourceId === source.id)
      .map((edge) => String(result.graph.getNode(edge.targetId)?.properties.name))
      .sort();

  const targetFilesFrom = (source: GraphNode, targetName: string): string[] =>
    uses
      .filter((edge) => edge.sourceId === source.id)
      .map((edge) => result.graph.getNode(edge.targetId))
      .filter((node) => node?.properties.name === targetName)
      .map((node) => String(node?.properties.filePath))
      .sort();

  it('creates key-only Property nodes for properties and profile YAML files', () => {
    const propertiesKey = nodeNamed('payment.timeout', 'application.properties');
    expect(propertiesKey).toBeDefined();
    expect(propertiesKey?.properties).not.toHaveProperty('language');
    expect(nodeNamed('service.endpoint', 'application-dev.yml')?.properties.description).toContain(
      'profile: dev',
    );
    expect(
      nodeNamed('service.retry.max-attempts', 'application-dev.yml')?.properties.startLine,
    ).toBe(3);
    expect(
      nodes.some((node) => JSON.stringify(node.properties).includes('service.example.test')),
    ).toBe(false);
  });

  it('links Value fields to exact keys and leaves missing placeholders unresolved', () => {
    const timeout = nodeNamed('timeout', 'ConfigConsumers.java');
    const missing = nodeNamed('missing', 'ConfigConsumers.java');
    expect(timeout).toBeDefined();
    expect(missing).toBeDefined();
    if (timeout === undefined || missing === undefined) throw new Error('fixture fields missing');
    expect(targetsFrom(timeout)).toEqual(['payment.timeout']);
    expect(targetsFrom(missing)).toEqual([]);
    expect(missing?.properties.description).toContain('Spring config unresolved: payment.missing');
  });

  it('links ConfigurationProperties classes and relaxed field names to their prefix', () => {
    const owner = nodeNamed('ServiceProperties', 'ConfigConsumers.java');
    const endpoint = nodeNamed('endpoint', 'ConfigConsumers.java');
    const retry = nodeNamed('retry', 'ConfigConsumers.java');
    expect(owner).toBeDefined();
    if (owner === undefined || endpoint === undefined || retry === undefined) {
      throw new Error('fixture ConfigurationProperties symbols missing');
    }
    expect(targetsFrom(owner)).toEqual([
      'service.endpoint',
      'service.endpoint',
      'service.retry.max-attempts',
    ]);
    expect(targetsFrom(endpoint)).toEqual(['service.endpoint', 'service.endpoint']);
    expect(targetFilesFrom(endpoint, 'service.endpoint')).toEqual([
      'src/main/resources/application-dev.yml',
      'src/main/resources/application.properties',
    ]);
    expect(targetsFrom(retry)).toEqual(['service.retry.max-attempts']);
  });

  it('keeps the class-level binding when no field relaxed-name matches', () => {
    const owner = nodeNamed('UnmatchedServiceProperties', 'ConfigConsumers.java');
    const unrelated = nodeNamed('unrelated', 'ConfigConsumers.java');
    if (owner === undefined || unrelated === undefined) {
      throw new Error('unmatched ConfigurationProperties symbols missing');
    }
    expect(targetsFrom(owner)).toEqual([
      'service.endpoint',
      'service.endpoint',
      'service.retry.max-attempts',
    ]);
    expect(targetsFrom(unrelated)).toEqual([]);
  });
});

describe('Spring configuration annotation attribution', () => {
  it('fails closed when a same-package annotation shadows a Spring wildcard import', async () => {
    const result = await runPipelineFromRepo(SHADOW_FIXTURE, () => {}, {
      skipGraphPhases: true,
    });
    const fake = [...result.graph.iterNodes()].find(
      (node) =>
        node.properties.name === 'fake' &&
        String(node.properties.filePath).endsWith('Shadowed.java'),
    );
    expect(fake).toBeDefined();
    if (fake === undefined) throw new Error('shadow fixture field missing');
    expect(
      [...result.graph.iterRelationshipsByType('USES')].filter(
        (edge) => edge.sourceId === fake.id && edge.reason.startsWith('spring-config:'),
      ),
    ).toEqual([]);
    expect(String(fake.properties.description ?? '')).not.toContain('Spring config unresolved:');
  });
});

describe('Spring configuration file safety bounds', () => {
  it('fails closed for malformed and oversized configuration files', async () => {
    const repo = await createTempDir();
    try {
      const resources = path.join(repo.dbPath, 'src', 'main', 'resources');
      await mkdir(resources, { recursive: true });
      await writeFile(path.join(resources, 'application-broken.yml'), 'broken: [\n', 'utf8');
      await writeFile(
        path.join(resources, 'application-oversized.properties'),
        `oversized.key=${'x'.repeat(2 * 1024 * 1024)}\n`,
        'utf8',
      );

      // Let the scanner admit the file so this exercises springConfig's
      // stricter 2 MiB cap rather than the scanner's default 512 KiB cap.
      vi.stubEnv('GITNEXUS_MAX_FILE_SIZE', '4096');
      const result = await runPipelineFromRepo(repo.dbPath, () => {}, { skipGraphPhases: true });
      const configNodes = [...result.graph.iterNodes()].filter((node) =>
        String(node.properties.description ?? '').startsWith(SPRING_CONFIG_DESCRIPTION),
      );
      expect(configNodes).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
      await repo.cleanup();
    }
  });
});

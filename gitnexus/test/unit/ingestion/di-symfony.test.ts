/**
 * Unit tests for Symfony / PHP DI (#1857):
 * - constructor autowiring → INJECTS edges
 * - services.yaml alias preference when multiple implementers exist
 * - YAML alias parser helpers
 */
import { describe, expect, it } from 'vitest';
import { createKnowledgeGraph } from '../../../src/core/graph/graph.js';
import { diPhase } from '../../../src/core/ingestion/pipeline-phases/di.js';
import {
  SYMFONY_DI_PROVIDER_PROPERTY,
  normalizeSymfonyInjectionType,
  matchSymfonyConstructorInjections,
} from '../../../src/core/ingestion/di-extractors/symfony.js';
import {
  extractSymfonyServiceAliases,
  parseSymfonyServicesYaml,
} from '../../../src/core/ingestion/pipeline-phases/symfony-config.js';
import { generateId } from '../../../src/lib/utils.js';
import type { PipelineContext } from '../../../src/core/ingestion/pipeline-phases/types.js';
import type { KnowledgeGraph } from '../../../src/core/graph/types.js';
import type { GraphNode, NodeLabel } from 'gitnexus-shared';

function makeCtx(graph: KnowledgeGraph, repoPath = '/tmp/symfony-repo'): PipelineContext {
  return { repoPath, graph, onProgress: () => {}, pipelineStart: 0 };
}

function addNode(
  graph: KnowledgeGraph,
  label: NodeLabel,
  name: string,
  extra: Record<string, unknown> = {},
): string {
  const id = generateId(label, `php:${name}`);
  graph.addNode({
    id,
    label,
    properties: {
      name,
      filePath: `src/${name}.php`,
      language: 'php',
      ...extra,
    },
  });
  return id;
}

function addImplements(graph: KnowledgeGraph, classId: string, ifaceId: string): void {
  graph.addRelationship({
    id: generateId('IMPLEMENTS', `${classId}->${ifaceId}`),
    sourceId: classId,
    targetId: ifaceId,
    type: 'IMPLEMENTS',
    confidence: 1,
    reason: 'test',
  });
}

function addHasMethod(graph: KnowledgeGraph, classId: string, methodId: string): void {
  graph.addRelationship({
    id: generateId('HAS_METHOD', `${classId}->${methodId}`),
    sourceId: classId,
    targetId: methodId,
    type: 'HAS_METHOD',
    confidence: 1,
    reason: 'test',
  });
}

describe('normalizeSymfonyInjectionType', () => {
  it('accepts class / interface names and FQCNs', () => {
    expect(normalizeSymfonyInjectionType('Logger')).toBe('Logger');
    expect(normalizeSymfonyInjectionType('\\App\\Log\\Logger')).toBe('App\\Log\\Logger');
    expect(normalizeSymfonyInjectionType('?FileLogger')).toBe('FileLogger');
  });

  it('rejects scalars and unions', () => {
    expect(normalizeSymfonyInjectionType('string')).toBeNull();
    expect(normalizeSymfonyInjectionType('array')).toBeNull();
    expect(normalizeSymfonyInjectionType('Logger|null')).toBeNull();
  });
});

describe('matchSymfonyConstructorInjections', () => {
  it('emits sites for typed __construct parameters', () => {
    const node = {
      id: 'Method:__construct',
      label: 'Method',
      properties: {
        name: '__construct',
        language: 'php',
        filePath: 'src/OrderService.php',
        parameterTypes: ['Logger', 'string'],
      },
    } as GraphNode;
    const matches = matchSymfonyConstructorInjections(node);
    expect(matches).toHaveLength(1);
    expect(matches[0].targetTypeName).toBe('Logger');
    expect(matches[0].cardinality).toBe('single');
  });
});

describe('extractSymfonyServiceAliases / parseSymfonyServicesYaml', () => {
  it('parses string and mapping alias forms', () => {
    const yaml = `
services:
  _defaults:
    autowire: true
  App\\Log\\Logger: '@App\\Log\\FileLogger'
  App\\Other\\Clock:
    alias: App\\Other\\SystemClock
`;
    const aliases = parseSymfonyServicesYaml(yaml, 'config/services.yaml');
    expect(aliases).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          interfaceName: 'App\\Log\\Logger',
          implementationName: 'App\\Log\\FileLogger',
        }),
        expect.objectContaining({
          interfaceName: 'App\\Other\\Clock',
          implementationName: 'App\\Other\\SystemClock',
        }),
      ]),
    );
  });

  it('extracts from a services object directly', () => {
    const aliases = extractSymfonyServiceAliases(
      {
        'App\\Log\\Logger': '@App\\Log\\FileLogger',
      },
      'config/services.yaml',
    );
    expect(aliases).toHaveLength(1);
    expect(aliases[0].implementationName).toBe('App\\Log\\FileLogger');
  });
});

describe('di phase — Symfony constructor autowiring (#1857)', () => {
  it('emits INJECTS from OrderService to FileLogger when Logger has one implementer', async () => {
    const graph = createKnowledgeGraph();
    const orderId = addNode(graph, 'Class', 'OrderService');
    const loggerId = addNode(graph, 'Interface', 'Logger', {
      qualifiedName: 'App\\Log\\Logger',
    });
    const fileLoggerId = addNode(graph, 'Class', 'FileLogger', {
      qualifiedName: 'App\\Log\\FileLogger',
    });
    addImplements(graph, fileLoggerId, loggerId);

    const ctorId = addNode(graph, 'Method', '__construct', {
      parameterTypes: ['Logger'],
      parameterCount: 1,
      filePath: 'src/OrderService.php',
    });
    // Method id collision: regenerate with unique key
    // (addNode used name __construct — fine for this graph)
    addHasMethod(graph, orderId, ctorId);

    const output = await diPhase.execute(makeCtx(graph), new Map());
    expect(output.injectsEdges).toBeGreaterThanOrEqual(1);

    const injects = [...graph.iterRelationshipsByType('INJECTS')];
    expect(injects.some((e) => e.sourceId === orderId && e.targetId === fileLoggerId)).toBe(true);
  });

  it('prefers the services.yaml-aliased implementer when multiple exist', async () => {
    const graph = createKnowledgeGraph();
    const orderId = addNode(graph, 'Class', 'OrderService');
    const loggerId = addNode(graph, 'Interface', 'Logger', {
      qualifiedName: 'App\\Log\\Logger',
    });
    const fileLoggerId = addNode(graph, 'Class', 'FileLogger', {
      qualifiedName: 'App\\Log\\FileLogger',
    });
    const syslogId = addNode(graph, 'Class', 'SyslogLogger', {
      qualifiedName: 'App\\Log\\SyslogLogger',
    });
    addImplements(graph, fileLoggerId, loggerId);
    addImplements(graph, syslogId, loggerId);

    const fileLogger = graph.getNode(fileLoggerId)!;
    fileLogger.properties[SYMFONY_DI_PROVIDER_PROPERTY] = {
      names: ['FileLogger', 'App\\Log\\FileLogger'],
      providedTypeName: 'App\\Log\\FileLogger',
      declaredByNodeId: fileLoggerId,
      preferenceReason: 'Symfony services.yaml alias App\\Log\\Logger → App\\Log\\FileLogger',
    };

    const ctorId = addNode(graph, 'Method', 'OrderService.__construct', {
      name: '__construct',
      parameterTypes: ['Logger'],
      parameterCount: 1,
      filePath: 'src/OrderService.php',
    });
    // Fix name after unique id key
    graph.getNode(ctorId)!.properties.name = '__construct';
    addHasMethod(graph, orderId, ctorId);

    await diPhase.execute(makeCtx(graph), new Map());

    const injects = [...graph.iterRelationshipsByType('INJECTS')].filter(
      (e) => e.sourceId === orderId,
    );
    const preferred = injects.filter((e) => e.targetId === fileLoggerId);
    expect(preferred.length).toBe(1);
    expect(preferred[0].confidence).toBeGreaterThanOrEqual(0.9);
    expect(preferred[0].reason).toMatch(/services\.yaml alias/i);
  });
});

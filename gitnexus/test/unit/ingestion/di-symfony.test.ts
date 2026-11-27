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
  SYMFONY_DI_CONSTRUCTOR_ENABLED_PROPERTY,
  SYMFONY_DI_PROVIDER_PROPERTY,
  normalizeSymfonyInjectionType,
  matchSymfonyConstructorInjections,
  defaultSymfonyProvider,
} from '../../../src/core/ingestion/di-extractors/symfony.js';
import {
  classMatchesName,
  extractSymfonyServiceAliases,
  extractSymfonyServiceIdClasses,
  isServicesYaml,
  parseSymfonyServicesYaml,
  resolveSymfonyImplementationName,
  symfonyConfigPhase,
} from '../../../src/core/ingestion/pipeline-phases/symfony-config.js';
import { generateId } from '../../../src/lib/utils.js';
import type { PipelineContext } from '../../../src/core/ingestion/pipeline-phases/types.js';
import type { PhaseResult } from '../../../src/core/ingestion/pipeline-phases/types.js';
import type { KnowledgeGraph } from '../../../src/core/graph/types.js';
import type { GraphNode, NodeLabel } from 'gitnexus-shared';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

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

function stampSymfonyProvider(
  graph: KnowledgeGraph,
  classId: string,
  preferenceByType?: Readonly<Record<string, string>>,
): void {
  const node = graph.getNode(classId)!;
  const base = defaultSymfonyProvider(node);
  if (base === null) return;
  node.properties[SYMFONY_DI_PROVIDER_PROPERTY] =
    preferenceByType === undefined ? base : { ...base, preferenceByType };
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

describe('isServicesYaml', () => {
  it('accepts main, env-suffixed, and services/ import paths', () => {
    expect(isServicesYaml('config/services.yaml')).toBe(true);
    expect(isServicesYaml('config/services.yml')).toBe(true);
    expect(isServicesYaml('config/services_dev.yaml')).toBe(true);
    expect(isServicesYaml('config/services_test.yaml')).toBe(true);
    expect(isServicesYaml('apps/api/config/services_prod.yaml')).toBe(true);
    expect(isServicesYaml('config/services/messenger.yaml')).toBe(true);
  });

  it('rejects unrelated yaml paths', () => {
    expect(isServicesYaml('config/packages/framework.yaml')).toBe(false);
    expect(isServicesYaml('config/routes.yaml')).toBe(false);
    expect(isServicesYaml('src/services.yaml')).toBe(false);
  });
});

describe('classMatchesName', () => {
  it('matches FQCN aliases only against the same qualifiedName', () => {
    expect(classMatchesName('FileLogger', 'App\\Log\\FileLogger', 'App\\Log\\FileLogger')).toBe(
      true,
    );
    expect(classMatchesName('FileLogger', 'Other\\FileLogger', 'App\\Log\\FileLogger')).toBe(false);
  });

  it('allows unqualified wanted to match a qualified node short name', () => {
    expect(classMatchesName('FileLogger', 'App\\Log\\FileLogger', 'FileLogger')).toBe(true);
  });

  it('can match more than one class for an unqualified short name', () => {
    expect(classMatchesName('FileLogger', 'App\\Log\\FileLogger', 'FileLogger')).toBe(true);
    expect(classMatchesName('FileLogger', 'Other\\FileLogger', 'FileLogger')).toBe(true);
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

  it('keeps aliases when the file uses Symfony YAML tags', () => {
    const yaml = `
services:
  App\\Log\\Logger: '@App\\Log\\FileLogger'
  app.handlers:
    class: App\\Handler\\Composite
    arguments:
      \$handlers: !tagged_iterator app.handler
`;
    const aliases = parseSymfonyServicesYaml(yaml, 'config/services.yaml');
    expect(aliases).toEqual([
      expect.objectContaining({
        interfaceName: 'App\\Log\\Logger',
        implementationName: 'App\\Log\\FileLogger',
      }),
    ]);
  });

  it('resolves custom service IDs to their declared class', () => {
    const services = {
      'app.file_logger': { class: 'App\\Log\\FileLogger' },
      'App\\Log\\Logger': '@app.file_logger',
    };
    const idToClass = extractSymfonyServiceIdClasses(services);
    expect(idToClass.get('app.file_logger')).toBe('App\\Log\\FileLogger');
    expect(resolveSymfonyImplementationName('app.file_logger', idToClass)).toBe(
      'App\\Log\\FileLogger',
    );
    const aliases = extractSymfonyServiceAliases(services, 'config/services.yaml');
    expect(aliases[0].implementationName).toBe('app.file_logger');
    expect(resolveSymfonyImplementationName(aliases[0].implementationName, idToClass)).toBe(
      'App\\Log\\FileLogger',
    );
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
    stampSymfonyProvider(graph, fileLoggerId);

    const ctorId = addNode(graph, 'Method', 'OrderService.__construct', {
      name: '__construct',
      parameterTypes: ['Logger'],
      parameterCount: 1,
      filePath: 'src/OrderService.php',
      [SYMFONY_DI_CONSTRUCTOR_ENABLED_PROPERTY]: true,
    });
    addHasMethod(graph, orderId, ctorId);

    const output = await diPhase.execute(makeCtx(graph), new Map());
    expect(output.injectsEdges).toBeGreaterThanOrEqual(1);

    const injects = [...graph.iterRelationshipsByType('INJECTS')];
    expect(injects.some((e) => e.sourceId === orderId && e.targetId === fileLoggerId)).toBe(true);
  });

  it('emits no INJECTS for plain PHP without Symfony metadata', async () => {
    const graph = createKnowledgeGraph();
    const orderId = addNode(graph, 'Class', 'OrderService');
    const loggerId = addNode(graph, 'Interface', 'Logger', {
      qualifiedName: 'App\\Log\\Logger',
    });
    const fileLoggerId = addNode(graph, 'Class', 'FileLogger', {
      qualifiedName: 'App\\Log\\FileLogger',
    });
    addImplements(graph, fileLoggerId, loggerId);

    const ctorId = addNode(graph, 'Method', 'OrderService.__construct', {
      name: '__construct',
      parameterTypes: ['Logger'],
      parameterCount: 1,
      filePath: 'src/OrderService.php',
    });
    addHasMethod(graph, orderId, ctorId);

    const output = await diPhase.execute(makeCtx(graph), new Map());
    expect(output.injectsEdges).toBe(0);
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
    stampSymfonyProvider(graph, syslogId);
    stampSymfonyProvider(graph, fileLoggerId, {
      'App\\Log\\Logger':
        'Symfony services.yaml alias App\\Log\\Logger → App\\Log\\FileLogger',
    });

    const ctorId = addNode(graph, 'Method', 'OrderService.__construct', {
      name: '__construct',
      parameterTypes: ['Logger'],
      parameterCount: 1,
      filePath: 'src/OrderService.php',
      [SYMFONY_DI_CONSTRUCTOR_ENABLED_PROPERTY]: true,
    });
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

  it('does not apply Other\\Logger preference to a resolved App\\Log\\Logger injection', async () => {
    const graph = createKnowledgeGraph();
    const orderId = addNode(graph, 'Class', 'OrderService');
    const appLoggerId = addNode(graph, 'Interface', 'Logger', {
      qualifiedName: 'App\\Log\\Logger',
    });
    const fileLoggerId = addNode(graph, 'Class', 'FileLogger', {
      qualifiedName: 'App\\Log\\FileLogger',
    });
    const otherImplId = addNode(graph, 'Class', 'OtherFileLogger', {
      qualifiedName: 'Other\\FileLogger',
    });
    addImplements(graph, fileLoggerId, appLoggerId);
    addImplements(graph, otherImplId, appLoggerId);
    stampSymfonyProvider(graph, fileLoggerId);
    stampSymfonyProvider(graph, otherImplId, {
      'Other\\Logger': 'Symfony services.yaml alias Other\\Logger → Other\\FileLogger',
    });

    const ctorId = addNode(graph, 'Method', 'OrderService.__construct', {
      name: '__construct',
      parameterTypes: ['Logger'],
      parameterCount: 1,
      filePath: 'src/OrderService.php',
      [SYMFONY_DI_CONSTRUCTOR_ENABLED_PROPERTY]: true,
    });
    addHasMethod(graph, orderId, ctorId);

    await diPhase.execute(makeCtx(graph), new Map());
    const injects = [...graph.iterRelationshipsByType('INJECTS')].filter(
      (e) => e.sourceId === orderId,
    );
    expect(injects.some((e) => e.targetId === otherImplId && e.confidence >= 0.9)).toBe(false);
  });

  it('does not let App\\Log\\Logger preference win Other\\Logger injections', async () => {
    const graph = createKnowledgeGraph();
    const orderId = addNode(graph, 'Class', 'OrderService');
    const otherLoggerId = addNode(graph, 'Interface', 'OtherLogger', {
      name: 'Logger',
      qualifiedName: 'Other\\Logger',
      filePath: 'src/Other/Logger.php',
    });
    const appLoggerId = addNode(graph, 'Interface', 'AppLogger', {
      name: 'Logger',
      qualifiedName: 'App\\Log\\Logger',
      filePath: 'src/App/Log/Logger.php',
    });
    const fileLoggerId = addNode(graph, 'Class', 'FileLogger', {
      qualifiedName: 'App\\Log\\FileLogger',
    });
    const otherImplId = addNode(graph, 'Class', 'OtherFileLogger', {
      qualifiedName: 'Other\\FileLogger',
    });
    addImplements(graph, fileLoggerId, appLoggerId);
    addImplements(graph, fileLoggerId, otherLoggerId);
    addImplements(graph, otherImplId, otherLoggerId);
    stampSymfonyProvider(graph, otherImplId);
    stampSymfonyProvider(graph, fileLoggerId, {
      'App\\Log\\Logger':
        'Symfony services.yaml alias App\\Log\\Logger → App\\Log\\FileLogger',
    });

    const ctorId = addNode(graph, 'Method', 'OrderService.__construct', {
      name: '__construct',
      parameterTypes: ['Other\\Logger'],
      parameterCount: 1,
      filePath: 'src/OrderService.php',
      [SYMFONY_DI_CONSTRUCTOR_ENABLED_PROPERTY]: true,
    });
    addHasMethod(graph, orderId, ctorId);

    await diPhase.execute(makeCtx(graph), new Map());
    const injects = [...graph.iterRelationshipsByType('INJECTS')].filter(
      (e) => e.sourceId === orderId,
    );
    expect(injects.some((e) => e.targetId === fileLoggerId && e.confidence >= 0.9)).toBe(false);
    expect(injects.filter((e) => e.confidence >= 0.9)).toHaveLength(0);
  });

  it('resolves FQCN constructor type hints via qualifiedName index', async () => {
    const graph = createKnowledgeGraph();
    const orderId = addNode(graph, 'Class', 'OrderService');
    const loggerId = addNode(graph, 'Interface', 'Logger', {
      qualifiedName: 'App\\Log\\Logger',
    });
    const fileLoggerId = addNode(graph, 'Class', 'FileLogger', {
      qualifiedName: 'App\\Log\\FileLogger',
    });
    addImplements(graph, fileLoggerId, loggerId);
    stampSymfonyProvider(graph, fileLoggerId);

    const ctorId = addNode(graph, 'Method', 'OrderService.__construct', {
      name: '__construct',
      parameterTypes: ['\\App\\Log\\Logger'],
      parameterCount: 1,
      filePath: 'src/OrderService.php',
      [SYMFONY_DI_CONSTRUCTOR_ENABLED_PROPERTY]: true,
    });
    addHasMethod(graph, orderId, ctorId);

    await diPhase.execute(makeCtx(graph), new Map());
    const injects = [...graph.iterRelationshipsByType('INJECTS')];
    expect(injects.some((e) => e.sourceId === orderId && e.targetId === fileLoggerId)).toBe(true);
  });

  it('resolves PHP type hints case-insensitively', async () => {
    const graph = createKnowledgeGraph();
    const orderId = addNode(graph, 'Class', 'OrderService');
    const loggerId = addNode(graph, 'Interface', 'Logger', {
      qualifiedName: 'App\\Log\\Logger',
    });
    const fileLoggerId = addNode(graph, 'Class', 'FileLogger', {
      qualifiedName: 'App\\Log\\FileLogger',
    });
    addImplements(graph, fileLoggerId, loggerId);
    stampSymfonyProvider(graph, fileLoggerId);

    const ctorId = addNode(graph, 'Method', 'OrderService.__construct', {
      name: '__construct',
      parameterTypes: ['\\app\\log\\logger'],
      parameterCount: 1,
      filePath: 'src/OrderService.php',
      [SYMFONY_DI_CONSTRUCTOR_ENABLED_PROPERTY]: true,
    });
    addHasMethod(graph, orderId, ctorId);

    await diPhase.execute(makeCtx(graph), new Map());
    const injects = [...graph.iterRelationshipsByType('INJECTS')];
    expect(injects.some((e) => e.sourceId === orderId && e.targetId === fileLoggerId)).toBe(true);
  });

  it('enables PHP DI when composer requires symfony without services.yaml', async () => {
    const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), 'symfony-composer-'));
    await fs.writeFile(
      path.join(repoPath, 'composer.json'),
      JSON.stringify({
        require: { 'symfony/framework-bundle': '^7.0' },
      }),
      'utf8',
    );

    const graph = createKnowledgeGraph();
    const orderId = addNode(graph, 'Class', 'OrderService');
    const ctorId = addNode(graph, 'Method', 'OrderService.__construct', {
      name: '__construct',
      parameterTypes: ['Logger'],
      parameterCount: 1,
      filePath: 'src/OrderService.php',
    });
    addHasMethod(graph, orderId, ctorId);

    const deps = new Map<string, PhaseResult<unknown>>([
      [
        'parse',
        {
          phaseName: 'parse',
          output: { allPaths: ['composer.json', 'src/OrderService.php'] },
          durationMs: 0,
        },
      ],
    ]);

    const output = await symfonyConfigPhase.execute(makeCtx(graph, repoPath), deps);
    expect(output.aliasesFound).toBe(0);
    expect(graph.getNode(ctorId)!.properties[SYMFONY_DI_CONSTRUCTOR_ENABLED_PROPERTY]).toBe(true);
    expect(graph.getNode(orderId)!.properties[SYMFONY_DI_PROVIDER_PROPERTY]).toBeTruthy();

    await fs.rm(repoPath, { recursive: true, force: true });
  });

  it('skips unqualified aliases that match multiple same-named classes', async () => {
    const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), 'symfony-di-'));
    await fs.mkdir(path.join(repoPath, 'config'), { recursive: true });
    await fs.writeFile(
      path.join(repoPath, 'config', 'services.yaml'),
      `
services:
  App\\Log\\Logger: '@FileLogger'
`,
      'utf8',
    );

    const graph = createKnowledgeGraph();
    const aId = addNode(graph, 'Class', 'FileLogger', {
      qualifiedName: 'App\\Log\\FileLogger',
    });
    const bId = addNode(graph, 'Class', 'FileLoggerB', {
      name: 'FileLogger',
      qualifiedName: 'Other\\FileLogger',
      filePath: 'src/Other/FileLogger.php',
    });

    const deps = new Map<string, PhaseResult<unknown>>([
      [
        'parse',
        {
          phaseName: 'parse',
          output: { allPaths: ['config/services.yaml'] },
          durationMs: 0,
        },
      ],
    ]);

    const output = await symfonyConfigPhase.execute(makeCtx(graph, repoPath), deps);
    expect(output.aliasesFound).toBe(1);
    expect(output.aliasesApplied).toBe(0);
    expect(graph.getNode(aId)!.properties[SYMFONY_DI_PROVIDER_PROPERTY]).toEqual(
      expect.not.objectContaining({ preferenceByType: expect.anything() }),
    );
    expect(graph.getNode(bId)!.properties[SYMFONY_DI_PROVIDER_PROPERTY]).toEqual(
      expect.not.objectContaining({ preferenceByType: expect.anything() }),
    );

    await fs.rm(repoPath, { recursive: true, force: true });
  });

  it('does not apply a Logger alias preference to an unrelated Clock injection', async () => {
    const graph = createKnowledgeGraph();
    const orderId = addNode(graph, 'Class', 'OrderService');
    const loggerId = addNode(graph, 'Interface', 'Logger', {
      qualifiedName: 'App\\Log\\Logger',
    });
    const clockId = addNode(graph, 'Interface', 'Clock', {
      qualifiedName: 'App\\Time\\Clock',
    });
    const fileLoggerId = addNode(graph, 'Class', 'FileLogger', {
      qualifiedName: 'App\\Log\\FileLogger',
    });
    const systemClockId = addNode(graph, 'Class', 'SystemClock', {
      qualifiedName: 'App\\Time\\SystemClock',
    });
    const otherClockId = addNode(graph, 'Class', 'FrozenClock', {
      qualifiedName: 'App\\Time\\FrozenClock',
    });
    addImplements(graph, fileLoggerId, loggerId);
    addImplements(graph, fileLoggerId, clockId);
    addImplements(graph, systemClockId, clockId);
    addImplements(graph, otherClockId, clockId);
    stampSymfonyProvider(graph, systemClockId);
    stampSymfonyProvider(graph, otherClockId);
    stampSymfonyProvider(graph, fileLoggerId, {
      'App\\Log\\Logger':
        'Symfony services.yaml alias App\\Log\\Logger → App\\Log\\FileLogger',
    });

    const ctorId = addNode(graph, 'Method', 'OrderService.__construct', {
      name: '__construct',
      parameterTypes: ['Clock'],
      parameterCount: 1,
      filePath: 'src/OrderService.php',
      [SYMFONY_DI_CONSTRUCTOR_ENABLED_PROPERTY]: true,
    });
    addHasMethod(graph, orderId, ctorId);

    await diPhase.execute(makeCtx(graph), new Map());
    const injects = [...graph.iterRelationshipsByType('INJECTS')].filter(
      (e) => e.sourceId === orderId,
    );
    const preferred = injects.filter(
      (e) => e.targetId === fileLoggerId && e.confidence >= 0.9,
    );
    expect(preferred).toHaveLength(0);
  });
});

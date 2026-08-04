import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SupportedLanguages } from 'gitnexus-shared';

import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { runChunkedParseAndResolve } from '../../src/core/ingestion/pipeline-phases/parse-impl.js';
import { _captureLogger } from '../../src/core/logger.js';
import { PARSE_CACHE_VERSION, type ParseCache } from '../../src/storage/parse-cache.js';

function sourceGraphSnapshot(graph: ReturnType<typeof createKnowledgeGraph>, filePath: string) {
  const nodes = graph.nodes
    .filter((node) => node.properties.filePath === filePath)
    .map((node) => ({ id: node.id, label: node.label, properties: node.properties }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const nodeIds = new Set(nodes.map((node) => node.id));
  const relationships = graph.relationships
    .filter(
      (relationship) => nodeIds.has(relationship.sourceId) || nodeIds.has(relationship.targetId),
    )
    .map((relationship) => ({
      id: relationship.id,
      sourceId: relationship.sourceId,
      targetId: relationship.targetId,
      type: relationship.type,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  return { nodes, relationships };
}

describe('Objective-C real worker pipeline', () => {
  let repoDir = '';

  afterEach(() => {
    if (repoDir) fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it('keeps the authoritative language through classification, zero-copy IPC, and graph emission', async () => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'objc-worker-'));
    const filePath = 'Sources/Service.m';
    const content = [
      '@interface Service : NSObject',
      '- (void)run;',
      '@end',
      '@implementation Service',
      '- (void)run {}',
      '@end',
      '',
    ].join('\n');
    const absolute = path.join(repoDir, filePath);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content);

    const graph = createKnowledgeGraph();
    const result = await runChunkedParseAndResolve(
      graph,
      [{ path: filePath, size: Buffer.byteLength(content) }],
      [filePath],
      1,
      repoDir,
      Date.now(),
      () => {},
      { workerPoolSize: 1 },
    );

    expect(result.usedWorkerPool).toBe(true);
    expect(result.sourceClassifications.get(filePath)).toMatchObject({
      language: SupportedLanguages.ObjectiveC,
      reason: 'objective-c-syntax',
    });
    const sourceNodes = graph.nodes.filter((node) => node.properties.filePath === filePath);
    expect(
      sourceNodes.some((node) => node.label === 'Class' && node.properties.name === 'Service'),
    ).toBe(true);
    expect(
      sourceNodes.every((node) => node.properties.language === SupportedLanguages.ObjectiveC),
    ).toBe(true);
  });

  it('warns when --pdg indexes Objective-C without a CFG visitor', async () => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'objc-pdg-warning-'));
    const filePath = 'Sources/Service.m';
    const content = '@implementation Service\n- (void)run {}\n@end\n';
    const absolute = path.join(repoDir, filePath);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content);
    const logCapture = _captureLogger();

    try {
      await runChunkedParseAndResolve(
        createKnowledgeGraph(),
        [{ path: filePath, size: Buffer.byteLength(content) }],
        [filePath],
        1,
        repoDir,
        Date.now(),
        () => {},
        { workerPoolSize: 1, pdg: true },
      );

      expect(
        logCapture
          .records()
          .some(
            (record) =>
              record.msg.includes('PDG unavailable for objective-c') &&
              record.msg.includes('1 file(s)'),
          ),
      ).toBe(true);
    } finally {
      logCapture.restore();
    }
  });

  it('routes an Objective-C header identically on cold and warm cache runs', async () => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'objc-header-worker-'));
    const filePath = 'Sources/Service.h';
    const content = '@interface Service : NSObject\n- (void)run;\n@end\n';
    const absolute = path.join(repoDir, filePath);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content);
    const scanned = [{ path: filePath, size: Buffer.byteLength(content) }];
    const parseCache: ParseCache = {
      version: PARSE_CACHE_VERSION,
      entries: new Map(),
      usedKeys: new Set(),
    };

    const coldGraph = createKnowledgeGraph();
    const cold = await runChunkedParseAndResolve(
      coldGraph,
      scanned,
      [filePath],
      1,
      repoDir,
      Date.now(),
      () => {},
      { workerPoolSize: 1, parseCache },
    );
    const warmGraph = createKnowledgeGraph();
    const warm = await runChunkedParseAndResolve(
      warmGraph,
      scanned,
      [filePath],
      1,
      repoDir,
      Date.now(),
      () => {},
      { workerPoolSize: 1, parseCache },
    );

    expect(cold.usedWorkerPool).toBe(true);
    expect(warm.usedWorkerPool).toBe(false);
    expect(cold.sourceClassifications.get(filePath)?.language).toBe(SupportedLanguages.ObjectiveC);
    expect(warm.sourceClassifications).toEqual(cold.sourceClassifications);
    expect(
      warmGraph.nodes
        .filter((node) => node.properties.filePath === filePath)
        .map((node) => [node.label, node.properties.name, node.properties.language]),
    ).toEqual(
      coldGraph.nodes
        .filter((node) => node.properties.filePath === filePath)
        .map((node) => [node.label, node.properties.name, node.properties.language]),
    );
  });

  it('emits full signed selectors and properties for scope resolution', async () => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'objc-semantics-worker-'));
    const filePath = 'Sources/Store.m';
    const content = [
      '@interface Store : NSObject',
      '@property (nonatomic, readonly) NSString *name;',
      '- (void)save:(id)value completion:(id)completion;',
      '- (void)run;',
      '@end',
      '@implementation Store',
      '- (void)save:(id)value completion:(id)completion {}',
      '- (void)run { [self save:nil completion:nil]; }',
      '@end',
      '',
    ].join('\n');
    const absolute = path.join(repoDir, filePath);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content);

    const graph = createKnowledgeGraph();
    await runChunkedParseAndResolve(
      graph,
      [{ path: filePath, size: Buffer.byteLength(content) }],
      [filePath],
      1,
      repoDir,
      Date.now(),
      () => {},
      { workerPoolSize: 1 },
    );

    const methods = graph.nodes.filter(
      (node) => node.label === 'Method' && node.properties.filePath === filePath,
    );
    expect(methods.map((node) => node.properties.name)).toEqual(
      expect.arrayContaining(['-save:completion:', '-run']),
    );
    expect(
      graph.nodes.some((node) => node.label === 'Property' && node.properties.name === 'name'),
    ).toBe(true);
  });

  it('emits advanced Objective-C source sites, ivars, and block functions', async () => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'objc-advanced-worker-'));
    const filePath = 'Sources/Store+Testing.m';
    const content = [
      '@class Foo, Bar;',
      '@protocol Forward;',
      '@interface Store (Testing)',
      '- (void)exercise;',
      '@end',
      '@interface Store () { NSString *_token; }',
      '@property (class, readonly, getter=currentName) NSString *name;',
      '@end',
      '@implementation Store (Testing)',
      '- (void)exercise {',
      '  void (^handler)(BOOL) = ^(BOOL ok) { NSLog(@"ok"); };',
      '  handler(YES);',
      '}',
      '@end',
      '',
    ].join('\n');
    const absolute = path.join(repoDir, filePath);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content);

    const graph = createKnowledgeGraph();
    await runChunkedParseAndResolve(
      graph,
      [{ path: filePath, size: Buffer.byteLength(content) }],
      [filePath],
      1,
      repoDir,
      Date.now(),
      () => {},
      { workerPoolSize: 1 },
    );

    const sourceNodes = graph.nodes.filter((node) => node.properties.filePath === filePath);
    expect(sourceNodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: 'CodeElement',
          properties: expect.objectContaining({ name: 'Store(Testing)' }),
        }),
        expect.objectContaining({
          label: 'CodeElement',
          properties: expect.objectContaining({ name: 'Store(<extension>)' }),
        }),
        expect.objectContaining({
          label: 'Class',
          properties: expect.objectContaining({ name: 'Foo' }),
        }),
        expect.objectContaining({
          label: 'Class',
          properties: expect.objectContaining({ name: 'Bar' }),
        }),
        expect.objectContaining({
          label: 'Interface',
          properties: expect.objectContaining({ name: 'Forward' }),
        }),
        expect.objectContaining({
          label: 'Variable',
          properties: expect.objectContaining({ name: '_token', declaredType: 'NSString *' }),
        }),
        expect.objectContaining({
          label: 'Function',
          properties: expect.objectContaining({ name: expect.stringMatching(/^block@/) }),
        }),
      ]),
    );

    const blockNode = sourceNodes.find(
      (node) => node.label === 'Function' && String(node.properties.name).startsWith('block@'),
    );
    expect(
      graph.relationships.some(
        (relationship) =>
          relationship.type === 'HAS_METHOD' && relationship.targetId === blockNode?.id,
      ),
    ).toBe(false);
  });

  it('emits distinct position-stable selector facts identically on cold and warm runs', async () => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'objc-selector-worker-'));
    const filePath = 'Sources/Store.m';
    const content = [
      '@interface Store : NSObject',
      '- (void)configure;',
      '@end',
      '@implementation Store',
      '- (void)configure {',
      '  SEL first = @selector(save:);',
      '  SEL second = @selector(save:);',
      '  SEL wrapped = @selector /* wrapper */ (save:);',
      '  SEL spaced = @selector(save: completion:);',
      '  SEL malformed = @selector(123);',
      '}',
      '@end',
      '',
    ].join('\n');
    const absolute = path.join(repoDir, filePath);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content);
    const scanned = [{ path: filePath, size: Buffer.byteLength(content) }];
    const parseCache: ParseCache = {
      version: PARSE_CACHE_VERSION,
      entries: new Map(),
      usedKeys: new Set(),
    };

    const coldGraph = createKnowledgeGraph();
    const cold = await runChunkedParseAndResolve(
      coldGraph,
      scanned,
      [filePath],
      1,
      repoDir,
      Date.now(),
      () => {},
      { workerPoolSize: 1, parseCache },
    );
    const warmGraph = createKnowledgeGraph();
    const warm = await runChunkedParseAndResolve(
      warmGraph,
      scanned,
      [filePath],
      1,
      repoDir,
      Date.now(),
      () => {},
      { workerPoolSize: 1, parseCache },
    );

    const selectors = coldGraph.nodes.filter(
      (node) =>
        node.label === 'CodeElement' &&
        node.properties.filePath === filePath &&
        node.properties.name === '@selector(save:)',
    );
    expect(selectors).toHaveLength(3);
    expect(new Set(selectors.map((node) => node.id))).toHaveLength(3);
    expect(new Set(selectors.map((node) => node.properties.sourceIdentity))).toHaveLength(3);
    expect(
      selectors.every((node) =>
        (node.properties.annotations as string[] | undefined)?.includes('objc:selector-reference'),
      ),
    ).toBe(true);
    expect(
      coldGraph.nodes.some(
        (node) =>
          node.label === 'CodeElement' &&
          node.properties.filePath === filePath &&
          node.properties.name === '@selector(save:completion:)' &&
          node.properties.selector === 'save:completion:',
      ),
    ).toBe(true);
    expect(
      coldGraph.nodes.some(
        (node) =>
          node.label === 'CodeElement' &&
          node.properties.filePath === filePath &&
          node.properties.name === '@selector(123)',
      ),
    ).toBe(false);

    for (const selector of selectors) {
      expect(
        coldGraph.relationships.some(
          (relationship) =>
            relationship.type === 'DEFINES' && relationship.targetId === selector.id,
        ),
      ).toBe(true);
      expect(
        coldGraph.relationships.some(
          (relationship) =>
            (relationship.sourceId === selector.id || relationship.targetId === selector.id) &&
            (relationship.type === 'CALLS' || relationship.type === 'USES'),
        ),
      ).toBe(false);
    }

    expect(cold.usedWorkerPool).toBe(true);
    expect(warm.usedWorkerPool).toBe(false);
    expect(sourceGraphSnapshot(warmGraph, filePath)).toEqual(
      sourceGraphSnapshot(coldGraph, filePath),
    );
  });

  it('emits method availability and Apple enum annotations without sibling pollution', async () => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'objc-apple-facts-worker-'));
    const filePath = 'Sources/Store.h';
    const content = [
      'typedef NS_ENUM(NSInteger, Mode) { ModeA };',
      'typedef NS_OPTIONS(NSUInteger, Features) { FeatureA = 1 };',
      '@interface Store : NSObject',
      '- (void)legacy API_AVAILABLE(ios(13.0));',
      '- (void)modern API_AVAILABLE(ios(17.0));',
      '- (void)plain;',
      '@end',
      '',
    ].join('\n');
    const absolute = path.join(repoDir, filePath);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content);

    const scanned = [{ path: filePath, size: Buffer.byteLength(content) }];
    const parseCache: ParseCache = {
      version: PARSE_CACHE_VERSION,
      entries: new Map(),
      usedKeys: new Set(),
    };
    const graph = createKnowledgeGraph();
    const cold = await runChunkedParseAndResolve(
      graph,
      scanned,
      [filePath],
      1,
      repoDir,
      Date.now(),
      () => {},
      { workerPoolSize: 1, parseCache },
    );
    const warmGraph = createKnowledgeGraph();
    const warm = await runChunkedParseAndResolve(
      warmGraph,
      scanned,
      [filePath],
      1,
      repoDir,
      Date.now(),
      () => {},
      { workerPoolSize: 1, parseCache },
    );

    const annotationsFor = (label: string, name: string): string[] =>
      (graph.nodes.find(
        (node) =>
          node.label === label &&
          node.properties.filePath === filePath &&
          node.properties.name === name,
      )?.properties.annotations as string[] | undefined) ?? [];

    expect(annotationsFor('Enum', 'Mode')).toContain('objc:ns-enum');
    expect(annotationsFor('Enum', 'Features')).toContain('objc:ns-options');
    expect(
      graph.nodes.find(
        (node) =>
          node.label === 'Enum' &&
          node.properties.filePath === filePath &&
          node.properties.name === 'Mode',
      )?.properties.underlyingType,
    ).toBe('NSInteger');
    expect(
      graph.nodes.find(
        (node) =>
          node.label === 'Enum' &&
          node.properties.filePath === filePath &&
          node.properties.name === 'Features',
      )?.properties.underlyingType,
    ).toBe('NSUInteger');
    expect(annotationsFor('Method', '-legacy')).toContain(
      'objc:availability:API_AVAILABLE(ios(13.0))',
    );
    expect(annotationsFor('Method', '-legacy')).not.toContain(
      'objc:availability:API_AVAILABLE(ios(17.0))',
    );
    expect(annotationsFor('Method', '-modern')).toContain(
      'objc:availability:API_AVAILABLE(ios(17.0))',
    );
    expect(annotationsFor('Method', '-modern')).not.toContain(
      'objc:availability:API_AVAILABLE(ios(13.0))',
    );
    expect(annotationsFor('Method', '-plain')).toEqual(
      expect.not.arrayContaining([expect.stringMatching(/^objc:availability:/)]),
    );
    expect(cold.usedWorkerPool).toBe(true);
    expect(warm.usedWorkerPool).toBe(false);
    expect(sourceGraphSnapshot(warmGraph, filePath)).toEqual(sourceGraphSnapshot(graph, filePath));
  });

  it('matches a fresh canonical graph after an incremental Objective-C cache invalidation', async () => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'objc-incremental-parity-'));
    const filePath = 'Sources/Service.m';
    const absolute = path.join(repoDir, filePath);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    const initial = [
      '@interface Service : NSObject',
      '- (void)oldWork;',
      '@end',
      '@implementation Service',
      '- (void)oldWork {}',
      '@end',
      '',
    ].join('\n');
    const updated = [
      '@interface Service : NSObject',
      '- (void)newWork;',
      '@end',
      '@implementation Service',
      '- (void)newWork {}',
      '@end',
      '',
    ].join('\n');
    const parseCache: ParseCache = {
      version: PARSE_CACHE_VERSION,
      entries: new Map(),
      usedKeys: new Set(),
    };

    fs.writeFileSync(absolute, initial);
    await runChunkedParseAndResolve(
      createKnowledgeGraph(),
      [{ path: filePath, size: Buffer.byteLength(initial) }],
      [filePath],
      1,
      repoDir,
      Date.now(),
      () => {},
      { workerPoolSize: 1, parseCache },
    );

    fs.writeFileSync(absolute, updated);
    const incrementalGraph = createKnowledgeGraph();
    const incremental = await runChunkedParseAndResolve(
      incrementalGraph,
      [{ path: filePath, size: Buffer.byteLength(updated) }],
      [filePath],
      1,
      repoDir,
      Date.now(),
      () => {},
      { workerPoolSize: 1, parseCache },
    );
    const freshGraph = createKnowledgeGraph();
    await runChunkedParseAndResolve(
      freshGraph,
      [{ path: filePath, size: Buffer.byteLength(updated) }],
      [filePath],
      1,
      repoDir,
      Date.now(),
      () => {},
      {
        workerPoolSize: 1,
        parseCache: {
          version: PARSE_CACHE_VERSION,
          entries: new Map(),
          usedKeys: new Set(),
        },
      },
    );

    expect(incremental.usedWorkerPool).toBe(true);
    expect(sourceGraphSnapshot(incrementalGraph, filePath)).toEqual(
      sourceGraphSnapshot(freshGraph, filePath),
    );
    expect(
      incrementalGraph.nodes.some(
        (node) => node.label === 'Method' && node.properties.name === '-oldWork',
      ),
    ).toBe(false);
    expect(
      incrementalGraph.nodes.some(
        (node) => node.label === 'Method' && node.properties.name === '-newWork',
      ),
    ).toBe(true);
  });
});

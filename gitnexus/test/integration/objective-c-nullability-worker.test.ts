import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { runChunkedParseAndResolve } from '../../src/core/ingestion/pipeline-phases/parse-impl.js';
import { PARSE_CACHE_VERSION, type ParseCache } from '../../src/storage/parse-cache.js';

describe('Objective-C nullability metadata worker roundtrip', () => {
  let repoDir = '';

  afterEach(() => {
    if (repoDir.length > 0) fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it('preserves declaration nullability on methods, properties, and synthesized accessors', async () => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'objc-nullability-worker-'));
    const filePath = 'Sources/NullableStore.h';
    const content = [
      'NS_ASSUME_NONNULL_BEGIN',
      '@interface NullableStore : NSObject',
      '@property (nonatomic) NSString *title;',
      '@property (nonatomic) NSString * _Nullable nickname;',
      '@property (nullable) NSString *contextualName;',
      '@property (null_resettable) NSString *token;',
      '- (NSString *)lookup:(NSString *)key;',
      '- (NSString * _Nullable)optionalLookup:(NSString * _Nonnull)key;',
      '- (nullable NSString *)contextualLookup:(nonnull NSString *)key fallback:(null_unspecified id)value;',
      '@end',
      'NS_ASSUME_NONNULL_END',
      '',
    ].join('\n');
    const absolutePath = path.join(repoDir, filePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, content);

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

    const declarations = (graph: typeof coldGraph) =>
      graph.nodes
        .filter(
          (node) =>
            node.properties.filePath === filePath &&
            (node.label === 'Method' || node.label === 'Property'),
        )
        .map((node) => ({
          id: node.id,
          label: node.label,
          name: node.properties.name,
          annotations: node.properties.annotations,
        }))
        .sort((left, right) => left.id.localeCompare(right.id));
    const annotationFor = (label: string, name: string): readonly string[] =>
      (coldGraph.nodes.find(
        (node) =>
          node.label === label &&
          node.properties.filePath === filePath &&
          node.properties.name === name,
      )?.properties.annotations as readonly string[] | undefined) ?? [];

    expect(annotationFor('Method', '-lookup:')).toContain('objc:nullability:assumed-nonnull');
    expect(annotationFor('Property', 'title')).toContain('objc:nullability:assumed-nonnull');
    expect(annotationFor('Method', '-optionalLookup:')).toEqual(
      expect.arrayContaining(['objc:nullability:_Nullable', 'objc:nullability:_Nonnull']),
    );
    expect(annotationFor('Method', '-optionalLookup:')).not.toContain(
      'objc:nullability:assumed-nonnull',
    );
    expect(annotationFor('Property', 'nickname')).toContain('objc:nullability:_Nullable');
    expect(annotationFor('Method', '-contextualLookup:fallback:')).toEqual(
      expect.arrayContaining([
        'objc:nullability:_Nullable',
        'objc:nullability:_Nonnull',
        'objc:nullability:_Null_unspecified',
      ]),
    );
    expect(annotationFor('Method', '-contextualLookup:fallback:')).not.toContain(
      'objc:nullability:assumed-nonnull',
    );
    expect(annotationFor('Property', 'contextualName')).toContain('objc:nullability:_Nullable');
    expect(annotationFor('Property', 'token')).toContain('objc:nullability:null_resettable');
    const accessorAnnotations = new Map(
      cold.parsedFiles
        .flatMap((parsedFile) => parsedFile.localDefs)
        .filter((definition) =>
          [
            '-title',
            '-setTitle:',
            '-nickname',
            '-setNickname:',
            '-contextualName',
            '-setContextualName:',
            '-token',
            '-setToken:',
          ].includes(definition.qualifiedName),
        )
        .map((definition) => [definition.qualifiedName, definition.annotations] as const),
    );
    expect(accessorAnnotations.get('-title')).toContain('objc:nullability:assumed-nonnull');
    expect(accessorAnnotations.get('-setTitle:')).toContain('objc:nullability:assumed-nonnull');
    expect(accessorAnnotations.get('-nickname')).toContain('objc:nullability:_Nullable');
    expect(accessorAnnotations.get('-setNickname:')).toContain('objc:nullability:_Nullable');
    expect(accessorAnnotations.get('-nickname')).not.toContain('objc:nullability:assumed-nonnull');
    expect(accessorAnnotations.get('-contextualName')).toContain('objc:nullability:_Nullable');
    expect(accessorAnnotations.get('-setContextualName:')).toContain('objc:nullability:_Nullable');
    expect(accessorAnnotations.get('-token')).toContain('objc:nullability:null_resettable');
    expect(accessorAnnotations.get('-setToken:')).toContain('objc:nullability:null_resettable');
    expect(cold.usedWorkerPool).toBe(true);
    expect(warm.usedWorkerPool).toBe(false);
    expect(declarations(warmGraph)).toEqual(declarations(coldGraph));
  });
});

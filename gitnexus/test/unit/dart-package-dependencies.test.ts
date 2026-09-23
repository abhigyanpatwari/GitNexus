import { describe, expect, it } from 'vitest';
import type { ParsedFile, ScopeId } from 'gitnexus-shared';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { generateId } from '../../src/lib/utils.js';
import { emitDartPackageDependencies } from '../../src/core/ingestion/languages/dart/package-dependencies.js';
import { computeEffectiveWriteSet } from '../../src/core/incremental/subgraph-extract.js';
import { GraphEmitSink } from '../../src/core/lbug/graph-emit-sink.js';

function consumer(filePath: string, targets: string[]): ParsedFile {
  return {
    filePath,
    moduleScope: `module:${filePath}` as ScopeId,
    scopes: [],
    parsedImports: targets.map((targetRaw) => ({ kind: 'wildcard', targetRaw })),
    localDefs: [],
    referenceSites: [],
  };
}

function graphWithFiles(paths: string[]) {
  const graph = createKnowledgeGraph();
  for (const filePath of paths) {
    graph.addNode({
      id: generateId('File', filePath),
      label: 'File',
      properties: { name: filePath, filePath },
    });
  }
  return graph;
}

describe('Dart package identity dependencies', () => {
  it.each([
    { files: 400, packages: 251, dense: false, limit: 'dependency limit' },
    { files: 150, packages: 100, dense: true, limit: 'dependency traversal limit' },
  ])(
    'fails explicitly before partial emission at the $limit',
    ({ files, packages, dense, limit }) => {
      const paths = Array.from({ length: files }, (_, i) => `f${i}.dart`);
      const manifests = Array.from({ length: packages }, (_, i) => `p${i}/pubspec.yaml`);
      const graph = graphWithFiles([...paths, ...manifests]);
      for (let i = 0; i < files; i++) {
        const targets = dense ? paths : [paths[(i + 1) % files]];
        for (const target of targets) {
          graph.addRelationship({
            id: `${paths[i]}->${target}`,
            sourceId: `File:${paths[i]}`,
            targetId: `File:${target}`,
            type: 'IMPORTS',
            confidence: 1,
            reason: 'dart-scope: import',
          });
        }
      }
      const originalCount = graph.relationshipCount;
      expect(() =>
        emitDartPackageDependencies(
          graph,
          paths.map((file, i) => consumer(file, [`package:p${i % packages}/model.dart`])),
          {
            packages: new Map(),
            manifestsByName: new Map(manifests.map((file, i) => [`p${i}`, [file]])),
          },
        ),
      ).toThrow(`Dart package ${limit} exceeded`);
      expect(graph.relationshipCount).toBe(originalCount);
    },
  );

  it('preserves transitive dependencies and idempotence through the streaming sink', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'dart-package-stream-'));
    const graph = graphWithFiles(['a.dart', 'b.dart', 'pubspec.yaml']);
    const sink = new GraphEmitSink(graph, path.join(root, 'csv'));
    try {
      sink.beginStreaming();
      sink.addRelationship({
        id: 'IMPORTS:File:b.dart->File:a.dart',
        sourceId: 'File:b.dart',
        targetId: 'File:a.dart',
        type: 'IMPORTS',
        confidence: 1,
        reason: 'dart-scope: import',
      });
      const parsed = [
        consumer('a.dart', ['package:app/model.dart']),
        consumer('b.dart', ['./a.dart']),
      ];
      const config = { packages: new Map(), manifestsByName: new Map([['app', ['pubspec.yaml']]]) };
      emitDartPackageDependencies(sink, parsed, config);
      emitDartPackageDependencies(sink, parsed, config);
      const edges: string[] = [];
      sink.forEachRelationshipFields((source, target, type, _confidence, reason) => {
        if (type === 'IMPORTS') edges.push(`${source}->${target}:${reason}`);
      });
      expect(edges.sort()).toEqual([
        'File:a.dart->File:pubspec.yaml:dart-scope: package identity dependency',
        'File:b.dart->File:a.dart:dart-scope: import',
        'File:b.dart->File:pubspec.yaml:dart-scope: package identity dependency',
      ]);
      const manifest = sink.finalize();
      expect(manifest.totalRows).toBe(3);
      const csv = manifest.relsByPair.get('File|File');
      expect(csv?.rows).toBe(3);
      if (!csv) throw new Error('Missing File-to-File CSV');
      expect((await readFile(csv.csvPath, 'utf8')).trim().split('\n')).toHaveLength(4);
      expect(graph.relationshipCount).toBe(0);
    } finally {
      sink.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('tracks all duplicate candidates even when no package resolves, idempotently', () => {
    const graph = graphWithFiles(['main.dart', 'pubspec.yaml', 'nested/pubspec.yaml']);
    const parsed = [consumer('main.dart', ['package:app/a.dart', 'package:app/b.dart'])];
    const config = {
      packages: new Map(),
      manifestsByName: new Map([['app', ['pubspec.yaml', 'nested/pubspec.yaml']]]),
    };
    emitDartPackageDependencies(graph, parsed, config);
    emitDartPackageDependencies(graph, parsed, config);
    expect(graph.relationships.map((edge) => [edge.targetId, edge.reason])).toEqual([
      ['File:pubspec.yaml', 'dart-scope: package identity dependency'],
      ['File:nested/pubspec.yaml', 'dart-scope: package identity dependency'],
    ]);
    expect(computeEffectiveWriteSet(graph, new Set(['nested/pubspec.yaml']))).toEqual(
      new Set(['nested/pubspec.yaml', 'main.dart']),
    );
  });

  it('does not connect unrelated packages, relative imports, SDK imports, or files without imports', () => {
    const graph = graphWithFiles([
      'a.dart',
      'b.dart',
      'c.dart',
      'pubspec.yaml',
      'other/pubspec.yaml',
    ]);
    emitDartPackageDependencies(
      graph,
      [
        consumer('a.dart', ['package:app/missing.dart', 'package:external/http.dart']),
        consumer('b.dart', ['./a.dart', 'dart:core']),
        consumer('c.dart', []),
      ],
      {
        packages: new Map(),
        manifestsByName: new Map([
          ['app', ['pubspec.yaml']],
          ['other', ['other/pubspec.yaml']],
        ]),
      },
    );
    expect(graph.relationships.map((edge) => [edge.sourceId, edge.targetId])).toEqual([
      ['File:a.dart', 'File:pubspec.yaml'],
    ]);
  });

  it('includes transitive consumers in fresh-manifest invalidation and terminates on cycles', () => {
    const graph = graphWithFiles(['a.dart', 'b.dart', 'c.dart', 'pubspec.yaml']);
    for (const [source, target] of [
      ['b.dart', 'a.dart'],
      ['c.dart', 'b.dart'],
      ['a.dart', 'c.dart'],
    ]) {
      graph.addRelationship({
        id: `${source}->${target}`,
        sourceId: `File:${source}`,
        targetId: `File:${target}`,
        type: 'IMPORTS',
        confidence: 1,
        reason: 'dart-scope: import',
      });
    }
    emitDartPackageDependencies(
      graph,
      [
        consumer('a.dart', ['package:app/a.dart']),
        consumer('b.dart', ['./a.dart']),
        consumer('c.dart', ['./b.dart']),
      ],
      { packages: new Map(), manifestsByName: new Map([['app', ['pubspec.yaml']]]) },
    );
    expect(
      graph.relationships
        .filter((edge) => edge.reason === 'dart-scope: package identity dependency')
        .map((edge) => [edge.sourceId, edge.targetId]),
    ).toEqual([
      ['File:a.dart', 'File:pubspec.yaml'],
      ['File:b.dart', 'File:pubspec.yaml'],
      ['File:c.dart', 'File:pubspec.yaml'],
    ]);
    expect(computeEffectiveWriteSet(graph, new Set(['pubspec.yaml']))).toEqual(
      new Set(['pubspec.yaml', 'a.dart', 'b.dart', 'c.dart']),
    );
  });

  it('refuses to persist dependencies on manifests absent from the indexed graph', () => {
    const graph = graphWithFiles(['a.dart']);
    expect(() =>
      emitDartPackageDependencies(graph, [consumer('a.dart', ['package:app/a.dart'])], {
        packages: new Map(),
        manifestsByName: new Map([['app', ['pubspec.yaml']]]),
      }),
    ).toThrow('Dart package manifest is missing from the indexed file set: pubspec.yaml');
    expect(graph.relationships).toEqual([]);
  });

  it('emits only matching dependencies in a many-package workspace', () => {
    const paths = Array.from({ length: 200 }, (_, i) => `p${i}/pubspec.yaml`);
    const graph = graphWithFiles([...paths, 'main.dart']);
    emitDartPackageDependencies(graph, [consumer('main.dart', ['package:p199/a.dart'])], {
      packages: new Map(),
      manifestsByName: new Map(paths.map((filePath, i) => [`p${i}`, [filePath]])),
    });
    expect(graph.relationships.map((edge) => edge.targetId)).toEqual(['File:p199/pubspec.yaml']);
  });
});

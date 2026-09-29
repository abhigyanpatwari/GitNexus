/**
 * Intra-group implicit IMPORTS. @_exported is client-facing
 * (`resolveSwiftImportTarget`); siblings in the exporting target
 * must not gain edges to the reexported module.
 */
import { describe, expect, it } from 'vitest';
import type { ParsedFile, ParsedImport, ScopeId } from 'gitnexus-shared';
import { createKnowledgeGraph } from '../../../../src/core/graph/graph.js';
import { generateId } from '../../../../src/lib/utils.js';
import {
  emitSwiftImplicitImportEdges,
  swiftModuleNodeId,
} from '../../../../src/core/ingestion/languages/swift/implicit-imports.js';
import { MODULE_MEMBERSHIP_REASON } from '../../../../src/core/graph/edge-reasons.js';
import { resolveSwiftImportTarget } from '../../../../src/core/ingestion/languages/swift/import-target.js';

const DECLARED = {
  origin: 'package.swift' as const,
  targets: new Map([
    ['A', 'Sources/A'],
    ['B', 'Sources/B'],
  ]),
};

function stubFile(filePath: string, parsedImports: ParsedImport[] = []): ParsedFile {
  return {
    filePath,
    moduleScope: `module:${filePath}` as ScopeId,
    scopes: [],
    parsedImports,
    localDefs: [],
    referenceSites: [],
  };
}

function reexport(targetRaw: string): ParsedImport {
  return { kind: 'reexport', localName: targetRaw, importedName: targetRaw, targetRaw };
}

function ns(targetRaw: string): ParsedImport {
  return { kind: 'namespace', localName: targetRaw, importedName: targetRaw, targetRaw };
}

function importPair(rels: readonly { sourceId: string; targetId: string; type: string }[]) {
  return rels
    .filter((rel) => rel.type === 'IMPORTS')
    .map((rel) => `${rel.sourceId}->${rel.targetId}`)
    .sort();
}

describe('emitSwiftImplicitImportEdges', () => {
  it('does not paint sibling files into a @_exported module', () => {
    const a = 'Sources/A/A.swift';
    const other = 'Sources/A/Other.swift';
    const b = 'Sources/B/B.swift';
    const parsed = [stubFile(a, [reexport('B')]), stubFile(other), stubFile(b)];
    const graph = createKnowledgeGraph();

    emitSwiftImplicitImportEdges(graph, parsed, new Map(), DECLARED);

    const pairs = importPair(graph.relationships);
    const hubA = swiftModuleNodeId('A');
    expect(pairs).toEqual(
      [`${generateId('File', a)}->${hubA}`, `${generateId('File', other)}->${hubA}`].sort(),
    );
    expect(pairs.some((pair) => pair.includes(generateId('File', b)))).toBe(false);

    const fromApp = resolveSwiftImportTarget(ns('A'), {
      fromFile: 'Sources/App/main.swift',
      allFilePaths: new Set([a, other, b, 'Sources/App/main.swift']),
      resolutionConfig: DECLARED,
      parsedFiles: parsed,
    });
    expect(fromApp).toEqual(expect.arrayContaining([a, other, b]));
  });
});

describe('emitSwiftImplicitImportEdges — one Module hub per module (#3355)', () => {
  const files = (dir: string, n: number): ParsedFile[] =>
    Array.from({ length: n }, (_, i) => stubFile(`${dir}/F${i}.swift`));

  it('emits one Module node and one membership edge per member file', () => {
    const graph = createKnowledgeGraph();
    emitSwiftImplicitImportEdges(graph, files('Sources/A', 4), new Map(), DECLARED);

    const edges = graph.relationships.filter((rel) => rel.type === 'IMPORTS');
    expect(edges).toHaveLength(4);
    expect(edges.every((rel) => rel.targetId === swiftModuleNodeId('A'))).toBe(true);
    expect(edges.every((rel) => rel.reason === MODULE_MEMBERSHIP_REASON)).toBe(true);
    expect(graph.getNode(swiftModuleNodeId('A'))).toMatchObject({
      label: 'Module',
      properties: { name: 'A', filePath: 'Sources/A' },
    });
  });

  it('stays linear in module size where the pairwise form would exceed the Map limit', () => {
    const graph = createKnowledgeGraph();
    // 5,000 files: pairwise would be ~25M edges, over V8's 2^24 Map entries.
    emitSwiftImplicitImportEdges(graph, files('App', 5000), new Map(), null);

    expect(graph.relationships.filter((rel) => rel.type === 'IMPORTS')).toHaveLength(5000);
    expect(graph.getNode(swiftModuleNodeId('__default__'))).toMatchObject({
      properties: { name: '__default__', filePath: '.' },
    });
  });

  it('skips single-file modules and keeps modules apart', () => {
    const graph = createKnowledgeGraph();
    emitSwiftImplicitImportEdges(
      graph,
      [...files('Sources/A', 2), ...files('Sources/B', 1)],
      new Map(),
      DECLARED,
    );

    expect(importPair(graph.relationships)).toEqual(
      [
        `${generateId('File', 'Sources/A/F0.swift')}->${swiftModuleNodeId('A')}`,
        `${generateId('File', 'Sources/A/F1.swift')}->${swiftModuleNodeId('A')}`,
      ].sort(),
    );
    expect(graph.getNode(swiftModuleNodeId('B'))).toBeUndefined();
  });

  it('links a file compiled into two Xcode targets to both modules', () => {
    const shared = 'App/Shared.swift';
    const config = {
      targets: new Map(),
      modules: [
        {
          key: 'xcode:App.xcodeproj:App',
          name: 'App',
          files: [shared, 'App/Main.swift'],
          importable: true,
        },
        {
          key: 'xcode:App.xcodeproj:Widget',
          name: 'Widget',
          files: [shared, 'App/Widget.swift'],
          importable: true,
        },
      ],
    };
    const graph = createKnowledgeGraph();
    emitSwiftImplicitImportEdges(
      graph,
      [stubFile(shared), stubFile('App/Main.swift'), stubFile('App/Widget.swift')],
      new Map(),
      config,
    );

    const fromShared = graph.relationships
      .filter((rel) => rel.sourceId === generateId('File', shared))
      .map((rel) => rel.targetId)
      .sort();
    expect(fromShared).toEqual(
      [
        swiftModuleNodeId('xcode:App.xcodeproj:App'),
        swiftModuleNodeId('xcode:App.xcodeproj:Widget'),
      ].sort(),
    );
    expect(graph.getNode(swiftModuleNodeId('xcode:App.xcodeproj:App'))).toMatchObject({
      properties: { filePath: 'App.xcodeproj' },
    });
  });
});

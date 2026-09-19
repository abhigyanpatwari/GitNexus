/**
 * Intra-group implicit IMPORTS. @_exported is client-facing
 * (`resolveSwiftImportTarget`); siblings in the exporting target
 * must not gain edges to the reexported module.
 */
import { describe, expect, it } from 'vitest';
import type { ParsedFile, ParsedImport, ScopeId } from 'gitnexus-shared';
import { createKnowledgeGraph } from '../../../../src/core/graph/graph.js';
import { generateId } from '../../../../src/lib/utils.js';
import { emitSwiftImplicitImportEdges } from '../../../../src/core/ingestion/languages/swift/implicit-imports.js';
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
    expect(pairs).toEqual(
      [
        `${generateId('File', a)}->${generateId('File', other)}`,
        `${generateId('File', other)}->${generateId('File', a)}`,
      ].sort(),
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

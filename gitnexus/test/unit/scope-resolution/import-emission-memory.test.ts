import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { GraphRelationship, ImportEdge, Scope, ScopeId, ScopeTree } from 'gitnexus-shared';
import { buildScopeTree } from 'gitnexus-shared';
import { emitImportEdges } from '../../../src/core/ingestion/scope-resolution/graph-bridge/imports-to-edges.js';
import { TransitionalScopeTree } from '../../../src/storage/scope-index-store.js';
import type { KnowledgeGraph } from '../../../src/core/graph/types.js';

const tempDirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'import-emission-'));
  tempDirs.push(dir);
  return dir;
}

function scope(id: string, filePath: string): Scope {
  return {
    id: id as ScopeId,
    filePath,
    parent: null,
    kind: 'Module',
    range: { startLine: 0, startCol: 0, endLine: 10, endCol: 0 },
    bindings: new Map(),
    typeBindings: new Map(),
    ownedDefs: [],
    imports: [],
  };
}

function edge(targetFile: string | null, extra: Partial<ImportEdge> = {}): ImportEdge {
  return {
    targetFile,
    kind: 'named',
    localName: 'X',
    targetExportedName: 'X',
    ...extra,
  } as ImportEdge;
}

function imports(entries: [string, ImportEdge[]][]): Map<ScopeId, readonly ImportEdge[]> {
  return new Map(entries.map(([id, edges]) => [id as ScopeId, Object.freeze(edges)]));
}

function collect(input: Map<ScopeId, readonly ImportEdge[]>, tree: ScopeTree) {
  const edges: GraphRelationship[] = [];
  const count = emitImportEdges(
    { addRelationship: (rel: GraphRelationship) => edges.push(rel) } as unknown as KnowledgeGraph,
    input,
    tree,
    'custom import',
  );
  return { count, edges };
}

describe('import emission memory boundaries', () => {
  it('combines consecutive scopes of a file before choosing each pair reason', () => {
    const tree = buildScopeTree([scope('a-module', 'a'), scope('a-local', 'a'), scope('b', 'b')]);
    const result = collect(
      imports([
        ['a-module', [edge('target', { typeOnly: true }), edge('later', { typeOnly: true })]],
        ['a-local', [edge('later', { runsOnlyWhenCalled: true }), edge('target')]],
        ['b', [edge('other')]],
      ]),
      tree,
    );
    expect(result.count).toBe(3);
    expect(result.edges.map((rel) => [rel.id, rel.reason])).toEqual([
      ['IMPORTS:a->target', 'custom import'],
      ['IMPORTS:a->later', 'custom import (deferred)'],
      ['IMPORTS:b->other', 'custom import'],
    ]);
  });

  it('emits a completed file before reading the next file import targets', () => {
    const events: string[] = [];
    const next = edge('later');
    Object.defineProperty(next, 'targetFile', {
      get: () => {
        events.push('read-b');
        return 'later';
      },
    });
    const tree = buildScopeTree([scope('a', 'a'), scope('b', 'b')]);
    emitImportEdges(
      { addRelationship: () => events.push('emit') } as unknown as KnowledgeGraph,
      imports([
        ['a', [edge('first')]],
        ['b', [next]],
      ]),
      tree,
    );
    expect(events[0]).toBe('emit');
    expect(events.indexOf('read-b')).toBeGreaterThan(0);
  });

  it('preserves first-seen order and late reason upgrades for interleaved files', () => {
    const tree = buildScopeTree([scope('a1', 'a'), scope('b', 'b'), scope('a2', 'a')]);
    const result = collect(
      imports([
        ['a1', [edge('x', { typeOnly: true })]],
        ['b', [edge('y')]],
        ['a2', [edge('x'), edge('z')]],
      ]),
      tree,
    );
    expect(result.edges.map((rel) => [rel.id, rel.reason])).toEqual([
      ['IMPORTS:a->x', 'custom import'],
      ['IMPORTS:b->y', 'custom import'],
      ['IMPORTS:a->z', 'custom import'],
    ]);
    expect(result.count).toBe(3);
  });

  it('keeps legacy compound-key collisions identical for delimiter-containing paths', () => {
    const tree = buildScopeTree([scope('first', 'a->b'), scope('second', 'a')]);
    const result = collect(
      imports([
        ['first', [edge('c', { typeOnly: true })]],
        ['second', [edge('b->c')]],
      ]),
      tree,
    );
    expect(result.count).toBe(1);
    expect(result.edges[0]).toMatchObject({
      id: 'IMPORTS:a->b->c',
      sourceId: 'File:a->b',
      targetId: 'File:c',
      reason: 'custom import',
    });
  });

  it('skips missing scopes, self imports and null targets while retaining empty paths', () => {
    const tree = buildScopeTree([scope('empty', ''), scope('a', 'a')]);
    const result = collect(
      imports([
        ['missing', [edge('missing-target')]],
        ['empty', [edge(null), edge(''), edge('a')]],
        ['a', [edge('a'), edge('')]],
      ]),
      tree,
    );
    expect(result.edges.map((rel) => rel.id)).toEqual(['IMPORTS:->a', 'IMPORTS:a->']);
    expect(result.count).toBe(2);
    expect(collect(new Map(), tree)).toEqual({ count: 0, edges: [] });
  });

  it('reads each disk-backed scope once and matches resident-scope output', () => {
    const scopes = [scope('a1', 'a'), scope('a2', 'a'), scope('b', 'b'), scope('c', 'c')];
    const input = imports([
      ['a1', [edge('b', { typeOnly: true })]],
      ['a2', [edge('b')]],
      ['b', [edge('c')]],
      ['c', [edge('a')]],
    ]);
    const disk = new TransitionalScopeTree(scopes);
    disk.seal(tempDir(), 1);
    const reads = vi.spyOn(disk, 'getScope');
    expect(collect(input, disk)).toEqual(collect(input, buildScopeTree(scopes)));
    expect(reads).toHaveBeenCalledTimes(input.size);
  });

  it('propagates scope-read failure before writing any edges', () => {
    const tree = buildScopeTree([scope('a', 'a'), scope('b', 'b')]);
    const original = tree.getScope.bind(tree);
    vi.spyOn(tree, 'getScope').mockImplementation((id) => {
      if (id === 'b') throw new Error('scope shard unreadable');
      return original(id);
    });
    const addRelationship = vi.fn();
    expect(() =>
      emitImportEdges(
        { addRelationship } as unknown as KnowledgeGraph,
        imports([
          ['a', [edge('x')]],
          ['b', [edge('y')]],
        ]),
        tree,
      ),
    ).toThrow('scope shard unreadable');
    expect(addRelationship).not.toHaveBeenCalled();
  });

  it('records bounded planning, collection and emission checkpoints in the probe file', () => {
    const probeFile = path.join(tempDir(), 'heap.log');
    vi.stubEnv('GITNEXUS_DEBUG_HEAP', '1');
    vi.stubEnv('GITNEXUS_HEAP_PROBE_FILE', probeFile);
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const scopes = Array.from({ length: 1024 }, (_, i) => scope(`s${i}`, `source${i}`));
    const targets = Array.from({ length: 64 }, (_, i) => edge(`target${i}`));
    const input = imports(scopes.map((s) => [s.id, targets]));
    const count = emitImportEdges(
      { addRelationship() {} } as unknown as KnowledgeGraph,
      input,
      buildScopeTree(scopes),
    );
    expect(count).toBe(65536);
    const lines = readFileSync(probeFile, 'utf8').trim().split('\n');
    expect(lines.map((line) => line.split(' ')[1])).toEqual([
      'sr-emit-imports-start',
      'sr-emit-imports-plan-progress',
      'sr-emit-imports-plan-end',
      'sr-emit-imports-collect-progress',
      'sr-emit-imports-emit-progress',
      'sr-emit-imports-complete',
    ]);
    expect(lines[2]).toContain('mode=per-file');
    expect(lines.at(-1)).toContain('scanned=65536 emitted=65536');
  });

  it('propagates sink errors without reporting successful completion', () => {
    const probeFile = path.join(tempDir(), 'heap.log');
    vi.stubEnv('GITNEXUS_DEBUG_HEAP', '1');
    vi.stubEnv('GITNEXUS_HEAP_PROBE_FILE', probeFile);
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    expect(() =>
      emitImportEdges(
        {
          addRelationship() {
            throw new Error('disk full');
          },
        } as unknown as KnowledgeGraph,
        imports([['a', [edge('x')]]]),
        buildScopeTree([scope('a', 'a')]),
      ),
    ).toThrow('disk full');
    expect(readFileSync(probeFile, 'utf8')).not.toContain('sr-emit-imports-complete');
  });
});

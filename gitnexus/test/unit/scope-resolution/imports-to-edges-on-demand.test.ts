import { describe, expect, it, vi } from 'vitest';
import {
  buildScopeTree,
  type GraphRelationship,
  type ImportEdge,
  type Scope,
  type ScopeId,
} from 'gitnexus-shared';
import { createEagerImportVisibility } from 'gitnexus-shared';
import {
  emitImportEdges,
  type OnDemandImportTargetsOf,
} from '../../../src/core/ingestion/scope-resolution/graph-bridge/imports-to-edges.js';
import type { KnowledgeGraph } from '../../../src/core/graph/types.js';

function scope(filePath: string, id: ScopeId = filePath): Scope {
  return {
    id,
    filePath,
    parent: null,
    kind: 'Module',
    range: { startLine: 1, startCol: 0, endLine: 10, endCol: 0 },
    bindings: new Map(),
    typeBindings: new Map(),
    ownedDefs: [],
    imports: [],
  };
}
const wildcard = (targetFile: string): ImportEdge => ({
  kind: 'wildcard-expanded',
  localName: '',
  targetExportedName: '',
  targetFile,
});
const imports = new Map<ScopeId, readonly ImportEdge[]>([
  ['Main.java', [wildcard('User.java'), wildcard('Order.java')]],
]);
function emit(selected?: OnDemandImportTargetsOf, buckets = imports) {
  const edges: GraphRelationship[] = [];
  emitImportEdges(
    { addRelationship: (edge: GraphRelationship) => edges.push(edge) } as unknown as KnowledgeGraph,
    createEagerImportVisibility(buckets),
    buildScopeTree([scope('Main.java'), scope('Other.java'), scope('Main.java', 'late')]),
    'test',
    selected,
  );
  return edges;
}

describe('emitImportEdges on-demand targets', () => {
  it('emits only selected target files', () => {
    expect(emit(() => new Set(['User.java'])).map((edge) => edge.targetId)).toEqual([
      'File:User.java',
    ]);
  });
  it('emits no wildcard edges for a complete empty selection', () => {
    expect(emit(() => new Set())).toEqual([]);
  });
  it('keeps every edge when narrowing is absent or evidence is incomplete', () => {
    expect(emit()).toHaveLength(2);
    expect(emit(() => undefined)).toHaveLength(2);
  });
  it('keeps unused explicit imports and their strongest presence', () => {
    const buckets = new Map<ScopeId, readonly ImportEdge[]>([
      [
        'Main.java',
        [
          { ...wildcard('User.java'), runsOnlyWhenCalled: true },
          { ...wildcard('Order.java'), localName: 'Order', kind: 'named' },
        ],
      ],
    ]);
    expect(
      emit(() => new Set(['User.java']), buckets).map((edge) => [edge.targetId, edge.reason]),
    ).toEqual([
      ['File:User.java', 'test (deferred)'],
      ['File:Order.java', 'test'],
    ]);
  });
  it('resolves once per source even for interleaved scope buckets', () => {
    const selection = new Map([
      ['Main.java', ['Order.java']],
      ['Other.java', ['User.java']],
    ]);
    const select = vi.fn((file: string) => new Set(selection.get(file)));
    const buckets = new Map<ScopeId, readonly ImportEdge[]>([
      ['Main.java', [wildcard('User.java')]],
      ['Other.java', [wildcard('User.java')]],
      ['late', [wildcard('Order.java')]],
    ]);
    expect(emit(select, buckets).map((edge) => edge.id)).toEqual([
      'IMPORTS:Other.java->User.java',
      'IMPORTS:Main.java->Order.java',
    ]);
    expect(select.mock.calls).toEqual([['Main.java'], ['Other.java']]);
  });
  it('does not resolve uses for explicit-only imports', () => {
    const select = vi.fn(() => new Set<string>());
    emit(
      select,
      new Map([['Main.java', [{ ...wildcard('User.java'), kind: 'named', localName: 'User' }]]]),
    );
    expect(select).not.toHaveBeenCalled();
  });
  it('reports distinct files whose evidence was incomplete', () => {
    vi.stubEnv('GITNEXUS_DEBUG_HEAP', '1');
    vi.stubEnv('GITNEXUS_HEAP_PROBE_FILE', '');
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      expect(emit(() => undefined)).toHaveLength(2);
      const complete = stderr.mock.calls.find(([line]) =>
        String(line).includes('sr-emit-imports-complete'),
      );
      expect(String(complete?.[0])).toContain('incomplete_files=1');
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    }
  });
});

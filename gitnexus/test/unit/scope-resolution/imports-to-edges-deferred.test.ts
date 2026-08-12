/**
 * `emitImportEdges` — deferred-import tagging for `check --cycles`.
 *
 * A File→File `IMPORTS` edge is emitted for every resolved pair, deferred or
 * not, because impact and trace must see the dependency either way. What the
 * tag decides is whether the pair can force a module-INITIALIZATION order, and
 * only those can form the cycles `check --cycles` reports. Deferring an import
 * is the standard way to BREAK such a cycle, so counting deferred edges reports
 * the fix as the bug — this repository does it deliberately in two places
 * (`core/group/service.ts`, `eval/workflow_bench/proposer_sandbox.py`).
 *
 * Both spellings are covered here because neither signal catches both: `import()`
 * arrives as `kind: 'dynamic-resolved'`, while Python's `def f(): from x import Y`
 * is an ordinary import that is deferred only by WHERE it sits.
 *
 * The scope tree is posed directly rather than coaxed out of a language, the
 * same choice `graph-bridge-label-split.test.ts` makes for the same reason.
 */
import { describe, expect, it } from 'vitest';
import type { ImportEdge, Scope, ScopeId } from 'gitnexus-shared';
import {
  DEFERRED_IMPORT_REASON_SUFFIX,
  emitImportEdges,
} from '../../../src/core/ingestion/scope-resolution/graph-bridge/imports-to-edges.js';

interface Rel {
  readonly sourceId: string;
  readonly targetId: string;
  readonly type: string;
  readonly reason: string;
}

/** Minimal graph: records what was emitted, in emission order. */
function makeGraph() {
  const rels: Rel[] = [];
  return {
    rels,
    graph: { addRelationship: (r: Rel) => rels.push(r) },
  };
}

/** A scope tree posed as a flat map of id → { kind, parent, filePath }. */
function makeScopeTree(nodes: Readonly<Record<string, { kind: string; parent: string | null }>>) {
  return {
    getScope: (id: ScopeId): Scope | undefined => {
      const node = nodes[id as unknown as string];
      if (node === undefined) return undefined;
      return {
        id,
        parent: node.parent as unknown as ScopeId | null,
        kind: node.kind,
        filePath: 'src/a.ts',
      } as unknown as Scope;
    },
  };
}

function edge(targetFile: string, kind: ImportEdge['kind'] = 'named'): ImportEdge {
  return { localName: 'X', targetFile, targetExportedName: 'X', kind } as ImportEdge;
}

function emit(
  nodes: Readonly<Record<string, { kind: string; parent: string | null }>>,
  imports: ReadonlyMap<string, readonly ImportEdge[]>,
  reason?: string,
) {
  const { rels, graph } = makeGraph();
  const count = emitImportEdges(
    graph as never,
    imports as never,
    makeScopeTree(nodes) as never,
    reason,
  );
  return { rels, count };
}

const MODULE_ONLY = { mod: { kind: 'Module', parent: null } };

describe('emitImportEdges — deferred tagging', () => {
  it('a module-level import is not tagged', () => {
    const { rels, count } = emit(MODULE_ONLY, new Map([['mod', [edge('src/b.ts')]]]));
    expect(count).toBe(1);
    expect(rels[0].reason).toBe('scope-resolution: import');
  });

  it('a dynamic import() at module level IS tagged', () => {
    // `kind` alone carries this one — the scope is the file root.
    const { rels } = emit(MODULE_ONLY, new Map([['mod', [edge('src/b.ts', 'dynamic-resolved')]]]));
    expect(rels[0].reason).toBe('scope-resolution: import (deferred)');
  });

  it('an ordinary import inside a Function IS tagged — the Python shape', () => {
    // `def f(): from x import Y` is `kind: 'named'`; only its position defers it.
    const nodes = {
      mod: { kind: 'Module', parent: null },
      fn: { kind: 'Function', parent: 'mod' },
    };
    const { rels } = emit(nodes, new Map([['fn', [edge('src/b.ts')]]]));
    expect(rels[0].reason).toBe('scope-resolution: import (deferred)');
  });

  it('a Block nested inside a Function is tagged — the walk does not stop at the parent', () => {
    const nodes = {
      mod: { kind: 'Module', parent: null },
      fn: { kind: 'Function', parent: 'mod' },
      blk: { kind: 'Block', parent: 'fn' },
    };
    const { rels } = emit(nodes, new Map([['blk', [edge('src/b.ts')]]]));
    expect(rels[0].reason).toBe('scope-resolution: import (deferred)');
  });

  it('a top-level Block is NOT tagged — it runs during initialization', () => {
    // `if (FLAG) { require('./x'); }` at module top level is an init dependency.
    // Reading only the immediate scope kind would get this backwards.
    const nodes = {
      mod: { kind: 'Module', parent: null },
      blk: { kind: 'Block', parent: 'mod' },
    };
    const { rels } = emit(nodes, new Map([['blk', [edge('src/b.ts')]]]));
    expect(rels[0].reason).toBe('scope-resolution: import');
  });

  it('Class and Namespace bodies are NOT tagged — they execute where defined', () => {
    const nodes = {
      mod: { kind: 'Module', parent: null },
      ns: { kind: 'Namespace', parent: 'mod' },
      cls: { kind: 'Class', parent: 'ns' },
    };
    const { rels } = emit(
      nodes,
      new Map([
        ['ns', [edge('src/b.ts')]],
        ['cls', [edge('src/c.ts')]],
      ]),
    );
    expect(rels.map((r) => r.reason)).toEqual([
      'scope-resolution: import',
      'scope-resolution: import',
    ]);
  });

  it('STATIC WINS a mixed pair, whichever edge arrives first', () => {
    // One `await import()` beside a top-level import does not make the
    // dependency deferred. Dedup is per pair, so the tag must consider every
    // contributing edge rather than whichever one was seen first.
    const nodes = {
      mod: { kind: 'Module', parent: null },
      fn: { kind: 'Function', parent: 'mod' },
    };
    const deferredFirst = emit(
      nodes,
      new Map([
        ['fn', [edge('src/b.ts')]],
        ['mod', [edge('src/b.ts')]],
      ]),
    );
    const staticFirst = emit(
      nodes,
      new Map([
        ['mod', [edge('src/b.ts')]],
        ['fn', [edge('src/b.ts')]],
      ]),
    );
    expect(deferredFirst.count).toBe(1);
    expect(staticFirst.count).toBe(1);
    expect(deferredFirst.rels[0].reason).toBe('scope-resolution: import');
    expect(staticFirst.rels[0].reason).toBe('scope-resolution: import');
  });

  it('the suffix travels with a provider-overridden reason', () => {
    // `check --cycles` matches the SUFFIX, so a provider that renames the base
    // reason keeps its deferred edges filterable.
    const nodes = {
      mod: { kind: 'Module', parent: null },
      fn: { kind: 'Function', parent: 'mod' },
    };
    const { rels } = emit(nodes, new Map([['fn', [edge('src/b.ts')]]]), 'custom: import');
    expect(rels[0].reason).toBe(`custom: import${DEFERRED_IMPORT_REASON_SUFFIX}`);
  });

  it('emission order and dedup are unchanged — first-seen pair order', () => {
    const nodes = {
      mod: { kind: 'Module', parent: null },
      fn: { kind: 'Function', parent: 'mod' },
    };
    const { rels, count } = emit(
      nodes,
      new Map([
        ['mod', [edge('src/z.ts'), edge('src/b.ts'), edge('src/z.ts')]],
        ['fn', [edge('src/m.ts')]],
      ]),
    );
    expect(count).toBe(3);
    expect(rels.map((r) => r.targetId.split(':').pop())).toEqual([
      'src/z.ts',
      'src/b.ts',
      'src/m.ts',
    ]);
  });

  it('self-imports and unresolved targets are still skipped', () => {
    const { count } = emit(
      MODULE_ONLY,
      new Map([['mod', [edge('src/a.ts'), { ...edge('src/b.ts'), targetFile: null }]]]),
    );
    expect(count).toBe(0);
  });
});

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
 * Both spellings are covered here because neither signal catches both:
 * `import()` arrives as `kind: 'dynamic-resolved'`, while Python's
 * `def f(): from x import Y` is an ordinary import deferred only by WHERE it
 * sits — which reaches this function as `ImportEdge.runsOnlyWhenCalled`.
 *
 * **Both signals are read off the EDGE, and that is load-bearing.** An earlier
 * version of this file posed a scope tree with a `Function` scope, keyed a
 * bucket by it, and expected the emitter to walk up from that key. The emitter
 * did walk — and the walk could never fire in production, because
 * `finalize-algorithm.ts:295` publishes every file's edges as
 * `linkedByScope.set(file.moduleScope, …)`: the real map has one bucket per
 * FILE, keyed by that file's `Module` scope. `new Map([['fn', …]])` is a shape
 * the pipeline cannot produce, so the tests passed against dead code and
 * Python and Ruby function-local imports went on being counted as
 * initialization dependencies. The scope-kind case below now pins the opposite
 * claim — the tree is not consulted — and
 * `function-local-import-chain.test.ts` drives the real path end to end.
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

/** A plain value import of `targetFile`, running at initialization. */
function edge(targetFile: string, kind: ImportEdge['kind'] = 'named'): ImportEdge {
  return { localName: 'X', targetFile, targetExportedName: 'X', kind } as ImportEdge;
}

/** `import('./m')` — deferred by its KIND, wherever it was written. */
function dynamicEdge(targetFile: string): ImportEdge {
  return edge(targetFile, 'dynamic-resolved');
}

/**
 * `def f(): from x import Y` — an ordinary `named` import deferred by its
 * POSITION, which the extractor decided and put on the edge.
 */
function localEdge(targetFile: string, kind: ImportEdge['kind'] = 'named'): ImportEdge {
  return { ...edge(targetFile, kind), runsOnlyWhenCalled: true } as ImportEdge;
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

/** The shape finalize really produces: one bucket, keyed by the Module scope. */
const MODULE_ONLY = { mod: { kind: 'Module', parent: null } };

const PLAIN = 'scope-resolution: import';
const DEFERRED = `${PLAIN}${DEFERRED_IMPORT_REASON_SUFFIX}`;

describe('emitImportEdges — deferred tagging', () => {
  it('a module-level import is not tagged', () => {
    const { rels, count } = emit(MODULE_ONLY, new Map([['mod', [edge('src/b.ts')]]]));
    expect(count).toBe(1);
    expect(rels[0].reason).toBe(PLAIN);
  });

  it('a dynamic import() IS tagged — deferred by kind', () => {
    const { rels } = emit(MODULE_ONLY, new Map([['mod', [dynamicEdge('src/b.ts')]]]));
    expect(rels[0].reason).toBe(DEFERRED);
  });

  it('a function-local import IS tagged — the Python shape', () => {
    // `def f(): from x import Y` is `kind: 'named'` and sits in the module's
    // own bucket like every other import in the file. Only the flag the
    // extractor put on the edge says it runs later.
    const { rels } = emit(MODULE_ONLY, new Map([['mod', [localEdge('src/b.ts')]]]));
    expect(rels[0].reason).toBe(DEFERRED);
  });

  it('an edge is still EMITTED for a deferred pair', () => {
    // Only the reason changes. `impact` and `trace` must keep seeing the
    // dependency — a deferred import really does load the target.
    const { rels, count } = emit(MODULE_ONLY, new Map([['mod', [localEdge('src/b.ts')]]]));
    expect(count).toBe(1);
    expect(rels).toHaveLength(1);
    expect(rels[0].targetId).toBe('File:src/b.ts');
  });

  it('position is read off the edge for every kind that can carry it', () => {
    // A function-local import is an ordinary import of whatever kind its
    // syntax says, so nothing about `kind` may be used to infer position.
    const { rels } = emit(
      MODULE_ONLY,
      new Map([
        [
          'mod',
          [
            localEdge('src/named.ts', 'named'),
            localEdge('src/alias.ts', 'alias'),
            localEdge('src/ns.ts', 'namespace'),
            localEdge('src/reexport.ts', 'reexport'),
            localEdge('src/wild.ts', 'wildcard-expanded'),
            localEdge('src/side.ts', 'side-effect'),
          ],
        ],
      ]),
    );
    expect(rels.map((r) => r.reason)).toEqual([
      DEFERRED,
      DEFERRED,
      DEFERRED,
      DEFERRED,
      DEFERRED,
      DEFERRED,
    ]);
  });
});

describe('emitImportEdges — the scope tree is not consulted for position', () => {
  it('a Function-keyed bucket without the flag is NOT tagged', () => {
    // The regression this file exists for. The bucket key is a `Function`
    // scope and the walk would have found it, but the map finalize builds is
    // keyed by `file.moduleScope` and never by anything else, so a walk from
    // the key answers `false` for every real import. Position now arrives on
    // the edge, and a scope kind alone must not stand in for it.
    const nodes = {
      mod: { kind: 'Module', parent: null },
      fn: { kind: 'Function', parent: 'mod' },
    };
    const { rels } = emit(nodes, new Map([['fn', [edge('src/b.ts')]]]));
    expect(rels[0].reason).toBe(PLAIN);
  });

  it('a Block nested under a Function key is NOT tagged either', () => {
    const nodes = {
      mod: { kind: 'Module', parent: null },
      fn: { kind: 'Function', parent: 'mod' },
      blk: { kind: 'Block', parent: 'fn' },
    };
    const { rels } = emit(nodes, new Map([['blk', [edge('src/b.ts')]]]));
    expect(rels[0].reason).toBe(PLAIN);
  });

  it('the flag tags the pair whatever kind the bucket key is', () => {
    // The mirror of the two cases above: the verdict follows the edge, so
    // posing a `Module`, a `Class` or a `Namespace` key changes nothing.
    const nodes = {
      mod: { kind: 'Module', parent: null },
      ns: { kind: 'Namespace', parent: 'mod' },
      cls: { kind: 'Class', parent: 'ns' },
    };
    const { rels } = emit(
      nodes,
      new Map([
        ['ns', [localEdge('src/b.ts')]],
        ['cls', [localEdge('src/c.ts')]],
      ]),
    );
    expect(rels.map((r) => r.reason)).toEqual([DEFERRED, DEFERRED]);
  });
});

describe('emitImportEdges — mixed-pair precedence', () => {
  it('an initializing import beats a dynamic import(), whichever arrives first', () => {
    // One `await import('./b')` beside a top-level `import { f } from './b'`
    // does not make the dependency deferred. Dedup is per pair, so the tag
    // must consider every contributing edge rather than whichever one was
    // seen first — tagging from the first would HIDE a true cycle.
    const deferredFirst = emit(
      MODULE_ONLY,
      new Map([['mod', [dynamicEdge('src/b.ts'), edge('src/b.ts')]]]),
    );
    const staticFirst = emit(
      MODULE_ONLY,
      new Map([['mod', [edge('src/b.ts'), dynamicEdge('src/b.ts')]]]),
    );
    expect(deferredFirst.count).toBe(1);
    expect(staticFirst.count).toBe(1);
    expect(deferredFirst.rels[0].reason).toBe(PLAIN);
    expect(staticFirst.rels[0].reason).toBe(PLAIN);
  });

  it('an initializing import beats a function-local one, whichever arrives first', () => {
    // The same rule for the other deferral source. Covered separately because
    // the two are independent signals now: `kind` says nothing about position
    // and position says nothing about `kind`, so a fixture built from one of
    // them does not exercise the other.
    const deferredFirst = emit(
      MODULE_ONLY,
      new Map([['mod', [localEdge('src/b.ts'), edge('src/b.ts')]]]),
    );
    const staticFirst = emit(
      MODULE_ONLY,
      new Map([['mod', [edge('src/b.ts'), localEdge('src/b.ts')]]]),
    );
    expect(deferredFirst.count).toBe(1);
    expect(staticFirst.count).toBe(1);
    expect(deferredFirst.rels[0].reason).toBe(PLAIN);
    expect(staticFirst.rels[0].reason).toBe(PLAIN);
  });

  it('an initializing import beats both deferral sources at once', () => {
    const { rels, count } = emit(
      MODULE_ONLY,
      new Map([['mod', [dynamicEdge('src/b.ts'), localEdge('src/b.ts'), edge('src/b.ts')]]]),
    );
    expect(count).toBe(1);
    expect(rels[0].reason).toBe(PLAIN);
  });

  it('the two deferral sources rank the same — a pair of them stays deferred', () => {
    // `import()` and a function-local import make the same claim about the
    // emitted program: it loads, later. Neither outranks the other.
    const { rels, count } = emit(
      MODULE_ONLY,
      new Map([['mod', [dynamicEdge('src/b.ts'), localEdge('src/b.ts')]]]),
    );
    expect(count).toBe(1);
    expect(rels[0].reason).toBe(DEFERRED);
  });

  it('separate pairs keep separate verdicts', () => {
    const { rels, count } = emit(
      MODULE_ONLY,
      new Map([
        ['mod', [edge('src/value.ts'), dynamicEdge('src/dyn.ts'), localEdge('src/local.ts')]],
      ]),
    );
    expect(count).toBe(3);
    expect(rels.map((r) => [r.targetId, r.reason])).toEqual([
      ['File:src/value.ts', PLAIN],
      ['File:src/dyn.ts', DEFERRED],
      ['File:src/local.ts', DEFERRED],
    ]);
  });
});

describe('emitImportEdges — reason, order and skips', () => {
  it('the suffix travels with a provider-overridden reason, from either source', () => {
    // `check --cycles` matches the SUFFIX, so a provider that renames the base
    // reason keeps its deferred edges filterable.
    const local = emit(MODULE_ONLY, new Map([['mod', [localEdge('src/b.ts')]]]), 'custom: import');
    const dynamic = emit(
      MODULE_ONLY,
      new Map([['mod', [dynamicEdge('src/b.ts')]]]),
      'custom: import',
    );
    expect(local.rels[0].reason).toBe(`custom: import${DEFERRED_IMPORT_REASON_SUFFIX}`);
    expect(dynamic.rels[0].reason).toBe(`custom: import${DEFERRED_IMPORT_REASON_SUFFIX}`);
  });

  it('emission order and dedup are unchanged — first-seen pair order', () => {
    const { rels, count } = emit(
      MODULE_ONLY,
      new Map([
        ['mod', [edge('src/z.ts'), edge('src/b.ts'), edge('src/z.ts'), localEdge('src/m.ts')]],
      ]),
    );
    expect(count).toBe(3);
    expect(rels.map((r) => r.targetId)).toEqual([
      'File:src/z.ts',
      'File:src/b.ts',
      'File:src/m.ts',
    ]);
  });

  it('self-imports and unresolved targets are still skipped', () => {
    const { count } = emit(
      MODULE_ONLY,
      new Map([['mod', [localEdge('src/a.ts'), { ...edge('src/b.ts'), targetFile: null }]]]),
    );
    expect(count).toBe(0);
  });
});

/**
 * `emitImportEdges` — type-only tagging, and its precedence against deferred.
 *
 * Sibling of `imports-to-edges-deferred.test.ts`, which owns the deferred half.
 * Split rather than merged because the two facts are opposite: a deferred
 * import EXISTS at run time and merely runs later, a type-only import is
 * deleted by `tsc` and never runs at all. `check --cycles` drops both, so the
 * only place the graph records which one a pair is, is the `reason` suffix.
 *
 * The pair is what carries a suffix, and a pair can be reached by several
 * imports at once. The rule is the strongest runtime presence wins —
 * initializing > deferred > erased — and the interesting cases are all mixed
 * pairs, so they are what this file is mostly made of.
 *
 * The scope tree is posed directly rather than coaxed out of a language, the
 * same choice `graph-bridge-label-split.test.ts` makes for the same reason.
 */
import { describe, expect, it } from 'vitest';
import type { ImportEdge, Scope, ScopeId } from 'gitnexus-shared';
import {
  DEFERRED_IMPORT_REASON_SUFFIX,
  TYPE_ONLY_IMPORT_REASON_SUFFIX,
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

/** A plain value import of `targetFile`. */
function edge(targetFile: string, kind: ImportEdge['kind'] = 'named'): ImportEdge {
  return { localName: 'X', targetFile, targetExportedName: 'X', kind } as ImportEdge;
}

/** The `import type { X } from targetFile` form of {@link edge}. */
function typeEdge(targetFile: string, kind: ImportEdge['kind'] = 'named'): ImportEdge {
  return { ...edge(targetFile, kind), typeOnly: true } as ImportEdge;
}

/**
 * The `def f(): from x import Y` form of {@link edge} — deferred by POSITION.
 *
 * Set on the edge, not implied by the bucket's scope: finalize keys every
 * file's edges by `file.moduleScope`, so the scope tree cannot answer where an
 * import was written. See `imports-to-edges-deferred.test.ts` for the full note.
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
const TYPE_ONLY = `${PLAIN}${TYPE_ONLY_IMPORT_REASON_SUFFIX}`;

describe('emitImportEdges — type-only tagging', () => {
  it('the two suffixes are distinct strings', () => {
    // They are matched separately by the `check --cycles` query, and the whole
    // point of the second one is that it is not the first.
    expect(TYPE_ONLY_IMPORT_REASON_SUFFIX).not.toBe(DEFERRED_IMPORT_REASON_SUFFIX);
  });

  it('an edge is still EMITTED for a type-only pair', () => {
    // Only the reason changes. `impact` and `trace` must keep seeing the
    // dependency — editing the target still breaks the importer's typecheck.
    const { rels, count } = emit(MODULE_ONLY, new Map([['mod', [typeEdge('src/b.ts')]]]));
    expect(count).toBe(1);
    expect(rels).toHaveLength(1);
    expect(rels[0].targetId).toBe('File:src/b.ts');
  });

  it('a type-only import IS tagged', () => {
    const { rels } = emit(MODULE_ONLY, new Map([['mod', [typeEdge('src/b.ts')]]]));
    expect(rels[0].reason).toBe(TYPE_ONLY);
  });

  it('tagging is by the flag, not by the kind — every kind that carries it', () => {
    // `import type` produces the same kinds a value import does, so nothing
    // about `kind` may be used to infer erasure.
    const { rels } = emit(
      MODULE_ONLY,
      new Map([
        [
          'mod',
          [
            typeEdge('src/named.ts', 'named'),
            typeEdge('src/alias.ts', 'alias'),
            typeEdge('src/ns.ts', 'namespace'),
            typeEdge('src/reexport.ts', 'reexport'),
          ],
        ],
      ]),
    );
    expect(rels.map((r) => r.reason)).toEqual([TYPE_ONLY, TYPE_ONLY, TYPE_ONLY, TYPE_ONLY]);
  });

  it('a value import is untouched by the new branch', () => {
    const { rels } = emit(MODULE_ONLY, new Map([['mod', [edge('src/b.ts')]]]));
    expect(rels[0].reason).toBe(PLAIN);
  });

  it('the suffix travels with a provider-overridden reason', () => {
    // Real indexes never use the default: each provider passes its own base
    // reason (`typescript-scope: import`), and the check query matches the
    // SUFFIX so those stay filterable.
    const { rels } = emit(
      MODULE_ONLY,
      new Map([['mod', [typeEdge('src/b.ts')]]]),
      'custom: import',
    );
    expect(rels[0].reason).toBe(`custom: import${TYPE_ONLY_IMPORT_REASON_SUFFIX}`);
  });
});

describe('emitImportEdges — mixed-pair precedence', () => {
  it('a VALUE import wins over a type-only one, whichever arrives first', () => {
    // `import { f } from './b'` beside `import type { T } from './b'` is a
    // real initialization dependency. Tagging from whichever edge arrived
    // first would HIDE a true cycle, which is the one failure mode that
    // matters here.
    const typeFirst = emit(
      MODULE_ONLY,
      new Map([['mod', [typeEdge('src/b.ts'), edge('src/b.ts')]]]),
    );
    const valueFirst = emit(
      MODULE_ONLY,
      new Map([['mod', [edge('src/b.ts'), typeEdge('src/b.ts')]]]),
    );
    expect(typeFirst.count).toBe(1);
    expect(valueFirst.count).toBe(1);
    expect(typeFirst.rels[0].reason).toBe(PLAIN);
    expect(valueFirst.rels[0].reason).toBe(PLAIN);
  });

  it('DEFERRED wins over type-only — the module really does load, just later', () => {
    // `(type-only)` would claim the target never loads. It does. Both
    // deferral sources are checked, since either alone would leave the other
    // untested: `kind` and position are independent signals.
    const localFirst = emit(
      MODULE_ONLY,
      new Map([['mod', [localEdge('src/b.ts'), typeEdge('src/b.ts')]]]),
    );
    const typeFirst = emit(
      MODULE_ONLY,
      new Map([['mod', [typeEdge('src/b.ts'), localEdge('src/b.ts')]]]),
    );
    const dynamicFirst = emit(
      MODULE_ONLY,
      new Map([['mod', [edge('src/b.ts', 'dynamic-resolved'), typeEdge('src/b.ts')]]]),
    );
    expect(localFirst.rels[0].reason).toBe(DEFERRED);
    expect(typeFirst.rels[0].reason).toBe(DEFERRED);
    expect(dynamicFirst.rels[0].reason).toBe(DEFERRED);
  });

  it('a value import wins over BOTH', () => {
    const { rels, count } = emit(
      MODULE_ONLY,
      new Map([['mod', [typeEdge('src/b.ts'), edge('src/b.ts'), localEdge('src/b.ts')]]]),
    );
    expect(count).toBe(1);
    expect(rels[0].reason).toBe(PLAIN);
  });

  it('a type-only import inside a function is ERASED, not deferred', () => {
    // Both signals ride the same edge. Erasure is the stronger claim — the
    // import is gone from the output, not merely postponed — so it wins.
    const { rels } = emit(
      MODULE_ONLY,
      new Map([['mod', [{ ...typeEdge('src/b.ts'), runsOnlyWhenCalled: true }]]]),
    );
    expect(rels[0].reason).toBe(TYPE_ONLY);
  });

  it('a dynamic-resolved edge that is also flagged type-only reads as erased', () => {
    const { rels } = emit(
      MODULE_ONLY,
      new Map([['mod', [typeEdge('src/b.ts', 'dynamic-resolved')]]]),
    );
    expect(rels[0].reason).toBe(TYPE_ONLY);
  });

  it('separate pairs keep separate verdicts', () => {
    const { rels, count } = emit(
      MODULE_ONLY,
      new Map([
        ['mod', [edge('src/value.ts'), typeEdge('src/type.ts'), localEdge('src/deferred.ts')]],
      ]),
    );
    expect(count).toBe(3);
    expect(rels.map((r) => [r.targetId, r.reason])).toEqual([
      ['File:src/value.ts', PLAIN],
      ['File:src/type.ts', TYPE_ONLY],
      ['File:src/deferred.ts', DEFERRED],
    ]);
  });

  it('emission order and dedup are unchanged — first-seen pair order', () => {
    const { rels, count } = emit(
      MODULE_ONLY,
      new Map([
        [
          'mod',
          [typeEdge('src/z.ts'), edge('src/b.ts'), typeEdge('src/z.ts'), typeEdge('src/m.ts')],
        ],
      ]),
    );
    expect(count).toBe(3);
    expect(rels.map((r) => r.targetId)).toEqual([
      'File:src/z.ts',
      'File:src/b.ts',
      'File:src/m.ts',
    ]);
  });

  it('a type-only self-import is still skipped', () => {
    const { count } = emit(MODULE_ONLY, new Map([['mod', [typeEdge('src/a.ts')]]]));
    expect(count).toBe(0);
  });
});

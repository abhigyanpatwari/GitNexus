/**
 * #2693 — `buildGraphTargetIndex` admits a VALUE binding as a call target only
 * on POSITIONAL evidence: the callable graph node at the binding's own file,
 * line and name.
 *
 * The first cut of #2693 admitted a value binding whose *resolved* node was
 * callable, which let `resolveDefGraphId` fall through to its label-agnostic,
 * first-write-wins `simpleKey(filePath, simpleName)` and alias the binding onto
 * ANY same-named callable in the file — a fabricated caller, chosen by
 * declaration order. These tests pin the property that replaced it, at the unit
 * level where the integration suite cannot isolate it.
 */
import { describe, expect, it } from 'vitest';
import type { KnowledgeGraph } from '../../../src/core/graph/types.js';
import type { ScopeResolutionIndexes } from '../../../src/core/ingestion/model/scope-resolution-indexes.js';
import type { GraphNodeLookup } from '../../../src/core/ingestion/scope-resolution/graph-bridge/node-lookup.js';
import { buildGraphTargetIndex } from '../../../src/core/ingestion/scope-resolution/passes/callable-value-flow.js';

interface StubNode {
  readonly id: string;
  readonly label: string;
  readonly properties: { filePath: string; name: string; startLine: number };
}

/** Minimal graph — `buildGraphTargetIndex` reads only `iterNodes`/`getNode`. */
const graphOf = (nodes: readonly StubNode[]): KnowledgeGraph => {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  return {
    iterNodes: () => nodes[Symbol.iterator](),
    getNode: (id: string) => byId.get(id),
  } as unknown as KnowledgeGraph;
};

/** `line` is 1-based, matching the definition-id convention. */
const def = (type: string, filePath: string, qualifiedName: string, line: number) => ({
  nodeId: `${filePath}#${line}:0:${qualifiedName}`,
  type,
  filePath,
  qualifiedName,
});

const scopesOf = (defs: readonly ReturnType<typeof def>[]): ScopeResolutionIndexes =>
  ({
    defs: { byId: new Map(defs.map((d) => [d.nodeId, d])) },
  }) as unknown as ScopeResolutionIndexes;

/** Graph nodes store a 0-BASED startLine; defs are 1-based. */
const node = (label: string, filePath: string, name: string, line: number): StubNode => ({
  id: `${label}:${filePath}:${name}`,
  label,
  properties: { filePath, name, startLine: line - 1 },
});

const targetsFor = (nodes: readonly StubNode[], defs: readonly ReturnType<typeof def>[]) =>
  [
    ...buildGraphTargetIndex(
      scopesOf(defs),
      new Map() as GraphNodeLookup,
      undefined,
      graphOf(nodes),
    ),
  ]
    .map(([defId, target]) => `${defId} => ${target.id}`)
    .sort();

describe('buildGraphTargetIndex — value bindings join by position', () => {
  it('admits a value binding whose callable node sits at its own line', () => {
    // The #2687 closure-binding shape: the value def and the Function node are
    // the same construct, so they share file, line and name.
    expect(
      targetsFor([node('Function', 'a.kt', 'handler', 3)], [def('Property', 'a.kt', 'handler', 3)]),
    ).toEqual(['a.kt#3:0:handler => Function:a.kt:handler']);
  });

  it('REJECTS a value binding that merely shares a name with a callable elsewhere', () => {
    // `const save = …` on line 7 beside an unrelated `save` callable on line 2.
    // A name-only match admitted this and minted a fabricated caller.
    expect(
      targetsFor([node('Function', 'a.ts', 'save', 2)], [def('Variable', 'a.ts', 'save', 7)]),
    ).toEqual([]);
  });

  it('REJECTS a value binding whose node at that position is NOT callable', () => {
    expect(
      targetsFor([node('Const', 'a.ts', 'CONFIG', 4)], [def('Const', 'a.ts', 'CONFIG', 4)]),
    ).toEqual([]);
  });

  it('REJECTS an ambiguous position claimed by two callables', () => {
    // Admitting either would be an arbitrary, order-dependent choice.
    expect(
      targetsFor(
        [node('Function', 'a.ts', 'dup', 5), node('Method', 'a.ts', 'dup', 5)],
        [def('Variable', 'a.ts', 'dup', 5)],
      ),
    ).toEqual([]);
  });

  it('normalises the PHP dollar sigil across the join', () => {
    // The PHP node keeps the sigil so `$save` cannot collide with the function
    // `save()` — PHP holds the two in separate namespaces — while the scope
    // declaration drops it. The join must still match them, and must NOT match
    // the same-named function on another line.
    expect(
      targetsFor(
        [node('Function', 'a.php', '$save', 5), node('Function', 'a.php', 'save', 2)],
        [def('Variable', 'a.php', 'save', 5)],
      ),
    ).toEqual(['a.php#5:0:save => Function:a.php:$save']);
  });

  it('keeps ordinary callable defs, which never take the positional path', () => {
    expect(
      targetsFor([node('Function', 'a.ts', 'fn', 1)], [def('Function', 'a.ts', 'fn', 1)]),
    ).toEqual(['a.ts#1:0:fn => Function:a.ts:fn']);
  });
});

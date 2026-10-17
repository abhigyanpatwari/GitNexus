/**
 * `rMergeBindings` orders the bindings of one tier by node id. The order must be the same on every
 * machine, so it compares code units, not `localeCompare`, which follows the locale: in an
 * English collation `a` sorts before `B` and `é` before `f`; by code unit `B` and `f` come first.
 */
import { describe, expect, it } from 'vitest';
import type { BindingRef, SymbolDefinition } from 'gitnexus-shared';
import { rMergeBindings } from '../../../../src/core/ingestion/languages/r/simple-hooks.js';

const local = (nodeId: string): BindingRef => ({
  origin: 'local',
  def: { nodeId } as SymbolDefinition,
});

const order = (...ids: string[]): string[] =>
  rMergeBindings(ids.map(local), [], 'scope:test').map((b) => b.def.nodeId);

describe('rMergeBindings', () => {
  it('orders same-tier bindings by code unit', () => {
    expect(order('Function:a.R:a', 'Function:a.R:B')).toEqual(['Function:a.R:B', 'Function:a.R:a']);
    expect(order('Function:a.R:é', 'Function:a.R:f')).toEqual(['Function:a.R:f', 'Function:a.R:é']);
  });

  it('gives the same order whichever way round the bindings arrive', () => {
    expect(order('Function:a.R:B', 'Function:a.R:a')).toEqual(['Function:a.R:B', 'Function:a.R:a']);
  });

  it('keeps one binding per node and prefers the tightest tier', () => {
    const merged = rMergeBindings(
      [local('Function:a.R:x'), { origin: 'import', def: { nodeId: 'Function:b.R:x' } as never }],
      [local('Function:a.R:x')],
      'scope:test',
    );
    expect(merged.map((b) => b.def.nodeId)).toEqual(['Function:a.R:x']);
  });
});

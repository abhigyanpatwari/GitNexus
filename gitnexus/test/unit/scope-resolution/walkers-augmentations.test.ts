/**
 * Unit coverage for `lookupBindingsAt` — the dual-source binding
 * lookup primitive used by every walker that needs cross-file
 * visibility (Step 2 of the binding-augmentation-channel refactor).
 *
 * These tests pin the contract exhaustively: precedence (finalized
 * first), dedup (by `def.nodeId`), empty-array semantics, and the
 * shared-empty-frozen-array identity for misses. Every other walker
 * test in this directory delegates to `lookupBindingsAt` after the
 * refactor, so a regression here surfaces quickly.
 */

import { describe, it, expect } from 'vitest';
import { lookupBindingsAt } from '../../../src/core/ingestion/scope-resolution/scope/walkers.js';
import type { BindingRef, ScopeId, SymbolDefinition } from 'gitnexus-shared';
import type { ScopeResolutionIndexes } from '../../../src/core/ingestion/model/scope-resolution-indexes.js';

const SCOPE = 'scope:m' as ScopeId;

const def = (nodeId: string): SymbolDefinition =>
  ({ nodeId, filePath: 'm.ts', type: 'Function' }) as SymbolDefinition;

const ref = (nodeId: string, origin: BindingRef['origin'] = 'local'): BindingRef =>
  ({ def: def(nodeId), origin }) as BindingRef;

function indexesWith({
  finalized,
  augmented,
}: {
  finalized?: readonly BindingRef[];
  augmented?: readonly BindingRef[];
}): ScopeResolutionIndexes {
  const bindings = new Map<ScopeId, Map<string, readonly BindingRef[]>>();
  if (finalized !== undefined) bindings.set(SCOPE, new Map([['name', finalized]]));
  const bindingAugmentations = new Map<ScopeId, Map<string, readonly BindingRef[]>>();
  if (augmented !== undefined) bindingAugmentations.set(SCOPE, new Map([['name', augmented]]));
  return { bindings, bindingAugmentations } as unknown as ScopeResolutionIndexes;
}

describe('lookupBindingsAt', () => {
  it('returns the finalized bucket when augmentations are absent', () => {
    const finalized = [ref('A'), ref('B')];
    const out = lookupBindingsAt(SCOPE, 'name', indexesWith({ finalized }));
    expect(out).toEqual(finalized);
    // Identity preserved when only one channel populates — no allocation.
    expect(out).toBe(finalized);
  });

  it('returns the augmented bucket when finalized is absent', () => {
    const augmented = [ref('X', 'namespace')];
    const out = lookupBindingsAt(SCOPE, 'name', indexesWith({ augmented }));
    expect(out).toEqual(augmented);
    expect(out).toBe(augmented);
  });

  it('concatenates with finalized first when both populate disjoint nodeIds', () => {
    const finalized = [ref('A', 'import'), ref('B', 'import')];
    const augmented = [ref('C', 'namespace'), ref('D', 'namespace')];
    const out = lookupBindingsAt(SCOPE, 'name', indexesWith({ finalized, augmented }));
    expect(out.map((b) => b.def.nodeId)).toEqual(['A', 'B', 'C', 'D']);
  });

  it('dedupes augmented entries that share a nodeId with finalized (finalized wins)', () => {
    const finalized = [ref('A', 'import'), ref('B', 'import')];
    const augmented = [ref('A', 'namespace'), ref('C', 'namespace')];
    const out = lookupBindingsAt(SCOPE, 'name', indexesWith({ finalized, augmented }));
    expect(out.map((b) => b.def.nodeId)).toEqual(['A', 'B', 'C']);
    expect(out.find((b) => b.def.nodeId === 'A')!.origin).toBe('import');
  });

  it('returns the shared empty array on a miss in both channels', () => {
    const a = lookupBindingsAt(SCOPE, 'name', indexesWith({}));
    const b = lookupBindingsAt(SCOPE, 'other', indexesWith({}));
    expect(a).toEqual([]);
    expect(b).toEqual([]);
    expect(a).toBe(b);
    expect(Object.isFrozen(a)).toBe(true);
  });

  it('treats an empty finalized bucket as absent (returns augmented)', () => {
    const augmented = [ref('Z', 'namespace')];
    const out = lookupBindingsAt(SCOPE, 'name', indexesWith({ finalized: [], augmented }));
    expect(out).toBe(augmented);
  });

  it('treats an empty augmented bucket as absent (returns finalized)', () => {
    const finalized = [ref('Z', 'import')];
    const out = lookupBindingsAt(SCOPE, 'name', indexesWith({ finalized, augmented: [] }));
    expect(out).toBe(finalized);
  });

  it('returns the shared empty array when both buckets exist but are empty', () => {
    const out = lookupBindingsAt(SCOPE, 'name', indexesWith({ finalized: [], augmented: [] }));
    expect(out).toEqual([]);
    expect(Object.isFrozen(out)).toBe(true);
  });
});

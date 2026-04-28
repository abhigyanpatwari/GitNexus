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
import {
  findCallableBindingInScope,
  findClassBindingInScope,
  findExportedDefByName,
  lookupBindingsAt,
} from '../../../src/core/ingestion/scope-resolution/scope/walkers.js';
import type { BindingRef, Scope, ScopeId, ScopeTree, SymbolDefinition } from 'gitnexus-shared';
import type { ScopeResolutionIndexes } from '../../../src/core/ingestion/model/scope-resolution-indexes.js';
import type { WorkspaceResolutionIndex } from '../../../src/core/ingestion/scope-resolution/workspace-index.js';

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
  if (finalized !== undefined) {
    Object.freeze(finalized as BindingRef[]);
    bindings.set(SCOPE, new Map([['name', finalized]]));
  }
  const bindingAugmentations = new Map<ScopeId, Map<string, readonly BindingRef[]>>();
  if (augmented !== undefined) bindingAugmentations.set(SCOPE, new Map([['name', augmented]]));
  return { bindings, bindingAugmentations } as unknown as ScopeResolutionIndexes;
}

function scope(id: ScopeId, bindings = new Map<string, readonly BindingRef[]>()): Scope {
  return {
    id,
    kind: 'Module',
    parent: null,
    filePath: 'm.ts',
    range: { startLine: 1, startColumn: 0, endLine: 1, endColumn: 0 },
    bindings,
    imports: [],
    ownedDefs: [],
    typeBindings: new Map(),
  } as unknown as Scope;
}

function indexesForScopeLookup(
  moduleScope: Scope,
  augmented: Map<string, readonly BindingRef[]>,
): ScopeResolutionIndexes {
  const scopeTree = {
    getScope: (id: ScopeId) => (id === moduleScope.id ? moduleScope : undefined),
  } as unknown as ScopeTree;
  return {
    scopeTree,
    bindings: new Map(),
    bindingAugmentations: new Map([[moduleScope.id, augmented]]),
  } as unknown as ScopeResolutionIndexes;
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

  it('keeps finalized metadata when the same nodeId appears in both channels', () => {
    const finalizedDef = {
      nodeId: 'A',
      filePath: 'finalized.ts',
      qualifiedName: 'finalized.A',
      type: 'Function',
    } as SymbolDefinition;
    const augmentedDef = {
      nodeId: 'A',
      filePath: 'augmented.ts',
      qualifiedName: 'augmented.A',
      type: 'Method',
    } as SymbolDefinition;
    const out = lookupBindingsAt(
      SCOPE,
      'name',
      indexesWith({
        finalized: [{ def: finalizedDef, origin: 'import' } as BindingRef],
        augmented: [{ def: augmentedDef, origin: 'namespace' } as BindingRef],
      }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.def.filePath).toBe('finalized.ts');
    expect(out[0]!.def.qualifiedName).toBe('finalized.A');
    expect(out[0]!.origin).toBe('import');
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

describe('walker helpers read bindingAugmentations', () => {
  it('findClassBindingInScope finds class-like refs that exist only in augmentations', () => {
    const moduleScope = scope(SCOPE);
    const classRef = {
      def: { ...def('ClassA'), type: 'Class' },
      origin: 'namespace',
    } as BindingRef;
    const indexes = indexesForScopeLookup(moduleScope, new Map([['ClassA', [classRef]]]));

    expect(findClassBindingInScope(SCOPE, 'ClassA', indexes)?.nodeId).toBe('ClassA');
  });

  it('findCallableBindingInScope finds callable refs that exist only in augmentations', () => {
    const moduleScope = scope(SCOPE);
    const callableRef = { def: def('callMe'), origin: 'import' } as BindingRef;
    const indexes = indexesForScopeLookup(moduleScope, new Map([['callMe', [callableRef]]]));

    expect(findCallableBindingInScope(SCOPE, 'callMe', indexes)?.nodeId).toBe('callMe');
  });

  it('findExportedDefByName finds callable refs that exist only in augmentations', () => {
    const moduleScope = scope(SCOPE);
    const callableRef = { def: def('fromAugmentation'), origin: 'import' } as BindingRef;
    const indexes = indexesForScopeLookup(moduleScope, new Map([['run', [callableRef]]]));
    const workspaceIndex = {
      moduleScopeByFile: new Map(),
    } as unknown as WorkspaceResolutionIndex;

    expect(findExportedDefByName('run', SCOPE, indexes, workspaceIndex)?.nodeId).toBe(
      'fromAugmentation',
    );
  });
});

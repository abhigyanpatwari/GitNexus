/**
 * Unit coverage for `resolveAmbiguousInheritanceBaseViaImports` (#1956 tri-review
 * U8). The import-aware disambiguation fallback for an ambiguous (≥2 same-named
 * class-like) inheritance base. It only commits when EXACTLY ONE candidate
 * survives a tier, otherwise preserves the historical "return undefined" refusal:
 *
 *   - guard:  fewer than 2 class-like candidates  → undefined (not this fallback's job)
 *   - guard:  no import edges on the module scope  → undefined (refuse)
 *   - Tier 1: exactly one candidate file is imported exactly  → resolve
 *   - Tier 1: more than one imported exactly        → undefined (refuse)
 *   - Tier 2: exactly one candidate shares a dir with an import target → resolve
 *   - Tier 2: more than one shares a dir            → undefined (refuse)
 *
 * Drives the function directly through a minimal cast `ScopeResolutionIndexes`
 * (only the accessors it reads — qualifiedNames/defs/scopeTree/imports), so the
 * branch behavior is pinned independent of the full finalize pipeline.
 */
import { describe, it, expect } from 'vitest';
import { resolveAmbiguousInheritanceBaseViaImports } from '../../../src/core/ingestion/scope-resolution/scope/walkers.js';
import type { ImportEdge, Scope, ScopeId, SymbolDefinition } from 'gitnexus-shared';
import type { ScopeResolutionIndexes } from '../../../src/core/ingestion/model/scope-resolution-indexes.js';

const MODULE = 'scope:module' as ScopeId;
const BASE = 'Handler';

interface Candidate {
  nodeId: string;
  filePath: string;
  type?: string; // class-like; defaults to 'Class'
}

/** Build a minimal indexes object whose module scope imports `importTargetFiles`
 *  and whose `qualifiedNames` maps BASE → the given class-like candidates. */
function buildIndexes(
  candidates: Candidate[],
  importTargetFiles: string[],
): ScopeResolutionIndexes {
  const defsMap = new Map<string, SymbolDefinition>();
  const ids: string[] = [];
  for (const c of candidates) {
    defsMap.set(c.nodeId, {
      nodeId: c.nodeId,
      filePath: c.filePath,
      type: c.type ?? 'Class',
    } as SymbolDefinition);
    ids.push(c.nodeId);
  }
  const moduleScope = {
    id: MODULE,
    kind: 'Module',
    parent: null,
    filePath: 'ref.ts',
  } as unknown as Scope;
  const importEdges = importTargetFiles.map((f) => ({ targetFile: f }) as unknown as ImportEdge);
  return {
    qualifiedNames: { get: (n: string) => (n === BASE ? ids : []) },
    defs: { get: (id: string) => defsMap.get(id) },
    scopeTree: { getScope: (id: ScopeId) => (id === MODULE ? moduleScope : undefined) },
    imports: new Map<ScopeId, readonly ImportEdge[]>([[MODULE, importEdges]]),
  } as unknown as ScopeResolutionIndexes;
}

function resolve(candidates: Candidate[], importTargetFiles: string[]): string | undefined {
  const def = resolveAmbiguousInheritanceBaseViaImports(
    MODULE,
    BASE,
    buildIndexes(candidates, importTargetFiles),
  );
  return def?.nodeId;
}

describe('resolveAmbiguousInheritanceBaseViaImports (#1956 U8)', () => {
  it('refuses (undefined) when there is only a single candidate (not ambiguous)', () => {
    expect(
      resolve([{ nodeId: 'd:models', filePath: 'Models/Handler.ts' }], ['Models/Handler.ts']),
    ).toBeUndefined();
  });

  it('refuses (undefined) when the module scope has no import edges', () => {
    expect(
      resolve(
        [
          { nodeId: 'd:models', filePath: 'Models/Handler.ts' },
          { nodeId: 'd:other', filePath: 'Other/Handler.ts' },
        ],
        [],
      ),
    ).toBeUndefined();
  });

  it('Tier 1: resolves to the single candidate whose file is imported exactly', () => {
    expect(
      resolve(
        [
          { nodeId: 'd:models', filePath: 'Models/Handler.ts' },
          { nodeId: 'd:other', filePath: 'Other/Handler.ts' },
        ],
        ['Models/Handler.ts'],
      ),
    ).toBe('d:models');
  });

  it('Tier 1: refuses when more than one candidate file is imported exactly', () => {
    expect(
      resolve(
        [
          { nodeId: 'd:models', filePath: 'Models/Handler.ts' },
          { nodeId: 'd:other', filePath: 'Other/Handler.ts' },
        ],
        ['Models/Handler.ts', 'Other/Handler.ts'],
      ),
    ).toBeUndefined();
  });

  it('Tier 2: resolves to the single candidate sharing a directory with an import target', () => {
    // No exact file match (import target is a different file in Models/), so it
    // falls to the same-directory tier — only Models/Handler.ts shares a dir.
    expect(
      resolve(
        [
          { nodeId: 'd:models', filePath: 'Models/Handler.ts' },
          { nodeId: 'd:other', filePath: 'Other/Handler.ts' },
        ],
        ['Models/IProcessor.ts'],
      ),
    ).toBe('d:models');
  });

  it('Tier 2: refuses when more than one candidate shares a directory with an import target', () => {
    // Two same-named candidates in the same directory; the import target is a
    // third file in that directory (no exact match) — still ambiguous, refuse.
    expect(
      resolve(
        [
          { nodeId: 'd:a', filePath: 'Models/HandlerA.ts' },
          { nodeId: 'd:b', filePath: 'Models/HandlerB.ts' },
        ],
        ['Models/Registry.ts'],
      ),
    ).toBeUndefined();
  });
});

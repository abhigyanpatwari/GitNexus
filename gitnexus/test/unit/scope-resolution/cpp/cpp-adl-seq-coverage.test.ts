/**
 * Unit tests for the C++ ADL seq-coverage invariant guard.
 *
 * `pickCppAdlCandidates` sorts merged candidates by `seqByNodeId`, falling back
 * to `?? 0` if a bucketed def has no seq. That fallback is provably unreachable
 * (every def pushed into `nsCandidates`/`friendCandidates` is seq-assigned in the
 * same build block), but a future regression could break the invariant and
 * silently collapse two seq-0 candidates into one. `validateAdlSeqCoverage`
 * detects that break; `buildAdlIndex` runs it under the dev/test validation gate
 * so a regression fails loudly in CI rather than dropping a CALLS edge in prod.
 */
import { describe, it, expect } from 'vitest';
import {
  validateAdlSeqCoverage,
  type AdlCandidateIndex,
} from '../../../../src/core/ingestion/languages/cpp/adl.js';
import type { SymbolDefinition } from 'gitnexus-shared';

function def(nodeId: string): SymbolDefinition {
  return { nodeId } as unknown as SymbolDefinition;
}

function makeIndex(
  nsCandidates: Map<string, Map<string, SymbolDefinition[]>>,
  friendCandidates: Map<string, Map<string, SymbolDefinition[]>>,
  seqByNodeId: Map<string, number>,
): AdlCandidateIndex {
  return {
    classDefsBySimple: new Map(),
    nsCandidates,
    friendCandidates,
    nsFunctionsByQName: new Map(),
    nsFunctionsBySimple: new Map(),
    seqByNodeId,
  };
}

describe('validateAdlSeqCoverage', () => {
  it('returns no missing ids when every bucketed def has a seq', () => {
    const ns = new Map([['lib', new Map([['act', [def('A')]]])]]);
    const friend = new Map([['lib', new Map([['swap', [def('B')]]])]]);
    const seq = new Map([
      ['A', 0],
      ['B', 1],
    ]);

    expect(validateAdlSeqCoverage(makeIndex(ns, friend, seq))).toEqual([]);
  });

  it('flags a namespace-candidate def missing from seqByNodeId', () => {
    const ns = new Map([['lib', new Map([['act', [def('A'), def('C')]]])]]);
    const friend = new Map<string, Map<string, SymbolDefinition[]>>();
    const seq = new Map([['A', 0]]); // 'C' missing

    expect(validateAdlSeqCoverage(makeIndex(ns, friend, seq))).toEqual(['C']);
  });

  it('flags a friend-candidate def missing from seqByNodeId', () => {
    const ns = new Map<string, Map<string, SymbolDefinition[]>>();
    const friend = new Map([['lib', new Map([['swap', [def('D')]]])]]);
    const seq = new Map<string, number>(); // 'D' missing

    expect(validateAdlSeqCoverage(makeIndex(ns, friend, seq))).toEqual(['D']);
  });

  it('reports each missing nodeId once even when bucketed under multiple keys', () => {
    // Inline-namespace transparency registers the same def under its own and
    // its parent QName; a missing seq should surface as a single entry.
    const inner = new Map([['act', [def('E')]]]);
    const ns = new Map([
      ['lib', inner],
      ['lib.inline', inner],
    ]);
    const friend = new Map<string, Map<string, SymbolDefinition[]>>();
    const seq = new Map<string, number>(); // 'E' missing

    expect(validateAdlSeqCoverage(makeIndex(ns, friend, seq))).toEqual(['E']);
  });
});

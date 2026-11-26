/**
 * End-to-end integration tests for C++ template argument deduction (B1),
 * partial/explicit specialization selection (B2), and CTAD / deduction guides
 * (B6) across header boundaries and worker-pool serialization (#1896).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import path from 'path';
import { FIXTURES, getRelationships, runPipelineFromRepo, type PipelineResult } from './helpers.js';

describe('C++ template deduction, specialization selection & CTAD (#1896)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'cpp-templates-deduction-spec-ctad'),
      () => {},
      { workerPoolSize: 2 },
    );
  }, 60000);

  const callsFrom = (caller: string): Array<{ target: string; line: number; targetId: string }> =>
    getRelationships(result, 'CALLS')
      .filter((edge) => edge.source === caller)
      .map((edge) => ({
        target: edge.target,
        line: Number(result.graph.getNode(edge.rel.targetId)?.properties.startLine ?? -1),
        targetId: edge.rel.targetId,
      }))
      .sort((a, b) => a.line - b.line || a.target.localeCompare(b.target));

  // ── B1: One-level template argument deduction ─────────────────────────────

  it('deduces T one level from std::vector<int> and const std::vector<double>&', () => {
    expect(callsFrom('positiveVecIntegral').map((c) => [c.target, c.line])).toEqual([
      ['consumeVec', 8],
    ]);
    expect(callsFrom('positiveVecFloating').map((c) => [c.target, c.line])).toEqual([
      ['consumeConstRefVec', 19],
    ]);
  });

  it('does not misclassify std::vector<int*> as integral or floating-point', () => {
    expect(callsFrom('negativeVecPointerElement')).toEqual([]);
  });

  it('peels pointer parameters for const T* overloads', () => {
    expect(callsFrom('positivePointerPeel').map((c) => [c.target, c.line])).toEqual([
      ['consumePtr', 22],
      ['consumePtr', 25],
    ]);
  });

  it('keeps multi-occurrence template parameters unknown so tied constrained overloads suppress', () => {
    expect(callsFrom('negativeMultiOccurrence')).toEqual([]);
    expect(callsFrom('negativeMultiPair')).toEqual([]);
  });

  // ── B2: Partial & explicit specialization selection ───────────────────────

  it('selects partial specialization S<T*>, orders S<const T*> ahead of S<T*>, and prefers explicit S<void*>', () => {
    expect(callsFrom('positivePartialSpecPointer').map((c) => c.target)).toEqual(['ptrSpecHit']);
    expect(callsFrom('positivePartialOrderConstPointer').map((c) => c.target)).toEqual([
      'constPtrSpecHit',
    ]);
    expect(callsFrom('positiveExplicitBeatsPartial').map((c) => c.target)).toEqual([
      'voidPtrExplicitHit',
    ]);
    expect(callsFrom('positivePrimaryUnmatched').map((c) => c.target)).toEqual(['primaryHit']);
  });

  it('falls back to primary template when partial specializations match ambiguously', () => {
    expect(callsFrom('negativeAmbiguousPartialSpecFallback').map((c) => c.target)).toEqual([
      'dualPrimaryHit',
    ]);
  });

  it('selects namespace-qualified partial specialization ns::Holder<T*>', () => {
    expect(callsFrom('positiveQualifiedPartialSpec').map((c) => c.target)).toEqual([
      'nsPtrSpecHit',
    ]);
  });

  // ── B6: CTAD & user-defined deduction guides ──────────────────────────────

  it('attaches deduced template arguments from CTAD literals, pointer args, and user deduction guides', () => {
    expect(callsFrom('positiveCtadLiteralInt').map((c) => c.target)).toEqual(['boxIntSpecHit']);
    expect(callsFrom('positiveCtadAutoPointer').map((c) => c.target)).toEqual(['boxPtrSpecHit']);
    expect(callsFrom('positiveCtadDeductionGuide').map((c) => c.target)).toEqual([
      'boxGuideSpecHit',
    ]);
  });

  it('propagates CTAD std::vector element type into one-level template argument deduction', () => {
    expect(callsFrom('positiveCtadVectorFeedsDeduction').map((c) => [c.target, c.line])).toEqual([
      ['consumeVec', 8],
    ]);
  });

  it('falls back to primary template on unknown CTAD argument and leaves non-template classes untouched', () => {
    expect(
      callsFrom('negativeCtadUnknownArgFallback')
        .map((c) => c.target)
        .sort(),
    ).toEqual(['boxPrimaryHit', 'opaqueSource']);
    expect(callsFrom('negativeNonTemplateClassUntouched').map((c) => c.target)).toEqual([
      'plainHit',
    ]);
  });
});

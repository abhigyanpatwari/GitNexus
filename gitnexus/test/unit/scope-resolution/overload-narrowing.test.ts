/**
 * Unit tests for `narrowOverloadCandidates` — the shared overload-
 * narrowing utility used by `receiver-bound-calls.ts::pickOverload`
 * (explicit receiver member call) and
 * `free-call-fallback.ts::pickImplicitThisOverload` (implicit-`this`
 * free call).
 *
 * The utility is pure (data in / data out), so tests build synthetic
 * `SymbolDefinition` stubs — no fixtures, no pipeline.
 */

import { describe, it, expect } from 'vitest';
import type { SymbolDefinition } from 'gitnexus-shared';
import { narrowOverloadCandidates } from '../../../src/core/ingestion/scope-resolution/passes/overload-narrowing.js';

const mkDef = (overrides: Partial<SymbolDefinition> & { nodeId: string }): SymbolDefinition => ({
  nodeId: overrides.nodeId,
  filePath: overrides.filePath ?? 'x.cs',
  type: overrides.type ?? 'Method',
  ...overrides,
});

describe('narrowOverloadCandidates — empty input', () => {
  it('returns empty output for empty overload list', () => {
    expect(narrowOverloadCandidates([], 1, ['int'])).toEqual([]);
    expect(narrowOverloadCandidates([], undefined, undefined)).toEqual([]);
  });
});

describe('narrowOverloadCandidates — arity filtering', () => {
  const add1 = mkDef({ nodeId: 'add:1', parameterCount: 1, requiredParameterCount: 1 });
  const add2 = mkDef({ nodeId: 'add:2', parameterCount: 2, requiredParameterCount: 2 });
  const add3 = mkDef({ nodeId: 'add:3', parameterCount: 3, requiredParameterCount: 3 });

  it('passes all overloads through when argCount is undefined', () => {
    const result = narrowOverloadCandidates([add1, add2, add3], undefined, undefined);
    expect(result.map((d) => d.nodeId)).toEqual(['add:1', 'add:2', 'add:3']);
  });

  it('filters out overloads whose max is below argCount (non-variadic)', () => {
    const result = narrowOverloadCandidates([add1, add2, add3], 2, undefined);
    expect(result.map((d) => d.nodeId)).toEqual(['add:2']);
  });

  it('filters out overloads whose required-count exceeds argCount', () => {
    const result = narrowOverloadCandidates([add1, add2, add3], 1, undefined);
    expect(result.map((d) => d.nodeId)).toEqual(['add:1']);
  });

  it('accepts argCount above max when `params` variadic marker is present', () => {
    const writeLine = mkDef({
      nodeId: 'wl:1',
      parameterCount: 2,
      requiredParameterCount: 1,
      parameterTypes: ['string', 'params object[]'],
    });
    const result = narrowOverloadCandidates([writeLine], 5, undefined);
    expect(result.map((d) => d.nodeId)).toEqual(['wl:1']);
  });

  it('accepts argCount above max when bare `params` marker is present', () => {
    const variadic = mkDef({
      nodeId: 'v:1',
      parameterCount: 1,
      requiredParameterCount: 0,
      parameterTypes: ['params'],
    });
    const result = narrowOverloadCandidates([variadic], 4, undefined);
    expect(result.map((d) => d.nodeId)).toEqual(['v:1']);
  });

  it('falls back to the full overload list when arity filter empties it', () => {
    // argCount=5 doesn't match any overload (none variadic, all have max < 5).
    const result = narrowOverloadCandidates([add1, add2, add3], 5, undefined);
    expect(result.map((d) => d.nodeId)).toEqual(['add:1', 'add:2', 'add:3']);
  });
});

describe('narrowOverloadCandidates — type narrowing', () => {
  const byInt = mkDef({
    nodeId: 'm:int',
    parameterCount: 1,
    requiredParameterCount: 1,
    parameterTypes: ['int'],
  });
  const byString = mkDef({
    nodeId: 'm:string',
    parameterCount: 1,
    requiredParameterCount: 1,
    parameterTypes: ['string'],
  });

  it('picks the overload whose parameterTypes[i] equals argTypes[i]', () => {
    const result = narrowOverloadCandidates([byInt, byString], 1, ['string']);
    expect(result.map((d) => d.nodeId)).toEqual(['m:string']);
  });

  it('treats empty-string argTypes slot as "unknown" and matches every candidate', () => {
    const result = narrowOverloadCandidates([byInt, byString], 1, ['']);
    // Both candidates survive because "" is an unknown slot.
    expect(result.map((d) => d.nodeId).sort()).toEqual(['m:int', 'm:string']);
  });

  it('falls through to arity-filtered candidates when type filter matches nothing', () => {
    const result = narrowOverloadCandidates([byInt, byString], 1, ['bool']);
    // Type mismatch against both — falls back to arity candidates.
    expect(result.map((d) => d.nodeId).sort()).toEqual(['m:int', 'm:string']);
  });

  it('skips the type filter entirely when argTypes is undefined', () => {
    const result = narrowOverloadCandidates([byInt, byString], 1, undefined);
    expect(result.map((d) => d.nodeId).sort()).toEqual(['m:int', 'm:string']);
  });

  it('skips the type filter entirely when argTypes is empty', () => {
    const result = narrowOverloadCandidates([byInt, byString], 1, []);
    expect(result.map((d) => d.nodeId).sort()).toEqual(['m:int', 'm:string']);
  });

  it('disqualifies an overload with missing parameterTypes under type filter', () => {
    const noTypes = mkDef({
      nodeId: 'm:notypes',
      parameterCount: 1,
      requiredParameterCount: 1,
    });
    const result = narrowOverloadCandidates([byInt, noTypes], 1, ['int']);
    expect(result.map((d) => d.nodeId)).toEqual(['m:int']);
  });
});

import { describe, expect, it } from 'vitest';
import type { ParameterTypeClass, SymbolDefinition } from 'gitnexus-shared';
import { cppConversionRank } from '../../../../src/core/ingestion/languages/cpp/conversion-rank.js';
import { narrowOverloadCandidates } from '../../../../src/core/ingestion/scope-resolution/passes/overload-narrowing.js';

const value = (base: string): ParameterTypeClass => ({
  base,
  cv: 'none',
  indirection: 'value',
  pointerDepth: 0,
});

const pointer = (base: string): ParameterTypeClass => ({
  base,
  cv: 'none',
  indirection: 'pointer',
  pointerDepth: 1,
});

const ellipsis = (): ParameterTypeClass => ({
  base: '...',
  cv: 'unknown',
  indirection: 'unknown',
  pointerDepth: 0,
});

const mkDef = (
  nodeId: string,
  parameterTypes: readonly string[],
  parameterTypeClasses: readonly ParameterTypeClass[],
): SymbolDefinition => ({
  nodeId,
  filePath: 'service.cpp',
  type: 'Method',
  parameterCount: parameterTypes.includes('...') ? undefined : parameterTypes.length,
  requiredParameterCount: parameterTypes.includes('...')
    ? parameterTypes.indexOf('...')
    : parameterTypes.length,
  parameterTypes: [...parameterTypes],
  parameterTypeClasses: [...parameterTypeClasses],
});

describe('cppConversionRank pointer/nullptr/ellipsis ranks (#1637)', () => {
  it('ranks nullptr -> T* ahead of nullptr -> bool', () => {
    expect(cppConversionRank('null', 'int', value('null'), pointer('int'))).toBe(2);
    expect(cppConversionRank('null', 'bool', value('null'), value('bool'))).toBe(3);
  });

  it('ranks pointer -> bool and pointer -> void* as standard conversions', () => {
    expect(cppConversionRank('int', 'bool', pointer('int'), value('bool'))).toBe(2);
    expect(cppConversionRank('int', 'void', pointer('int'), pointer('void'))).toBe(2);
  });

  it('keeps pointer exact matches shape-aware', () => {
    expect(cppConversionRank('int', 'int', pointer('int'), pointer('int'))).toBe(0);
    expect(cppConversionRank('int', 'int', value('int'), pointer('int'))).toBe(Infinity);
  });

  it('ranks ellipsis as the worst viable conversion', () => {
    expect(cppConversionRank('int', '...', value('int'), ellipsis())).toBe(4);
  });
});

describe('narrowOverloadCandidates with C++ pointer-rank sidecars (#1637)', () => {
  it('selects pointer overload for nullptr over bool overload', () => {
    const byPointer = mkDef('f:intptr', ['int'], [pointer('int')]);
    const byBool = mkDef('f:bool', ['bool'], [value('bool')]);

    const result = narrowOverloadCandidates([byPointer, byBool], 1, ['null'], {
      argumentTypeClasses: [value('null')],
      conversionRankFn: cppConversionRank,
    });

    expect(result.map((d) => d.nodeId)).toEqual(['f:intptr']);
  });

  it('does not treat normalized value and pointer types as exact matches', () => {
    const byPointer = mkDef('f:intptr', ['int'], [pointer('int')]);
    const byBool = mkDef('f:bool', ['bool'], [value('bool')]);

    const result = narrowOverloadCandidates([byPointer, byBool], 1, ['int'], {
      argumentTypeClasses: [value('int')],
      conversionRankFn: cppConversionRank,
    });

    expect(result.map((d) => d.nodeId)).toEqual(['f:bool']);
  });

  it('selects fixed-arity overload over ellipsis', () => {
    const exact = mkDef('g:int-int', ['int', 'int'], [value('int'), value('int')]);
    const variadic = mkDef('g:ellipsis', ['int', '...'], [value('int'), ellipsis()]);

    const result = narrowOverloadCandidates([exact, variadic], 2, ['int', 'int'], {
      argumentTypeClasses: [value('int'), value('int')],
      conversionRankFn: cppConversionRank,
    });

    expect(result.map((d) => d.nodeId)).toEqual(['g:int-int']);
  });

  it('keeps an ellipsis overload viable when it is the only match', () => {
    const variadic = mkDef('log:ellipsis', ['int', '...'], [value('int'), ellipsis()]);

    const result = narrowOverloadCandidates([variadic], 3, ['int', 'int', 'double'], {
      argumentTypeClasses: [value('int'), value('int'), value('double')],
      conversionRankFn: cppConversionRank,
    });

    expect(result.map((d) => d.nodeId)).toEqual(['log:ellipsis']);
  });
});

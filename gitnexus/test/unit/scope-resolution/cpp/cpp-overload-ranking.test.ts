import { afterEach, describe, expect, it } from 'vitest';
import type { ParameterTypeClass, SymbolDefinition } from 'gitnexus-shared';
import { cppConversionRank } from '../../../../src/core/ingestion/languages/cpp/conversion-rank.js';
import {
  clearCppUserDefinedConversions,
  registerCppUserDefinedConversion,
} from '../../../../src/core/ingestion/languages/cpp/user-defined-conversions.js';
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

const constRef = (base: string): ParameterTypeClass => ({
  base,
  cv: 'const',
  indirection: 'lvalue-ref',
  pointerDepth: 0,
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

afterEach(() => {
  clearCppUserDefinedConversions();
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
    expect(cppConversionRank('int', '...', value('int'), ellipsis())).toBe(5);
  });
});

describe('cppConversionRank user-defined conversion ranks (#1631)', () => {
  it('ranks registered one-step user-defined conversions after standard conversions', () => {
    clearCppUserDefinedConversions();
    registerCppUserDefinedConversion('int', 'Wrap');

    expect(cppConversionRank('int', 'Wrap', value('int'), value('Wrap'))).toBe(4);
    expect(cppConversionRank('int', 'double', value('int'), value('double'))).toBe(2);
  });

  it('keeps tied user-defined conversion candidates ambiguous', () => {
    clearCppUserDefinedConversions();
    registerCppUserDefinedConversion('int', 'WrapA');
    registerCppUserDefinedConversion('int', 'WrapB');

    const byWrapA = mkDef('h:WrapA', ['WrapA'], [value('WrapA')]);
    const byWrapB = mkDef('h:WrapB', ['WrapB'], [value('WrapB')]);

    const result = narrowOverloadCandidates([byWrapA, byWrapB], 1, ['int'], {
      argumentTypeClasses: [value('int')],
      conversionRankFn: cppConversionRank,
    });

    expect(result.map((d) => d.nodeId)).toEqual(['h:WrapA', 'h:WrapB']);
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

describe('narrowOverloadCandidates with C++ template partial ordering (#1635)', () => {
  it('selects T* over T for pointer arguments', () => {
    const byValue = mkDef('pick:T', ['T'], [value('T')]);
    const byPointer = mkDef('pick:T*', ['T'], [pointer('T')]);

    const result = narrowOverloadCandidates([byValue, byPointer], 1, ['int'], {
      argumentTypeClasses: [pointer('int')],
    });

    expect(result.map((d) => d.nodeId)).toEqual(['pick:T*']);
  });

  it('keeps const T& versus T ambiguous for value arguments', () => {
    const byValue = mkDef('pick:T', ['T'], [value('T')]);
    const byReference = mkDef('pick:const-T-ref', ['T'], [constRef('T')]);

    const result = narrowOverloadCandidates([byValue, byReference], 1, ['int'], {
      argumentTypeClasses: [value('int')],
    });

    expect(result.map((d) => d.nodeId)).toEqual([]);
  });

  it('suppresses when any surviving candidate cannot participate in ordering', () => {
    const concreteSlot = mkDef('pick:T-int', ['T', 'int'], [value('T'), value('int')]);
    const pointerSlot = mkDef('pick:T-T*', ['T', 'T'], [value('T'), pointer('T')]);

    const result = narrowOverloadCandidates([concreteSlot, pointerSlot], 2, ['int', 'int'], {
      argumentTypeClasses: [pointer('int'), pointer('int')],
    });

    expect(result.map((d) => d.nodeId)).toEqual([]);
  });

  it('suppresses when a surviving candidate lacks parameter sidecars', () => {
    const withoutSidecar: SymbolDefinition = {
      ...mkDef('pick:no-sidecar', ['T'], [value('T')]),
      parameterTypeClasses: undefined,
    };
    const byPointer = mkDef('pick:T*', ['T'], [pointer('T')]);

    const result = narrowOverloadCandidates([withoutSidecar, byPointer], 1, ['int'], {
      argumentTypeClasses: [pointer('int')],
    });

    expect(result.map((d) => d.nodeId)).toEqual([]);
  });

  it('leaves lowercase template placeholders ambiguous rather than guessing', () => {
    const byValue = mkDef('pick:t', ['t'], [value('t')]);
    const byPointer = mkDef('pick:t*', ['t'], [pointer('t')]);

    const result = narrowOverloadCandidates([byValue, byPointer], 1, ['int'], {
      argumentTypeClasses: [pointer('int')],
    });

    expect(result.map((d) => d.nodeId)).toEqual(['pick:t', 'pick:t*']);
  });

  it('keeps crossed template shapes ambiguous', () => {
    const pointerThenValue = mkDef('pick:T*-T', ['T', 'T'], [pointer('T'), value('T')]);
    const valueThenPointer = mkDef('pick:T-T*', ['T', 'T'], [value('T'), pointer('T')]);

    const result = narrowOverloadCandidates(
      [pointerThenValue, valueThenPointer],
      2,
      ['int', 'int'],
      {
        argumentTypeClasses: [pointer('int'), pointer('int')],
      },
    );

    expect(result.map((d) => d.nodeId)).toEqual(['pick:T*-T', 'pick:T-T*']);
  });
});

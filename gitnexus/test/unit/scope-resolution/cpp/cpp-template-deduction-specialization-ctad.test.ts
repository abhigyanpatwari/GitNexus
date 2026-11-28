/**
 * Unit tests for C++ template argument deduction (B1), partial/explicit
 * specialization selection & partial ordering (B2), and CTAD / deduction
 * guides (B6) — issue #1896.
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { ParameterTypeClass, ScopeId, SymbolDefinition } from 'gitnexus-shared';
import { emitCppScopeCaptures } from '../../../../src/core/ingestion/languages/cpp/captures.js';
import type { CppConstraintPayload } from '../../../../src/core/ingestion/languages/cpp/constraint-extractor.js';
import { cppConstraintCompatibility } from '../../../../src/core/ingestion/languages/cpp/constraint-filter.js';
import { classifyCppParameterType } from '../../../../src/core/ingestion/languages/cpp/arity-metadata.js';
import { normalizeCppTypeName } from '../../../../src/core/ingestion/languages/cpp/interpret.js';
import {
  canonicalCppTypeTerm,
  isCppPatternMoreSpecialized,
  matchCppTemplateSpecializations,
  parseCppTypeTerm,
  unifyCppTypePattern,
  type CppTypeTerm,
} from '../../../../src/core/ingestion/languages/cpp/template-specialization.js';
import {
  clearCppCtadState,
  collectCppCtadSideChannel,
} from '../../../../src/core/ingestion/languages/cpp/ctad.js';
import { extractParsedFile } from '../../../../src/core/ingestion/scope-extractor-bridge.js';
import { finalizeScopeModel } from '../../../../src/core/ingestion/finalize-orchestrator.js';
import { cppScopeResolver } from '../../../../src/core/ingestion/languages/cpp/scope-resolver.js';

afterEach(() => {
  clearCppCtadState();
});

function extractConstraintPayloads(src: string): CppConstraintPayload[] {
  const out: CppConstraintPayload[] = [];
  for (const m of emitCppScopeCaptures(src, 'unit.cpp')) {
    const cap = m['@declaration.template-constraints'];
    if (cap !== undefined) out.push(JSON.parse(cap.text) as CppConstraintPayload);
  }
  return out;
}

describe('B1 — one-level template argument deduction (#1896)', () => {
  it('extracts template-arg unwrap for std::vector<T> and const std::vector<T>&', () => {
    const payloads = extractConstraintPayloads(`
      #include <type_traits>
      #include <vector>
      template<class T, std::enable_if_t<std::is_integral_v<T>, int> = 0>
      void byVal(std::vector<T> v);

      template<class T> requires std::is_floating_point_v<T>
      void byConstRef(const std::vector<T>& v);
    `);
    expect(payloads).toHaveLength(2);
    expect(payloads[0].paramArgIndex).toEqual({ T: 0 });
    expect(payloads[0].paramUnwraps).toEqual({
      T: { kind: 'template-arg', containerBase: 'vector', argIndex: 0, pointerDepth: 0 },
    });
    expect(payloads[1].paramArgIndex).toEqual({ T: 0 });
    expect(payloads[1].paramUnwraps).toEqual({
      T: { kind: 'template-arg', containerBase: 'vector', argIndex: 0, pointerDepth: 0 },
    });
  });

  it('evaluates peeled container element type accurately including pointer-element rejection', () => {
    const [integralPayload] = extractConstraintPayloads(`
      #include <type_traits>
      #include <vector>
      template<class T, std::enable_if_t<std::is_integral_v<T>, int> = 0>
      void g(std::vector<T> v);
    `);
    const def: SymbolDefinition = {
      nodeId: 'fn:g',
      filePath: 'unit.cpp',
      type: 'Function',
      templateConstraints: integralPayload,
    };

    const vecInt = classifyCppParameterType('std::vector<int>', 'v', 'std::vector<int> v');
    const vecDouble = classifyCppParameterType('std::vector<double>', 'v', 'std::vector<double> v');
    const vecIntPtr = classifyCppParameterType('std::vector<int*>', 'v', 'std::vector<int*> v');
    const listInt = classifyCppParameterType('std::list<int>', 'v', 'std::list<int> v');

    expect(vecInt.templateArguments).toEqual(['int']);
    expect(vecIntPtr.templateArguments).toEqual(['int*']);

    expect(
      cppConstraintCompatibility({ arity: 1 }, def, {
        argumentTypes: ['vector<int>'],
        argumentTypeClasses: [vecInt],
      }),
    ).toBe('compatible');

    expect(
      cppConstraintCompatibility({ arity: 1 }, def, {
        argumentTypes: ['vector<double>'],
        argumentTypeClasses: [vecDouble],
      }),
    ).toBe('incompatible');

    // `int*` is a pointer, NOT an integral type (`is_integral_v<int*> == false`).
    expect(
      cppConstraintCompatibility({ arity: 1 }, def, {
        argumentTypes: ['vector<int*>'],
        argumentTypeClasses: [vecIntPtr],
      }),
    ).toBe('incompatible');

    // Mismatched container (`std::list<int>` vs `std::vector<T>`) stays unknown.
    expect(
      cppConstraintCompatibility({ arity: 1 }, def, {
        argumentTypes: ['list<int>'],
        argumentTypeClasses: [listInt],
      }),
    ).toBe('unknown');
  });

  it('deduces distinct single-occurrence parameters in std::pair<T, U>', () => {
    const [payload] = extractConstraintPayloads(`
      #include <type_traits>
      #include <utility>
      template<class T, class U>
        requires (std::is_integral_v<T> && std::is_floating_point_v<U>)
      void takePair(std::pair<T, U> p);
    `);
    expect(payload.paramArgIndex).toEqual({ T: 0, U: 0 });
    expect(payload.paramUnwraps).toEqual({
      T: { kind: 'template-arg', containerBase: 'pair', argIndex: 0, pointerDepth: 0 },
      U: { kind: 'template-arg', containerBase: 'pair', argIndex: 1, pointerDepth: 0 },
    });

    const def: SymbolDefinition = {
      nodeId: 'fn:takePair',
      filePath: 'unit.cpp',
      type: 'Function',
      templateConstraints: payload,
    };
    const pairIntDouble = classifyCppParameterType('std::pair<int, double>');
    const pairDoubleInt = classifyCppParameterType('std::pair<double, int>');

    expect(
      cppConstraintCompatibility({ arity: 1 }, def, {
        argumentTypes: ['pair<int, double>'],
        argumentTypeClasses: [pairIntDouble],
      }),
    ).toBe('compatible');
    expect(
      cppConstraintCompatibility({ arity: 1 }, def, {
        argumentTypes: ['pair<double, int>'],
        argumentTypeClasses: [pairDoubleInt],
      }),
    ).toBe('incompatible');
  });

  it('marks multi-occurrence, nested-container, non-deduced, and forwarding-ref shapes unknown', () => {
    const payloads = extractConstraintPayloads(`
      #include <type_traits>
      #include <utility>
      #include <vector>
      template<class T> requires std::is_integral_v<T>
      void twoArgs(T a, T b);

      template<class T> requires std::is_integral_v<T>
      void samePair(std::pair<T, T> p);

      template<class T> requires std::is_integral_v<T>
      void twoLevel(std::vector<std::vector<T>> nested);

      template<class T> requires std::is_integral_v<T>
      void nonDeduced(typename T::value_type x);

      template<class T> requires std::is_reference_v<T>
      void forwardingRef(T&& x);
    `);
    expect(payloads).toHaveLength(5);
    for (const p of payloads) {
      expect(p.paramArgIndex).toEqual({});
      expect(p.paramUnwraps).toBeUndefined();
    }
  });

  it('peels pointer depth for T* parameters while keeping double pointers distinct', () => {
    const [payload] = extractConstraintPayloads(`
      #include <type_traits>
      template<class T> requires std::is_pointer_v<T>
      void derefOnce(T* p);
    `);
    const def: SymbolDefinition = {
      nodeId: 'fn:derefOnce',
      filePath: 'unit.cpp',
      type: 'Function',
      templateConstraints: payload,
    };
    const singlePtr: ParameterTypeClass = {
      base: 'int',
      cv: 'none',
      indirection: 'pointer',
      pointerDepth: 1,
    };
    const doublePtr: ParameterTypeClass = {
      base: 'int',
      cv: 'none',
      indirection: 'pointer',
      pointerDepth: 2,
    };

    // `int*` passed to `T*` -> `T = int` (not a pointer).
    expect(
      cppConstraintCompatibility({ arity: 1 }, def, {
        argumentTypes: ['int'],
        argumentTypeClasses: [singlePtr],
      }),
    ).toBe('incompatible');
    // `int**` passed to `T*` -> `T = int*` (is a pointer).
    expect(
      cppConstraintCompatibility({ arity: 1 }, def, {
        argumentTypes: ['int'],
        argumentTypeClasses: [doublePtr],
      }),
    ).toBe('compatible');
  });
});

describe('B2 — template type unifier & partial specialization ordering (#1896)', () => {
  it('canonicalizes east-const and west-const pointees identically while keeping top-level pointer const distinct', () => {
    const west = parseCppTypeTerm('const int*');
    const east = parseCppTypeTerm('int const*');
    const topConstPtr = parseCppTypeTerm('int* const');

    expect(west).not.toBeNull();
    expect(east).not.toBeNull();
    expect(topConstPtr).not.toBeNull();
    expect(west && canonicalCppTypeTerm(west)).toBe('const int*');
    expect(east && canonicalCppTypeTerm(east)).toBe('const int*');
    expect(topConstPtr && canonicalCppTypeTerm(topConstPtr)).toBe('int* const');
  });

  it('preserves inner cv and array tokens inside normalizeCppTypeName', () => {
    expect(normalizeCppTypeName('const S<const int*>&')).toBe('S<const int*>');
    expect(normalizeCppTypeName('Arr<int[4]>[2]')).toBe('Arr<int[4]>');
    expect(normalizeCppTypeName('const Outer<const int*>::Inner*')).toBe(
      'Outer<const int*>::Inner',
    );
  });

  it('unifies pointer, array-bound, nested container, and repeated-param patterns', () => {
    const b1 = new Map<string, CppTypeTerm>();
    expect(unifyCppTypePattern('T*', 'const int*', new Set(['T']), b1)).toBe(true);
    const b1T = b1.get('T');
    expect(b1T && canonicalCppTypeTerm(b1T)).toBe('const int');

    const b2 = new Map<string, CppTypeTerm>();
    expect(unifyCppTypePattern('const T*', 'int*', new Set(['T']), b2)).toBe(false);

    const b3 = new Map<string, CppTypeTerm>();
    expect(unifyCppTypePattern('T[N]', 'double[8]', new Set(['T', 'N']), b3)).toBe(true);
    const b3T = b3.get('T');
    const b3N = b3.get('N');
    expect(b3T && canonicalCppTypeTerm(b3T)).toBe('double');
    expect(b3N && canonicalCppTypeTerm(b3N)).toBe('8');

    const b4 = new Map<string, CppTypeTerm>();
    expect(unifyCppTypePattern('Pair<T, T>', 'Pair<int, int>', new Set(['T']), b4)).toBe(true);
    expect(unifyCppTypePattern('Pair<T, T>', 'Pair<int, double>', new Set(['T']), new Map())).toBe(
      false,
    );
  });

  it('orders const T* ahead of T* and Pair<T, T> ahead of Pair<T, U>, while leaving Pair<T, int> vs Pair<int, U> incomparable', () => {
    expect(isCppPatternMoreSpecialized(['const T*'], new Set(['T']), ['U*'], new Set(['U']))).toBe(
      true,
    );
    expect(isCppPatternMoreSpecialized(['U*'], new Set(['U']), ['const T*'], new Set(['T']))).toBe(
      false,
    );

    expect(
      isCppPatternMoreSpecialized(['T', 'T'], new Set(['T']), ['A', 'B'], new Set(['A', 'B'])),
    ).toBe(true);

    expect(
      isCppPatternMoreSpecialized(['T', 'int'], new Set(['T']), ['int', 'U'], new Set(['U'])),
    ).toBe(false);
    expect(
      isCppPatternMoreSpecialized(['int', 'U'], new Set(['U']), ['T', 'int'], new Set(['T'])),
    ).toBe(false);
  });

  it('selects explicit > most-specialized partial > ambiguous sentinel, and declines dependent use-site args', () => {
    const parsed = extractParsedFile(
      cppScopeResolver.languageProvider,
      `
      template<class Outer>
      void host() {}
      `,
      'spec.cpp',
    );
    if (parsed === null) throw new Error('expected parsed file');
    cppScopeResolver.populateOwners(parsed);
    const indexes = finalizeScopeModel([parsed]);
    const moduleScopeId = parsed.moduleScope;
    const fnScope = parsed.scopes.find((s) => s.kind === 'Function');
    if (fnScope === undefined) throw new Error('expected function scope');

    const mkSpec = (
      nodeId: string,
      templateArguments?: string[],
      typeParamNames?: string[],
    ): SymbolDefinition => ({
      nodeId,
      filePath: 'spec.cpp',
      type: 'Struct',
      qualifiedName: 'S',
      ...(templateArguments !== undefined ? { templateArguments } : {}),
      ...(typeParamNames !== undefined
        ? { typeParameters: typeParamNames.map((name) => ({ name })) }
        : {}),
    });

    const primary = mkSpec('S:primary', undefined, ['T']);
    const ptrSpec = mkSpec('S:ptr', ['T*'], ['T']);
    const constPtrSpec = mkSpec('S:const-ptr', ['const T*'], ['T']);
    const voidPtrExplicit = mkSpec('S:void-ptr', ['void*']);

    const cands = [primary, ptrSpec, constPtrSpec, voidPtrExplicit];

    expect(
      matchCppTemplateSpecializations(cands, ['int*'], { scopeId: moduleScopeId, scopes: indexes }),
    ).toEqual([ptrSpec]);

    expect(
      matchCppTemplateSpecializations(cands, ['const int*'], {
        scopeId: moduleScopeId,
        scopes: indexes,
      }),
    ).toEqual([constPtrSpec]);

    expect(
      matchCppTemplateSpecializations(cands, ['void*'], {
        scopeId: moduleScopeId,
        scopes: indexes,
      }),
    ).toEqual([voidPtrExplicit]);

    // Dependent `Outer*` inside `template<class Outer> void host()` declines specialization selection.
    expect(
      matchCppTemplateSpecializations(cands, ['Outer*'], {
        scopeId: fnScope.id as ScopeId,
        scopes: indexes,
      }),
    ).toEqual([]);

    // Ambiguous partial specializations return `'ambiguous'`.
    const left = mkSpec('Dual:left', ['T', 'int'], ['T']);
    const right = mkSpec('Dual:right', ['int', 'U'], ['U']);
    expect(
      matchCppTemplateSpecializations([left, right], ['int', 'int'], {
        scopeId: moduleScopeId,
        scopes: indexes,
      }),
    ).toBe('ambiguous');
  });
});

describe('B6 — CTAD side-channel & workspace synthesis (#1896)', () => {
  it('synthesizes CTAD template arguments from literals, pointers, aggregates, and guides while leaving unknown args and plain classes untouched', () => {
    const src = `
      template<class T> struct Box { Box(T v) {} };
      Box(const char*) -> Box<double>;

      template<class A, class B> struct PairAgg { A first; B second; };
      struct Plain { Plain(int x) {} };
      int unknownFn();

      void test(int* ptr) {
        Box bInt{42};
        auto bPtr = Box{ptr};
        Box bGuide{"txt"};
        PairAgg agg{1, 2.5};
        Box bCopy{bInt};
        Box bUnknown{unknownFn()};
        Plain plain{9};
      }
    `;
    const parsed = extractParsedFile(cppScopeResolver.languageProvider, src, 'ctad.cpp');
    if (parsed === null) throw new Error('expected parsed file');
    const sideChannel = collectCppCtadSideChannel('ctad.cpp');
    expect(sideChannel.deductionGuides).toHaveLength(1);
    expect(sideChannel.classShapes).toHaveLength(2);
    expect(sideChannel.sites).toHaveLength(7);

    cppScopeResolver.populateOwners(parsed);
    const indexes = finalizeScopeModel([parsed]);
    cppScopeResolver.populateNamespaceSiblings?.([parsed], indexes, {
      fileContents: new Map([['ctad.cpp', src]]),
    });

    const testBlockScope = parsed.scopes.find((s) => s.typeBindings.has('bInt'));
    if (testBlockScope === undefined) throw new Error('expected CTAD binding scope');
    expect(testBlockScope.typeBindings.get('bInt')?.rawName).toBe('Box<int>');
    expect(testBlockScope.typeBindings.get('bPtr')?.rawName).toBe('Box<int*>');
    expect(testBlockScope.typeBindings.get('bGuide')?.rawName).toBe('Box<double>');
    expect(testBlockScope.typeBindings.get('agg')?.rawName).toBe('PairAgg<int, double>');
    expect(testBlockScope.typeBindings.get('bCopy')?.rawName).toBe('Box<int>');
    // Unknown initializer argument stays bare `Box` (primary fallback).
    expect(testBlockScope.typeBindings.get('bUnknown')?.rawName).toBe('Box');
    // Non-template class stays bare `Plain`.
    expect(testBlockScope.typeBindings.get('plain')?.rawName).toBe('Plain');
  });
});

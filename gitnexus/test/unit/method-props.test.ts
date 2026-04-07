import { describe, it, expect } from 'vitest';
import {
  typeTagForId,
  arityForIdFromInfo,
  constTagForId,
} from '../../src/core/ingestion/utils/method-props.js';
import type { MethodInfo } from '../../src/core/ingestion/method-types.js';
import { SupportedLanguages } from 'gitnexus-shared';

function makeMethodInfo(
  name: string,
  params: Array<{ name: string; type: string | null; rawType?: string | null }>,
  overrides: Partial<MethodInfo> = {},
): MethodInfo {
  return {
    name,
    receiverType: null,
    returnType: null,
    parameters: params.map((p) => ({
      name: p.name,
      type: p.type,
      ...(p.rawType !== undefined ? { rawType: p.rawType } : {}),
      isOptional: false,
      isVariadic: false,
    })),
    visibility: 'public',
    isStatic: false,
    isAbstract: false,
    isFinal: false,
    annotations: [],
    sourceFile: 'test.java',
    line: 1,
    ...overrides,
  };
}

function buildMethodMap(methods: MethodInfo[]): Map<string, MethodInfo> {
  const map = new Map<string, MethodInfo>();
  for (const m of methods) {
    map.set(`${m.name}:${m.line}`, m);
  }
  return map;
}

describe('typeTagForId', () => {
  it('returns type tag for same-arity collision: find(int) vs find(String)', () => {
    const findInt = makeMethodInfo('find', [{ name: 'id', type: 'int' }], { line: 10 });
    const findString = makeMethodInfo('find', [{ name: 'name', type: 'String' }], { line: 15 });
    const map = buildMethodMap([findInt, findString]);

    expect(typeTagForId(map, 'find', 1, findInt)).toBe('~int');
    expect(typeTagForId(map, 'find', 1, findString)).toBe('~String');
  });

  it('returns type tag for three-way collision with multi-param methods', () => {
    const a = makeMethodInfo(
      'process',
      [
        { name: 'x', type: 'int' },
        { name: 'y', type: 'int' },
      ],
      { line: 10 },
    );
    const b = makeMethodInfo(
      'process',
      [
        { name: 'x', type: 'int' },
        { name: 'y', type: 'String' },
      ],
      { line: 15 },
    );
    const c = makeMethodInfo(
      'process',
      [
        { name: 'x', type: 'String' },
        { name: 'y', type: 'String' },
      ],
      { line: 20 },
    );
    const map = buildMethodMap([a, b, c]);

    expect(typeTagForId(map, 'process', 2, a)).toBe('~int,int');
    expect(typeTagForId(map, 'process', 2, b)).toBe('~int,String');
    expect(typeTagForId(map, 'process', 2, c)).toBe('~String,String');
  });

  it('returns empty string for single method (no collision)', () => {
    const save = makeMethodInfo('save', [{ name: 'user', type: 'User' }], { line: 10 });
    const map = buildMethodMap([save]);

    expect(typeTagForId(map, 'save', 1, save)).toBe('');
  });

  it('returns empty string when same name but different arity (no collision in group)', () => {
    const find1 = makeMethodInfo('find', [{ name: 'id', type: 'int' }], { line: 10 });
    const find2 = makeMethodInfo(
      'find',
      [
        { name: 'id', type: 'int' },
        { name: 'name', type: 'String' },
      ],
      { line: 15 },
    );
    const map = buildMethodMap([find1, find2]);

    expect(typeTagForId(map, 'find', 1, find1)).toBe('');
    expect(typeTagForId(map, 'find', 2, find2)).toBe('');
  });

  it('returns empty string when collision exists but a method has null type', () => {
    const findInt = makeMethodInfo('find', [{ name: 'id', type: 'int' }], { line: 10 });
    const findUntyped = makeMethodInfo('find', [{ name: 'name', type: null }], { line: 15 });
    const map = buildMethodMap([findInt, findUntyped]);

    expect(typeTagForId(map, 'find', 1, findInt)).toBe('');
    expect(typeTagForId(map, 'find', 1, findUntyped)).toBe('');
  });

  it('returns empty string for variadic method (arity undefined)', () => {
    const m = makeMethodInfo('log', [{ name: 'args', type: 'String' }]);
    m.parameters[0].isVariadic = true;
    const map = buildMethodMap([m]);

    expect(typeTagForId(map, 'log', undefined, m)).toBe('');
  });

  it('handles constructor overloads the same as methods', () => {
    const ctorInt = makeMethodInfo('constructor', [{ name: 'id', type: 'int' }], { line: 5 });
    const ctorString = makeMethodInfo('constructor', [{ name: 'name', type: 'String' }], {
      line: 10,
    });
    const map = buildMethodMap([ctorInt, ctorString]);

    expect(typeTagForId(map, 'constructor', 1, ctorInt)).toBe('~int');
    expect(typeTagForId(map, 'constructor', 1, ctorString)).toBe('~String');
  });

  it('returns empty string for single zero-arity method', () => {
    const m = makeMethodInfo('getName', [], { line: 10 });
    const map = buildMethodMap([m]);

    expect(typeTagForId(map, 'getName', 0, m)).toBe('');
  });

  it('returns empty string for zero-arity collision (no types to disambiguate)', () => {
    const m1 = makeMethodInfo('begin', [], { line: 10 });
    const m2 = makeMethodInfo('begin', [], { line: 15 });
    const map = buildMethodMap([m1, m2]);

    expect(typeTagForId(map, 'begin', 0, m1)).toBe('');
    expect(typeTagForId(map, 'begin', 0, m2)).toBe('');
  });

  it('returns empty string for TypeScript (overload signatures should collapse)', () => {
    const findNum = makeMethodInfo('find', [{ name: 'id', type: 'number' }], { line: 10 });
    const findStr = makeMethodInfo('find', [{ name: 'name', type: 'string' }], { line: 15 });
    const map = buildMethodMap([findNum, findStr]);

    // Without language, same-arity collision → type tag
    expect(typeTagForId(map, 'find', 1, findNum)).toBe('~number');
    // With TypeScript language, type tag is skipped
    expect(typeTagForId(map, 'find', 1, findNum, SupportedLanguages.TypeScript)).toBe('');
    expect(typeTagForId(map, 'find', 1, findStr, SupportedLanguages.JavaScript)).toBe('');
  });

  it('rawType preserves generics: vector<int> vs vector<string> produce distinct tags', () => {
    // With rawType, template/generic args are preserved for the type tag.
    const vecInt = makeMethodInfo(
      'process',
      [{ name: 'items', type: 'vector', rawType: 'vector<int>' }],
      { line: 10 },
    );
    const vecStr = makeMethodInfo(
      'process',
      [{ name: 'items', type: 'vector', rawType: 'vector<string>' }],
      { line: 15 },
    );
    const map = buildMethodMap([vecInt, vecStr]);

    expect(typeTagForId(map, 'process', 1, vecInt)).toBe('~vector<int>');
    expect(typeTagForId(map, 'process', 1, vecStr)).toBe('~vector<string>');
  });

  it('falls back to type when rawType is not set', () => {
    // Backward compat: old ParameterInfo without rawType still works
    const findInt = makeMethodInfo('find', [{ name: 'id', type: 'int' }], { line: 10 });
    const findStr = makeMethodInfo('find', [{ name: 'name', type: 'String' }], { line: 15 });
    const map = buildMethodMap([findInt, findStr]);

    expect(typeTagForId(map, 'find', 1, findInt)).toBe('~int');
    expect(typeTagForId(map, 'find', 1, findStr)).toBe('~String');
  });
});

describe('arityForIdFromInfo', () => {
  it('returns parameter count for non-variadic methods', () => {
    const m = makeMethodInfo('find', [
      { name: 'id', type: 'int' },
      { name: 'name', type: 'String' },
    ]);
    expect(arityForIdFromInfo(m)).toBe(2);
  });

  it('returns undefined for variadic methods', () => {
    const m = makeMethodInfo('log', [{ name: 'args', type: 'String' }]);
    m.parameters[0].isVariadic = true;
    expect(arityForIdFromInfo(m)).toBeUndefined();
  });

  it('returns 0 for parameterless methods', () => {
    const m = makeMethodInfo('getName', []);
    expect(arityForIdFromInfo(m)).toBe(0);
  });
});

describe('constTagForId', () => {
  it('returns $const for const method when non-const collision exists', () => {
    const beginConst = makeMethodInfo('begin', [], { line: 10, isConst: true });
    const beginNonConst = makeMethodInfo('begin', [], { line: 15 });
    const map = buildMethodMap([beginConst, beginNonConst]);

    expect(constTagForId(map, 'begin', 0, beginConst)).toBe('$const');
  });

  it('returns empty string for non-const method even when const collision exists', () => {
    const beginConst = makeMethodInfo('begin', [], { line: 10, isConst: true });
    const beginNonConst = makeMethodInfo('begin', [], { line: 15 });
    const map = buildMethodMap([beginConst, beginNonConst]);

    expect(constTagForId(map, 'begin', 0, beginNonConst)).toBe('');
  });

  it('returns empty string for single const method (no collision)', () => {
    const sizeConst = makeMethodInfo('size', [], { line: 10, isConst: true });
    const map = buildMethodMap([sizeConst]);

    expect(constTagForId(map, 'size', 0, sizeConst)).toBe('');
  });

  it('works with typed parameters: find(int) vs find(int) const', () => {
    const findConst = makeMethodInfo('find', [{ name: 'id', type: 'int' }], {
      line: 10,
      isConst: true,
    });
    const findNonConst = makeMethodInfo('find', [{ name: 'id', type: 'int' }], { line: 15 });
    const map = buildMethodMap([findConst, findNonConst]);

    expect(constTagForId(map, 'find', 1, findConst)).toBe('$const');
    expect(constTagForId(map, 'find', 1, findNonConst)).toBe('');
  });

  it('returns empty string for non-const method without isConst field', () => {
    const m = makeMethodInfo('clear', [], { line: 10 });
    const map = buildMethodMap([m]);

    expect(constTagForId(map, 'clear', 0, m)).toBe('');
  });
});

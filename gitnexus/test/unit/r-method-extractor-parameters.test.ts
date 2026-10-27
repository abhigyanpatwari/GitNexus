/**
 * The R method extractor must read the formals of a method's `function(...)`. The
 * grammar emits one `parameter` node per formal (`name` is an `identifier`, or `dots`
 * for `...`); a formal with a `default` is optional and `...` is variadic.
 */
import { describe, expect, it } from 'vitest';
import Parser from 'tree-sitter';
import R from '@eagleoutice/tree-sitter-r';
import { SupportedLanguages } from 'gitnexus-shared';
import { rMethodExtractor } from '../../src/core/ingestion/method-extractors/r.js';
import type { MethodExtractorContext, MethodInfo } from '../../src/core/ingestion/method-types.js';

const parser = new Parser();
parser.setLanguage(R as Parameters<Parser['setLanguage']>[0]);
const context = {
  filePath: 'classes.R',
  language: SupportedLanguages.R,
} as unknown as MethodExtractorContext;

/** The methods the extractor reads from the only `Acct <- R6Class(...)` in `source`. */
function r6Methods(source: string): MethodInfo[] {
  const tree = parser.parse(source, undefined, { bufferSize: 1 << 24 });
  const owner = tree.rootNode
    .descendantsOfType('binary_operator')
    .find((n) => n.childForFieldName('lhs')?.text === 'Acct');
  expect(owner).toBeDefined();
  return rMethodExtractor.extract(owner as never, context)?.methods ?? [];
}

/** The methods the extractor reads from the only `setRefClass(...)` in `source`. */
function refClassMethods(source: string): MethodInfo[] {
  const tree = parser.parse(source, undefined, { bufferSize: 1 << 24 });
  const call = tree.rootNode
    .descendantsOfType('call')
    .find((c) => c.childForFieldName('function')?.text === 'setRefClass');
  expect(call).toBeDefined();
  return rMethodExtractor.extract(call as never, context)?.methods ?? [];
}

const byName = (methods: MethodInfo[], name: string): MethodInfo => {
  const hit = methods.find((m) => m.name === name);
  expect(hit).toBeDefined();
  return hit as MethodInfo;
};

describe('R method extractor: parameters of R6 methods', () => {
  const methods = r6Methods(`Acct <- R6::R6Class("Acct", public = list(
  none = function() 1,
  one = function(x) x,
  many = function(a, b, c, d) a,
  defaults = function(a, b = 2, c = "x", d = NULL) a,
  dotted = function(amount, note = "x", ...) amount,
  onlyDots = function(...) 1,
  fnDefault = function(f = function(z) z, y) y
), private = list(
  hidden = function(p, q = TRUE) p
), active = list(
  total = function(value) value
))`);

  it('reads no parameters from a method with no formals', () => {
    expect(byName(methods, 'none').parameters).toEqual([]);
  });

  it('reads a single parameter', () => {
    expect(byName(methods, 'one').parameters).toEqual([
      { name: 'x', type: null, isOptional: false, isVariadic: false },
    ]);
  });

  it('reads every parameter, in order', () => {
    expect(byName(methods, 'many').parameters.map((p) => p.name)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('marks a parameter with a default as optional, and only that one', () => {
    const params = byName(methods, 'defaults').parameters;
    expect(params.map((p) => [p.name, p.isOptional])).toEqual([
      ['a', false],
      ['b', true],
      ['c', true],
      ['d', true],
    ]);
  });

  it('marks `...` as variadic and keeps the formals around it', () => {
    const params = byName(methods, 'dotted').parameters;
    expect(params.map((p) => [p.name, p.isOptional, p.isVariadic])).toEqual([
      ['amount', false, false],
      ['note', true, false],
      ['...', false, true],
    ]);
  });

  it('reads a method whose only formal is `...`', () => {
    expect(byName(methods, 'onlyDots').parameters).toEqual([
      { name: '...', type: null, isOptional: false, isVariadic: true },
    ]);
  });

  it('does not read the formals of a function used as a default value', () => {
    expect(byName(methods, 'fnDefault').parameters.map((p) => p.name)).toEqual(['f', 'y']);
  });

  it('reads private methods and active bindings the same way', () => {
    expect(byName(methods, 'hidden').parameters.map((p) => [p.name, p.isOptional])).toEqual([
      ['p', false],
      ['q', true],
    ]);
    expect(byName(methods, 'total').parameters.map((p) => p.name)).toEqual(['value']);
  });
});

describe('R method extractor: parameters of RefClass methods', () => {
  const methods = refClassMethods(`setRefClass("Acct", methods = list(
  none = function() 1,
  deposit = function(amount, note = "x") amount,
  all = function(x, ...) x
))`);

  it('reads no parameters from a method with no formals', () => {
    expect(byName(methods, 'none').parameters).toEqual([]);
  });

  it('reads required and defaulted parameters', () => {
    expect(byName(methods, 'deposit').parameters.map((p) => [p.name, p.isOptional])).toEqual([
      ['amount', false],
      ['note', true],
    ]);
  });

  it('marks `...` as variadic', () => {
    expect(byName(methods, 'all').parameters.map((p) => [p.name, p.isVariadic])).toEqual([
      ['x', false],
      ['...', true],
    ]);
  });
});

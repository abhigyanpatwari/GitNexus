/**
 * The R method extractor must name the owner of a method from the argument R would
 * match to the formal, not from "the first" or "the second" string-valued argument.
 *
 * - `setRefClass`: the class is the argument that takes the `Class` formal (by name,
 *   else the first unnamed one), so `contains = "Base"` ahead of `Class = "Acc"`
 *   never names the owner.
 * - `setMethod(f, signature, definition, where, valueClass, sealed)`: the owner is
 *   the `signature` argument. R matches named arguments first and fills the formals
 *   that remain from the unnamed ones, in order, so a named `where =` or `valueClass =`
 *   string must not be counted as the second string.
 */
import { describe, expect, it } from 'vitest';
import Parser from 'tree-sitter';
import R from '@eagleoutice/tree-sitter-r';
import { SupportedLanguages } from 'gitnexus-shared';
import {
  getRTopLevelMethodOwnerName,
  rMethodExtractor,
} from '../../src/core/ingestion/method-extractors/r.js';
import type { MethodExtractorContext } from '../../src/core/ingestion/method-types.js';

const parser = new Parser();
parser.setLanguage(R as Parameters<Parser['setLanguage']>[0]);
const context = {
  filePath: 'classes.R',
  language: SupportedLanguages.R,
} as unknown as MethodExtractorContext;

/** The only call to `callee` in `source`. */
function callTo(source: string, callee: string): Parser.SyntaxNode {
  const tree = parser.parse(source, undefined, { bufferSize: 1 << 24 });
  const calls = tree.rootNode
    .descendantsOfType('call')
    .filter((c) => c.childForFieldName('function')?.text === callee);
  expect(calls).toHaveLength(1);
  return calls[0];
}

const methodOwner = (source: string) =>
  getRTopLevelMethodOwnerName(callTo(source, 'setMethod') as never);

const refClassOwner = (source: string) =>
  rMethodExtractor.extract(callTo(source, 'setRefClass') as never, context)?.ownerName ?? null;

describe('R method extractor: setMethod owner is the signature argument', () => {
  it.each([
    ['positional', 'setMethod("show", "Foo", function(object) 1)'],
    ['all named', 'setMethod(f = "show", signature = "Foo", definition = function(object) 1)'],
    ['signature named first', 'setMethod(signature = "Foo", f = "show", function(object) 1)'],
    ['signature named, f positional', 'setMethod("show", signature = "Foo", function(object) 1)'],
    ['signature named before f', 'setMethod(signature = "Foo", "show", function(object) 1)'],
    ['f named, signature positional', 'setMethod(f = "show", "Foo", function(object) 1)'],
    ['f named after signature', 'setMethod("Foo", f = "show", function(object) 1)'],
    ['definition named', 'setMethod("show", "Foo", definition = function(object) 1)'],
    ['a named where= string between', 'setMethod("show", where = "pkg", "Foo", function(o) 1)'],
    [
      'a named valueClass= before signature=',
      'setMethod("show", valueClass = "x", signature = "Foo")',
    ],
    [
      'a named sealed= before the positional',
      'setMethod(sealed = "yes", "show", "Foo", function(o) 1)',
    ],
    ['backticked formal', 'setMethod("show", `signature` = "Foo", function(object) 1)'],
  ])('%s', (_label, source) => {
    expect(methodOwner(source)).toBe('Foo');
  });

  it.each([
    ['signature("A")', 'setMethod("show", signature("A"), function(object) 1)', 'A'],
    ['signature(name = "B")', 'setMethod("show", signature(object = "B"), function(o) 1)', 'B'],
    [
      'signature(x, y) uses the first class',
      'setMethod("f", signature("A", "B"), function(x, y) 1)',
      'A',
    ],
    ['c("A", "B")', 'setMethod("show", c("P2", "Q"), function(object) 1)', 'P2'],
    ['c(object = "A")', 'setMethod("show", c(object = "A"), function(object) 1)', 'A'],
    ['named signature = signature(...)', 'setMethod("show", signature = signature("A"))', 'A'],
    ['methods::signature(...)', 'setMethod("show", methods::signature("A"), function(o) 1)', 'A'],
  ])('takes the first class of a multi-class signature: %s', (_label, source, owner) => {
    expect(methodOwner(source)).toBe(owner);
  });

  it('names no owner when the signature is not a string or a literal signature call', () => {
    expect(methodOwner('setMethod("show", sig, function(object) 1)')).toBeNull();
    expect(methodOwner('setMethod("show", signature(cls), function(object) 1)')).toBeNull();
    expect(methodOwner('setMethod("show", signature(cls, "B"), function(object) 1)')).toBeNull();
    expect(methodOwner('setMethod("show", list("A"), function(object) 1)')).toBeNull();
    expect(methodOwner('setMethod("show", signature(), function(object) 1)')).toBeNull();
    expect(methodOwner('setMethod("show", where = "pkg")')).toBeNull();
  });
});

describe('R method extractor: setRefClass owner is the Class argument', () => {
  const METHODS = 'methods = list(m = function() 1)';

  it('uses the first unnamed argument (unchanged behaviour)', () => {
    expect(refClassOwner(`setRefClass("Acc", ${METHODS})`)).toBe('Acc');
  });

  it('does not name a contains= string that precedes Class= (the defect)', () => {
    expect(refClassOwner(`setRefClass(contains = "Base", Class = "Acc", ${METHODS})`)).toBe('Acc');
  });

  it('takes the first unnamed argument when contains= precedes it', () => {
    expect(refClassOwner(`setRefClass(contains = "Base", "Acc", ${METHODS})`)).toBe('Acc');
  });

  it('accepts the Class formal in backticks and finds it after the methods', () => {
    expect(refClassOwner(`setRefClass(${METHODS}, \`Class\` = "Acc")`)).toBe('Acc');
  });

  it('names no owner when the Class argument is not a string', () => {
    expect(refClassOwner(`setRefClass(contains = "Base", Class = cls, ${METHODS})`)).toBeNull();
  });
});

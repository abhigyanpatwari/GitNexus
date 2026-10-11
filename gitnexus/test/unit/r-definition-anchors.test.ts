/**
 * R_QUERIES captures every string argument of the S4 definition calls; the R
 * provider keeps only the one that names the definition
 * (`isRNonNamingArgumentCapture`, the provider's `shouldSkipDefinitionCapture`). Without that choice,
 * `setClass("A", contains = "VIRTUAL")` minted a Class `VIRTUAL`,
 * `setGeneric("f", valueClass = "numeric")` a Function `numeric`, and
 * `setMethod("show", "Foo", fn)` a Method `Foo`.
 *
 * These tests run the query and then the same selection the parse worker applies.
 * Each negative case is paired with the positive control that proves the same call
 * still yields its real definition, so a query that stops matching cannot pass.
 */
import { describe, expect, it } from 'vitest';
import Parser from 'tree-sitter';
import R from '@eagleoutice/tree-sitter-r';
import { R_QUERIES } from '../../src/core/ingestion/tree-sitter-queries.js';
import { isRNonNamingArgumentCapture } from '../../src/core/ingestion/languages/r/naming-argument.js';
import { parseSourceSafe } from '../../src/core/tree-sitter/safe-parse.js';
import { MAX_RATIO, SHAPES, measureScaling } from '../helpers/r-argument-scaling.js';

const language = R as Parameters<Parser['setLanguage']>[0];
const parser = new Parser();
parser.setLanguage(language);
const query = new Parser.Query(language, R_QUERIES);

type Capture = { name: string; node: Parser.SyntaxNode };

/**
 * Parse like production does: `parseSourceSafe` avoids the native binding's crash on
 * strings above 32 767 characters on Windows (the scaling group parses 100 K+ strings).
 */
const parseR = (source: string): Parser.Tree =>
  parseSourceSafe(parser, source, undefined, { bufferSize: 1 << 24 });

/** Matches the parse worker keeps: the provider's selection applied to the query's matches. */
function keptMatches(source: string | Parser.Tree): Capture[][] {
  const tree = typeof source === 'string' ? parseR(source) : source;
  const kept: Capture[][] = [];
  for (const match of query.matches(tree.rootNode)) {
    const captureMap: Record<string, Parser.SyntaxNode> = {};
    for (const c of match.captures) captureMap[c.name] = c.node;
    if (isRNonNamingArgumentCapture(captureMap)) continue;
    kept.push(match.captures);
  }
  return kept;
}

/** `definition.<kind>:<name>` for every definition match, in source order. */
function definitions(source: string): string[] {
  const out: string[] = [];
  for (const captures of keptMatches(source)) {
    const def = captures.find((c) => c.name.startsWith('definition.'));
    const name = captures.find((c) => c.name === 'name');
    if (def && name) out.push(`${def.name}:${name.node.text}`);
  }
  return out;
}

describe('R_QUERIES: setClass / setRefClass name only their first argument', () => {
  it('names the class from the first positional string (positive control)', () => {
    expect(definitions('setClass("A")')).toEqual(['definition.class:A']);
    expect(definitions('setRefClass("R")')).toEqual(['definition.class:R']);
  });

  it('does not mint a Class from contains = "VIRTUAL"', () => {
    expect(definitions('setClass("A", contains = "VIRTUAL")')).toEqual(['definition.class:A']);
  });

  it('does not mint a Class from a single-parent contains = "Base"', () => {
    expect(definitions('setRefClass("R", contains = "Base")')).toEqual(['definition.class:R']);
    expect(definitions('setClass("A", contains = "Base", slots = list(x = "numeric"))')).toEqual([
      'definition.class:A',
      'definition.property:x',
    ]);
  });

  it('does not mint a Class from a string positional inside representation()', () => {
    expect(definitions('setClass("A", representation("VIRTUAL", x = "numeric"))')).toEqual([
      'definition.class:A',
    ]);
  });

  it('does not mint a Class from other string-valued arguments', () => {
    expect(definitions('setClass("A", package = "pkg", sealed = "yes")')).toEqual([
      'definition.class:A',
    ]);
  });

  it('names the class from a first argument spelled Class =', () => {
    expect(definitions('setClass(Class = "A", contains = "VIRTUAL")')).toEqual([
      'definition.class:A',
    ]);
  });

  it('names the class from Class = even when it is not the first argument', () => {
    expect(definitions('setClass(contains = "VIRTUAL", Class = "A")')).toEqual([
      'definition.class:A',
    ]);
  });

  it('keeps slots / fields / representation properties', () => {
    expect(definitions('setClass("A", slots = list(x = "numeric", y = "character"))')).toEqual([
      'definition.class:A',
      'definition.property:x',
      'definition.property:y',
    ]);
    expect(definitions('setRefClass("R", fields = list(n = "numeric"))')).toEqual([
      'definition.class:R',
      'definition.property:n',
    ]);
    expect(definitions('setClass("A", representation = representation(z = "numeric"))')).toEqual([
      'definition.class:A',
      'definition.property:z',
    ]);
  });
});

describe('R_QUERIES: setGeneric names only its first argument', () => {
  it('names the generic from the first positional string (positive control)', () => {
    expect(definitions('setGeneric("f", function(x) standardGeneric("f"))')).toEqual([
      'definition.function:f',
    ]);
  });

  it('does not mint a Function from valueClass = "numeric"', () => {
    expect(
      definitions('setGeneric("f", function(x) standardGeneric("f"), valueClass = "numeric")'),
    ).toEqual(['definition.function:f']);
  });

  it('names the generic from name = "f"', () => {
    expect(
      definitions('setGeneric(name = "f", def = function(x) standardGeneric("f"), package = "p")'),
    ).toEqual(['definition.function:f']);
  });
});

describe('R_QUERIES: setMethod names only its first argument', () => {
  it('names the method from the first positional string (positive control)', () => {
    expect(definitions('setMethod("area", signature("Circle"), function(obj) 1)')).toEqual([
      'definition.method:area',
    ]);
  });

  it('does not mint a Method from the class-name string in the signature slot', () => {
    expect(definitions('setMethod("show", "Foo", function(object) cat("x"))')).toEqual([
      'definition.method:show',
    ]);
  });

  it('names the method from f = "show"', () => {
    expect(
      definitions('setMethod(f = "show", signature = "Foo", definition = function(object) 1)'),
    ).toEqual(['definition.method:show']);
  });
});

describe('R_QUERIES: comments between the parenthesis and an argument do not defeat the anchor', () => {
  it('names a class when a comment precedes the first argument', () => {
    expect(definitions('setClass(\n  # the class\n  "A", contains = "VIRTUAL")')).toEqual([
      'definition.class:A',
    ]);
    expect(definitions('setRefClass(\n  # one\n  # two\n  "R", contains = "Base")')).toEqual([
      'definition.class:R',
    ]);
  });

  it('names a generic when a comment precedes the first argument', () => {
    expect(
      definitions(
        'setGeneric(\n  # the generic\n  "f", function(x) standardGeneric("f"), valueClass = "numeric")',
      ),
    ).toEqual(['definition.function:f']);
  });

  it('names a method when a comment precedes the first argument', () => {
    expect(definitions('setMethod(\n  # the method\n  "show", "Foo", function(object) 1)')).toEqual(
      ['definition.method:show'],
    );
  });

  it('still ignores a later string argument when a comment sits between the arguments', () => {
    expect(definitions('setClass("A", # note\n  "B")')).toEqual(['definition.class:A']);
    expect(definitions('setMethod("show", # note\n  "Foo", function(object) 1)')).toEqual([
      'definition.method:show',
    ]);
  });
});

describe('R_QUERIES: the first unnamed argument is the name when named arguments precede it', () => {
  it('names a method from the first unnamed argument after signature =', () => {
    expect(definitions('setMethod(signature = "Foo", "show", function(object) 1)')).toEqual([
      'definition.method:show',
    ]);
  });

  it('names a class from the first unnamed argument after a named representation', () => {
    expect(
      definitions(
        'setClass(representation = representation(x = "numeric"), "A", contains = "V")',
      ).sort(),
    ).toEqual(['definition.class:A', 'definition.property:x']);
  });

  it('names a generic from the first unnamed argument after a named argument', () => {
    expect(
      definitions('setGeneric(valueClass = "numeric", "f", function(x) standardGeneric("f"))'),
    ).toEqual(['definition.function:f']);
  });

  it('does not name a second unnamed argument', () => {
    expect(definitions('setClass("A", "B")')).toEqual(['definition.class:A']);
    // The first unnamed argument is the representation() call, so "B" is not the name.
    expect(definitions('setClass(representation(x = "numeric"), "B")')).toEqual([]);
  });

  it('does not take the class slot as a name when the formal is given by name', () => {
    expect(definitions('setMethod(f = "show", "Foo", function(object) 1)')).toEqual([
      'definition.method:show',
    ]);
    expect(definitions('setClass(Class = "A", "B")')).toEqual(['definition.class:A']);
    expect(definitions('setGeneric(name = "f", "g")')).toEqual(['definition.function:f']);
  });
});

describe('R naming argument: a backticked or quoted formal names the definition', () => {
  it('names a class from `Class` =, "Class" = and \'Class\' =', () => {
    expect(definitions('setClass(`Class` = "A", contains = "B")')).toEqual(['definition.class:A']);
    expect(definitions('setClass("Class" = "A", contains = "B")')).toEqual(['definition.class:A']);
    expect(definitions("setRefClass('Class' = 'R', contains = 'B')")).toEqual([
      'definition.class:R',
    ]);
  });

  it('names a generic from `name` = and a method from `f` =', () => {
    expect(
      definitions(
        'setGeneric(`name` = "f", def = function(x) standardGeneric("f"), valueClass = "n")',
      ),
    ).toEqual(['definition.function:f']);
    expect(definitions('setMethod(`f` = "show", signature = "Foo", definition = 1)')).toEqual([
      'definition.method:show',
    ]);
  });

  it('does not take a later unnamed string once the formal is given in backticks', () => {
    expect(definitions('setClass(`Class` = "A", "B")')).toEqual(['definition.class:A']);
  });

  it('still ignores a backticked name that is not the formal', () => {
    expect(definitions('setClass("A", `contains` = "B")')).toEqual(['definition.class:A']);
  });
});

describe('R naming argument: a later Class = retracts an earlier unnamed argument', () => {
  it('setClass(a = "Q", "B", Class = "A") defines A only', () => {
    expect(definitions('setClass(a = "Q", "B", Class = "A")')).toEqual(['definition.class:A']);
  });

  it('retracts for every formal that names a definition', () => {
    expect(definitions('setRefClass("B", Class = "A")')).toEqual(['definition.class:A']);
    expect(definitions('setGeneric("g", name = "f", valueClass = "n")')).toEqual([
      'definition.function:f',
    ]);
    expect(definitions('setMethod("g", f = "show", signature = "Foo")')).toEqual([
      'definition.method:show',
    ]);
  });

  it('retracts through comments, backticks and quotes', () => {
    expect(definitions('setClass("B", # c\n `Class` = "A")')).toEqual(['definition.class:A']);
    expect(definitions('setClass("B", "Class" = "A")')).toEqual(['definition.class:A']);
  });

  it('keeps the first unnamed argument when no named argument spells the formal', () => {
    expect(definitions('setClass(a = "Q", "B", contains = "A")')).toEqual(['definition.class:B']);
    expect(definitions('setClass("B", "A")')).toEqual(['definition.class:B']);
  });
});

/**
 * Selecting the naming argument must stay linear in the argument count: an earlier
 * query-level formulation (a repeated sibling group before the argument) was
 * quadratic and took seconds on a single call with thousands of arguments. The same
 * work is run at two sizes and the time ratio is bounded (see
 * `helpers/r-argument-scaling.ts`); the kept matches are asserted at both sizes.
 */
describe('R_QUERIES: cost is linear in the argument count', () => {
  /** Parsing is set-up (untimed); the timed work is the query plus the provider's selection. */
  const run = (source: string) => {
    const tree = parseR(source);
    return () => {
      const kept = keptMatches(tree);
      const defs: string[] = [];
      for (const captures of kept) {
        const def = captures.find((c) => c.name.startsWith('definition.'));
        const name = captures.find((c) => c.name === 'name');
        if (def && name) defs.push(`${def.name}:${name.node.text}`);
      }
      return { count: kept.length, defs };
    };
  };

  const cases = [
    { shape: SHAPES.listNamedArguments, expected: { count: 1, defs: [] } },
    { shape: SHAPES.setClassNamedBefore, expected: { count: 2, defs: ['definition.class:A'] } },
    { shape: SHAPES.setClassCommentsBefore, expected: { count: 2, defs: ['definition.class:A'] } },
    { shape: SHAPES.setClassUnnamedStrings, expected: { count: 2, defs: ['definition.class:s0'] } },
    { shape: SHAPES.setClassNamedStrings, expected: { count: 2, defs: ['definition.class:A'] } },
  ] as const;

  it.each(cases)(
    '$shape.name',
    ({ shape, expected }) => {
      const { small, large, ratio } = measureScaling(run, shape.build);
      expect(small).toEqual(expected);
      expect(large).toEqual(expected);
      expect(ratio).toBeLessThan(MAX_RATIO);
    },
    120_000,
  );
});

/**
 * R scope query: only the argument that names a class or an import yields
 * `@declaration.name` / `@import.source`. The query captures every candidate
 * argument; `emitRScopeCaptures` drops the rest. Each negative is paired with a
 * positive control, and a scaling group guards the cost against a quadratic
 * regression (an argument-prefix pattern in the query was quadratic in the number
 * of leading comments and named arguments).
 */
import { describe, expect, it } from 'vitest';
import { emitRScopeCaptures } from '../../src/core/ingestion/languages/r/captures.js';
import { MAX_RATIO, SHAPES, measureScaling } from '../helpers/r-argument-scaling.js';

function tagTexts(source: string, tag: string): string[] {
  return emitRScopeCaptures(source, 'fixture.R')
    .map((m) => m[tag]?.text)
    .filter((t): t is string => t !== undefined);
}

const importSources = (source: string) => tagTexts(source, '@import.source');
/**
 * Every class declared by the scope query. Selected by capture kind (the match carries
 * `@declaration.class`), not by spelling, so a lowercase class or a wrongly captured
 * lowercase string is visible.
 */
const classNames = (source: string) =>
  emitRScopeCaptures(source, 'fixture.R')
    .filter((m) => m['@declaration.class'] !== undefined)
    .map((m) => m['@declaration.name']?.text)
    .filter((t): t is string => t !== undefined);

describe('R scope query: imports name only their first argument', () => {
  it('imports the first argument (positive controls)', () => {
    expect(importSources('library(pkg)')).toEqual(['pkg']);
    expect(importSources('require("pkg")')).toEqual(['"pkg"']);
    expect(importSources('source("a.R")')).toEqual(['"a.R"']);
  });

  it('does not import a later argument', () => {
    expect(importSources('library(pkg, lib.loc = lib)')).toEqual(['pkg']);
    expect(importSources('source("a.R", local = env)')).toEqual(['"a.R"']);
    expect(importSources('require(pkg, quietly = "yes")')).toEqual(['pkg']);
  });

  it('imports the first unnamed argument after named arguments', () => {
    expect(importSources('library(character.only = TRUE, pkg)')).toEqual(['pkg']);
    expect(importSources('library(lib.loc = lib, pkg)')).toEqual(['pkg']);
    expect(importSources('source(local = env, "a.R")')).toEqual(['"a.R"']);
  });

  it('imports the argument named by package = / file =', () => {
    expect(importSources('library(package = pkg)')).toEqual(['pkg']);
    expect(importSources('source(file = "a.R")')).toEqual(['"a.R"']);
    expect(importSources('library(package = pkg, "other")')).toEqual(['pkg']);
  });

  it('does not import an unnamed argument once a later argument is spelled package = / file =', () => {
    expect(importSources('library("other", package = pkg)')).toEqual(['pkg']);
    expect(importSources('source("b.R", local = env, file = "a.R")')).toEqual(['"a.R"']);
  });

  it('imports the first argument when a comment precedes it', () => {
    expect(importSources('library(\n  # the package\n  pkg, lib.loc = lib)')).toEqual(['pkg']);
    expect(importSources('source(\n  # c\n  "a.R", local = env)')).toEqual(['"a.R"']);
  });
});

describe('R scope query: setClass declares only its naming argument', () => {
  it('declares the class from the first argument (positive control)', () => {
    expect(classNames('setClass("A", contains = "VIRTUAL")')).toEqual(['A']);
    expect(classNames('setRefClass("R", contains = "Base")')).toEqual(['R']);
  });

  it('declares a lowercase class name (positive controls)', () => {
    expect(classNames('setClass("a", contains = "VIRTUAL")')).toEqual(['a']);
    expect(classNames('setRefClass("r")')).toEqual(['r']);
    expect(classNames('setClass(Class = "a")')).toEqual(['a']);
  });

  it('does not declare a lowercase class from a non-naming argument', () => {
    expect(classNames('setClass("A", contains = "numeric")')).toEqual(['A']);
    expect(classNames('setRefClass("R", contains = "base")')).toEqual(['R']);
    expect(classNames('setClass("a", contains = "numeric", package = "pkg")')).toEqual(['a']);
    expect(classNames('setClass("A", representation("numeric", x = "character"))')).toEqual(['A']);
  });

  it('declares only Class = when it follows an unnamed argument', () => {
    expect(classNames('setClass(a = "Q", "B", Class = "A")')).toEqual(['A']);
    expect(classNames('setRefClass("B", Class = "A")')).toEqual(['A']);
  });

  it('declares the class when a comment precedes it', () => {
    expect(classNames('setClass(\n  # doc\n  "A", contains = "VIRTUAL")')).toEqual(['A']);
  });

  it('declares the class from Class = after a named contains =', () => {
    expect(classNames('setClass(contains = "Base", Class = "A")')).toEqual(['A']);
    expect(classNames('setClass(representation = representation(x = "numeric"), "A")')).toEqual([
      'A',
    ]);
  });
});

describe('R scope query: cost is linear in the argument count', () => {
  /** What the query kept: the match count and the naming captures, in source order. */
  const run = (source: string) => () => {
    const matches = emitRScopeCaptures(source, 'fixture.R');
    const naming: string[] = [];
    for (const m of matches) {
      for (const tag of ['@declaration.name', '@import.source']) {
        const text = m[tag]?.text;
        if (text !== undefined) naming.push(`${tag}=${text}`);
      }
    }
    return { count: matches.length, naming };
  };

  // Every shape keeps exactly one naming capture regardless of the argument count: the
  // count and the name are asserted at both sizes, so an early-return or empty parse
  // cannot pass as "fast".
  const cases = [
    { shape: SHAPES.listNamedArguments, expected: { count: 2, naming: [] } },
    { shape: SHAPES.setClassNamedBefore, expected: { count: 4, naming: ['@declaration.name=A'] } },
    { shape: SHAPES.libraryNamedBefore, expected: { count: 3, naming: ['@import.source=pkg'] } },
    {
      shape: SHAPES.setClassCommentsBefore,
      expected: { count: 4, naming: ['@declaration.name=A'] },
    },
    { shape: SHAPES.libraryCommentsBefore, expected: { count: 3, naming: ['@import.source=pkg'] } },
    {
      shape: SHAPES.setClassUnnamedStrings,
      expected: { count: 4, naming: ['@declaration.name=s0'] },
    },
    {
      shape: SHAPES.libraryUnnamedStrings,
      expected: { count: 3, naming: ['@import.source="s0"'] },
    },
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

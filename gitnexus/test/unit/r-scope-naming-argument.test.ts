/**
 * R scope query: only the argument that names a class or an import yields
 * `@declaration.name` / `@import.source`. The query captures every candidate
 * argument; `emitRScopeCaptures` drops the rest. Each negative is paired with a
 * positive control, and a bounded-time group guards the cost against a quadratic
 * regression (an argument-prefix pattern in the query was quadratic in the number
 * of leading comments and named arguments).
 */
import { describe, expect, it } from 'vitest';
import { emitRScopeCaptures } from '../../src/core/ingestion/languages/r/captures.js';

function tagTexts(source: string, tag: string): string[] {
  return emitRScopeCaptures(source, 'fixture.R')
    .map((m) => m[tag]?.text)
    .filter((t): t is string => t !== undefined);
}

const importSources = (source: string) => tagTexts(source, '@import.source');
const classNames = (source: string) =>
  tagTexts(source, '@declaration.name').filter((t) => /^[A-Z]/.test(t));

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
  const LIMIT_MS = 2500;
  const N = 16000;
  const named = (n: number) => Array.from({ length: n }, (_, k) => `a${k} = ${k}`).join(', ');
  const timed = (source: string) => {
    const start = Date.now();
    const matches = emitRScopeCaptures(source, 'fixture.R').length;
    return { ms: Date.now() - start, matches };
  };

  it('one call with many named arguments', () => {
    expect(timed(`x <- list(${named(N)})`).ms).toBeLessThan(LIMIT_MS);
  });

  it('setClass and library with many named arguments before the name', () => {
    expect(timed(`setClass(${named(N / 2)}, "A")`).ms).toBeLessThan(LIMIT_MS);
    expect(timed(`library(${named(N / 2)}, pkg)`).ms).toBeLessThan(LIMIT_MS);
  });

  it('setClass and library with many comments before the name', () => {
    const comments = Array.from({ length: N / 2 }, (_, k) => `# c${k}`).join('\n');
    expect(timed(`setClass(\n${comments}\n"A")`).ms).toBeLessThan(LIMIT_MS);
    expect(timed(`library(\n${comments}\npkg)`).ms).toBeLessThan(LIMIT_MS);
  });

  it('setClass and library with many unnamed arguments', () => {
    const strings = Array.from({ length: N }, (_, k) => `"s${k}"`).join(', ');
    expect(timed(`setClass(${strings})`).ms).toBeLessThan(LIMIT_MS);
    expect(timed(`library(${strings})`).ms).toBeLessThan(LIMIT_MS);
  });
});

/**
 * The names a function binds without a definition (formals, `for` variables) are published on its
 * scope as lexical names, which stop a call through them from reaching a top-level function of the
 * same name. This pins what is read from the tree and what is not.
 */
import { describe, expect, it } from 'vitest';
import Parser from 'tree-sitter';
import R from '@eagleoutice/tree-sitter-r';
import { rFunctionLexicalNames } from '../../../../src/core/ingestion/languages/r/captures.js';
import { extractParsedFile } from '../../../../src/core/ingestion/scope-extractor-bridge.js';
import { rProvider } from '../../../../src/core/ingestion/languages/r.js';

const parser = new Parser();
parser.setLanguage(R as Parameters<Parser['setLanguage']>[0]);

/** Lexical names of the first function_definition in `source`. */
function namesOf(source: string): string[] {
  const tree = parser.parse(source, undefined, { bufferSize: 1 << 24 });
  const fn = tree.rootNode.descendantsOfType('function_definition')[0];
  return rFunctionLexicalNames(fn as never).sort();
}

describe('rFunctionLexicalNames', () => {
  it('reads the named formals, with and without defaults, and not the dots', () => {
    expect(namesOf('f <- function(data, g = function(z) z, h = make(), ...) 1')).toEqual([
      'data',
      'g',
      'h',
    ]);
    expect(namesOf('f <- function() 1')).toEqual([]);
  });

  it('skips a formal with a constant default that the body never assigns', () => {
    expect(namesOf('f <- function(a, n = 2, s = "x", b = TRUE, z = NULL, m = -1) 1')).toEqual([
      'a',
    ]);
    // Assigned in the body, the formal may hold a function again.
    expect(namesOf('f <- function(a, n = 2) { n <- identity; n(a) }')).toEqual(['a', 'n']);
    // A constant-default formal that a loop also binds is a loop variable.
    expect(namesOf('f <- function(n = 2) for (n in 1:3) n')).toEqual(['n']);
  });

  it('keeps a backticked formal as written', () => {
    expect(namesOf('f <- function(`my fn`, b) 1')).toEqual(['`my fn`', 'b']);
  });

  it('reads the variable of a for loop anywhere in the body', () => {
    expect(
      namesOf(
        'f <- function(a) {\n  for (i in a) g(i)\n  if (a) { for (j in 1:3) { for (k in j) k } }\n}',
      ),
    ).toEqual(['a', 'i', 'j', 'k']);
  });

  it('leaves the loop variables and formals of a nested function to that function', () => {
    const source = 'f <- function(a) {\n  h <- function(b) { for (z in b) z }\n  a\n}';
    expect(namesOf(source)).toEqual(['a']);
  });

  it('does not read a for loop outside every function', () => {
    const tree = parser.parse('for (i in 1:3) f(i)\n', undefined, { bufferSize: 1 << 24 });
    expect(tree.rootNode.descendantsOfType('function_definition')).toHaveLength(0);
  });

  it('reads a function nested 500 deep without recursing', () => {
    const body = '{ for (i in 1) '.repeat(500) + '1' + ' }'.repeat(500);
    expect(namesOf(`f <- function(a) ${body}`)).toEqual(['a', 'i']);
  });
});

describe('the function scope publishes them as lexicalNames', () => {
  it('puts the formals and loop variables on the function_definition scope only', () => {
    const file = extractParsedFile(
      rProvider,
      'transform <- function(x) x\nrun <- function(data, transform) {\n  for (cb in data) cb(1)\n  transform(data)\n}\nplain <- function() 1\n',
      'R/a.R',
    );
    if (file === undefined) throw new Error('no ParsedFile');
    const named = file.scopes
      .filter((s) => s.kind === 'Function' && s.lexicalNames !== undefined)
      .map((s) => [...(s.lexicalNames ?? [])].sort());
    expect(named).toEqual([['x'], ['cb', 'data', 'transform']]);
  });
});

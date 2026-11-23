/**
 * R6 `public =` / `private =` list() entries become Property definitions for every
 * value that is not a function (functions are methods). The query used to enumerate
 * only some of the grammar's expression kinds, so `list(x = NA)` or
 * `list(x = if (ready) 1 else 2)` created no Property although RFieldExtractor
 * accepts any non-function value. These tests run the query itself, for both the
 * `R6::R6Class` and the bare `R6Class` forms.
 */
import { describe, expect, it } from 'vitest';
import Parser from 'tree-sitter';
import R from '@eagleoutice/tree-sitter-r';
import { R_QUERIES } from '../../src/core/ingestion/tree-sitter-queries.js';

const language = R as Parameters<Parser['setLanguage']>[0];
const parser = new Parser();
parser.setLanguage(language);
const query = new Parser.Query(language, R_QUERIES);

/** Names of every `definition.property` the query captures, in source order. */
function properties(source: string): string[] {
  const tree = parser.parse(source);
  const out: string[] = [];
  for (const match of query.matches(tree.rootNode)) {
    const def = match.captures.find((c) => c.name === 'definition.property');
    const name = match.captures.find((c) => c.name === 'name');
    if (def && name) out.push(name.node.text);
  }
  return out;
}

const FORMS: Record<string, (body: string) => string> = {
  bare: (body) => `X <- R6Class("X", public = list(${body}))`,
  namespaced: (body) => `X <- R6::R6Class("X", public = list(${body}))`,
  private: (body) => `X <- R6Class("X", private = list(${body}))`,
};

// One value per grammar expression kind that can start an R expression, except
// function_definition (a method, not a field).
const VALUES: Record<string, string> = {
  string: '"a"',
  integer: '1L',
  float: '1.5',
  complex: '2i',
  true: 'TRUE',
  false: 'FALSE',
  null: 'NULL',
  na: 'NA',
  na_character: 'NA_character_',
  inf: 'Inf',
  nan: 'NaN',
  identifier: 'y',
  call: 'g()',
  unary_operator: '-1',
  binary_operator: '1 + 2',
  if_statement: 'if (ready) 1 else 2',
  parenthesized_expression: '(1)',
  extract_operator: 'a$b',
  namespace_operator: 'pkg::value',
  subset: 'v[1]',
  subset2: 'v[[1]]',
  braced_expression: '{ 1 }',
  for_statement: 'for (i in 1:2) i',
  while_statement: 'while (FALSE) 1',
  repeat_statement: 'repeat break',
};

describe('R6 field values of every expression kind create a Property', () => {
  for (const [formName, wrap] of Object.entries(FORMS)) {
    for (const [kind, value] of Object.entries(VALUES)) {
      it(`${formName}: ${kind} (${value})`, () => {
        expect(properties(wrap(`x = ${value}`))).toEqual(['x']);
      });
    }
  }

  it('still treats function values as methods, not fields', () => {
    expect(properties('X <- R6Class("X", public = list(m = function() 1, f = 2))')).toEqual(['f']);
    expect(properties('X <- R6Class("X", public = list(m = \\() 1, f = 2))')).toEqual(['f']);
    expect(properties('X <- R6::R6Class("X", public = list(m = function() 1, f = NA))')).toEqual([
      'f',
    ]);
  });
});

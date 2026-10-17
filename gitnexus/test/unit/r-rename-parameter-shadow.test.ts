/**
 * A parameter named like a function shadows a CALL of that name only when it holds a function:
 * R skips a non-function binding when it looks up the callee of `f(x)`. A rename therefore
 *
 *  - leaves the call alone for a parameter without a default (it is called, so it is a function);
 *  - renames the call for a parameter whose default is a constant (the call reaches the global);
 *  - refuses when the parameter may hold a function (a function or computed default, or an
 *    assignment to it in the body), because the call may reach either.
 */
import { describe, expect, it } from 'vitest';
import Parser from 'tree-sitter';
import R from '@eagleoutice/tree-sitter-r';
import { rParameterKind, rRenameProvider } from '../../src/core/ingestion/languages/r/rename.js';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';

const parser = new Parser();
parser.setLanguage(R as Parameters<Parser['setLanguage']>[0]);

/** The kind of the first parameter named `helper` in `source`. */
function kindOf(source: string): string | null {
  const stack = [parser.parse(source).rootNode];
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    if (
      node.type === 'identifier' &&
      node.text.replaceAll('`', '') === 'helper' &&
      node.parent?.type === 'parameter'
    ) {
      return rParameterKind(node);
    }
    stack.push(...node.namedChildren);
  }
  throw new Error('no parameter named helper');
}

function verdict(source: string): string {
  const files = new Map([['a.R', { tree: parser.parse(source), parsed: { localDefs: [] } }]]);
  const issue = rRenameProvider.checkSafety?.({
    target: { type: 'Function', qualifiedName: 'helper', filePath: 'a.R' },
    newName: 'assist',
    files,
    graph: createKnowledgeGraph(),
  } as never);
  return issue ? issue.code : 'ok';
}

describe('rParameterKind', () => {
  it('treats a parameter without a default as a function it is called as', () => {
    expect(kindOf('use <- function(x, helper) helper(x)')).toBe('function');
  });

  it.each([
    '2',
    '2L',
    '1i',
    '"s"',
    'TRUE',
    'FALSE',
    'NULL',
    'NA',
    'NA_integer_',
    'Inf',
    'NaN',
    '-1',
  ])('treats the constant default %s as not a function', (constant) => {
    expect(kindOf(`use <- function(x, helper = ${constant}) helper(x)`)).toBe('constant');
  });

  it.each(['function(z) z', '\\(z) z', 'identity', 'c(1, 2)', 'x + 1', 'list()'])(
    'treats the default %s as possibly a function',
    (expression) => {
      expect(kindOf(`use <- function(x, helper = ${expression}) helper(x)`)).toBe('maybe');
    },
  );

  it('treats a parameter that the body assigns as possibly a function', () => {
    expect(kindOf('use <- function(x, helper = 2) { helper <- identity; helper(x) }')).toBe(
      'maybe',
    );
    expect(kindOf('use <- function(x, helper = 2) { identity -> helper; helper(x) }')).toBe(
      'maybe',
    );
    expect(kindOf('use <- function(x, helper) { for (helper in fs) helper(x) }')).toBe('maybe');
  });

  it('ignores an assignment in a nested function, which binds its own variable', () => {
    expect(kindOf('use <- function(x, helper = 2) { g <- function() { helper <- 1 }; x }')).toBe(
      'constant',
    );
  });

  it('reads a backticked parameter and a lambda', () => {
    expect(kindOf('use <- function(x, `helper` = 2) x')).toBe('constant');
    expect(kindOf('use <- \\(x, helper = 2) x')).toBe('constant');
  });

  it('is null for an identifier that is not a parameter name', () => {
    const tree = parser.parse('helper(1)');
    const callee = tree.rootNode.descendantForIndex(0);
    expect(rParameterKind(callee)).toBeNull();
  });
});

describe('R rename: a call that a same-named parameter may or may not shadow', () => {
  it('refuses a call under a parameter with a function default', () => {
    expect(verdict('use <- function(x, helper = function(z) z) { helper(x) }')).toBe(
      'ambiguous_reference',
    );
  });

  it('refuses a call under a parameter with a computed default', () => {
    expect(verdict('use <- function(x, helper = pick()) { helper(x) }')).toBe(
      'ambiguous_reference',
    );
  });

  it('refuses a call under a parameter that the body assigns', () => {
    expect(verdict('use <- function(x, helper = 2) { helper <- identity; helper(x) }')).toBe(
      'ambiguous_reference',
    );
  });

  it('refuses a piped call and a call in another parameter default', () => {
    expect(verdict('use <- function(x, helper = f) x |> helper()')).toBe('ambiguous_reference');
    expect(verdict('use <- function(helper = f, y = helper(1)) y')).toBe('ambiguous_reference');
  });

  it('finds the innermost function that binds the name', () => {
    expect(verdict('use <- function(helper = f) { g <- function(helper = 1) helper(2) }')).toBe(
      'ok',
    );
    expect(verdict('use <- function(helper = 1) { g <- function(helper = f) helper(2) }')).toBe(
      'ambiguous_reference',
    );
  });

  it('allows a call under a constant-default or default-less parameter, and a bare read', () => {
    expect(verdict('use <- function(x, helper = 2) { helper(x) }')).toBe('ok');
    expect(verdict('use <- function(x, helper) { helper(x) }')).toBe('ok');
    expect(verdict('use <- function(x, helper = function(z) z) { x + helper }')).toBe('ok');
  });

  it('allows a call to the name when no parameter carries it', () => {
    expect(verdict('use <- function(x, other = function(z) z) { helper(x) }')).toBe('ok');
    expect(verdict('helper(1)')).toBe('ok');
  });
});

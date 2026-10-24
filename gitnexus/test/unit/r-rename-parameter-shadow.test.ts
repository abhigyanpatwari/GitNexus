/**
 * A default proves nothing about the value a caller passes, so a parameter named like a function
 * shadows a CALL of that name whenever it exists: `function(x, helper = 2) helper(x)` reaches the
 * parameter when the caller passes a function and the outer function when it does not. A rename
 * therefore refuses (`ambiguous_reference`) any call under a same-named parameter, whatever the
 * default, and a new name that a parameter carries and calls is a collision (`name_collision`).
 */
import { describe, expect, it } from 'vitest';
import Parser from 'tree-sitter';
import R from '@eagleoutice/tree-sitter-r';
import { isRParameterName, rRenameProvider } from '../../src/core/ingestion/languages/r/rename.js';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';

const parser = new Parser();
parser.setLanguage(R as Parameters<Parser['setLanguage']>[0]);

/** Whether the first parameter named `helper` in `source` is read as a parameter name. */
function isParameter(source: string): boolean {
  const stack = [parser.parse(source).rootNode];
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    if (
      node.type === 'identifier' &&
      node.text.replaceAll('`', '') === 'helper' &&
      node.parent?.type === 'parameter'
    ) {
      return isRParameterName(node);
    }
    stack.push(...node.namedChildren);
  }
  throw new Error('no parameter named helper');
}

function verdict(source: string, newName = 'assist', name = 'helper'): string {
  const files = new Map([['a.R', { tree: parser.parse(source), parsed: { localDefs: [] } }]]);
  const issue = rRenameProvider.checkSafety?.({
    target: { type: 'Function', qualifiedName: name, filePath: 'a.R' },
    newName,
    files,
    graph: createKnowledgeGraph(),
  } as never);
  return issue ? issue.code : 'ok';
}

describe('isRParameterName', () => {
  it.each([
    'use <- function(x, helper) helper(x)',
    'use <- function(x, helper = 2) helper(x)',
    'use <- function(x, helper = NULL) helper(x)',
    'use <- function(x, helper = function(z) z) helper(x)',
    'use <- function(x, `helper` = 2) x',
    'use <- \\(x, helper = 2) x',
  ])('is true for the name of a parameter in %s, whatever its default', (source) => {
    expect(isParameter(source)).toBe(true);
  });

  it('is false for an identifier that is not a parameter name', () => {
    const tree = parser.parse('helper(1)');
    const callee = tree.rootNode.descendantForIndex(0);
    expect(isRParameterName(callee)).toBe(false);
  });

  it('is false for a parameter default that spells the name', () => {
    const tree = parser.parse('use <- function(x = helper) x');
    const read = tree.rootNode.descendantsOfType('identifier').find((n) => n.text === 'helper');
    if (read === undefined) throw new Error('no read');
    expect(isRParameterName(read)).toBe(false);
  });
});

describe('R rename: a call that a same-named parameter may or may not shadow', () => {
  it('refuses a call under a parameter with a function default', () => {
    expect(verdict('use <- function(x, helper = function(z) z) { helper(x) }')).toBe(
      'ambiguous_reference',
    );
  });

  it('refuses a call under a parameter that defaults to NULL: it can hold a callback', () => {
    expect(verdict('use <- function(x, helper = NULL) { helper(x) }')).toBe('ambiguous_reference');
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
      'ambiguous_reference',
    );
    expect(verdict('use <- function(helper = f) { g <- function(other = 1) helper(2) }')).toBe(
      'ambiguous_reference',
    );
    expect(verdict('use <- function(other = f) { g <- function(other = 1) helper(2) }')).toBe('ok');
    expect(verdict('use <- function(helper = 1) { g <- function(helper = f) helper(2) }')).toBe(
      'ambiguous_reference',
    );
  });

  it('refuses a call under a constant-default or default-less parameter', () => {
    expect(verdict('use <- function(x, helper = 2) { helper(x) }')).toBe('ambiguous_reference');
    expect(verdict('use <- function(x, helper) { helper(x) }')).toBe('ambiguous_reference');
    expect(verdict('use <- function(x, helper = "s") x |> helper()')).toBe('ambiguous_reference');
  });

  it('allows a bare read of a parameter named like the function', () => {
    expect(verdict('use <- function(x, helper = function(z) z) { x + helper }')).toBe('ok');
    expect(verdict('use <- function(x, helper) { x + helper }')).toBe('ok');
  });

  it('allows a call to the name when no parameter carries it', () => {
    expect(verdict('use <- function(x, other = function(z) z) { helper(x) }')).toBe('ok');
    expect(verdict('helper(1)')).toBe('ok');
  });
});

describe('R rename: a new name that a parameter carries', () => {
  it('collides when the parameter is called: a non-function argument reaches the global', () => {
    expect(verdict('use <- function(x, assist) { assist(x) }')).toBe('name_collision');
    expect(verdict('use <- function(x, assist = 2) { assist(x) }')).toBe('name_collision');
    expect(verdict('use <- function(x, assist = f) x |> assist()')).toBe('name_collision');
  });

  it('is not a collision when the parameter is only read, or only named', () => {
    expect(verdict('use <- function(x, assist) { assist * 2 }')).toBe('ok');
    expect(verdict('use <- function(x, assist) x')).toBe('ok');
  });
});

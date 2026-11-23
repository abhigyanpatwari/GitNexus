/**
 * The R rename provider refuses a function that the sources also assign with `<<-` or `->>`,
 * inside a function or at top level: the global re-assignment is a second definition of the same
 * name that a rename would leave behind, so the renamed function would be replaced by a new
 * global of the old name at run time. Each refusal is paired with a local assignment, which
 * creates no global.
 */
import { describe, expect, it } from 'vitest';
import Parser from 'tree-sitter';
import R from '@eagleoutice/tree-sitter-r';
import { rRenameProvider } from '../../src/core/ingestion/languages/r/rename.js';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';

const parser = new Parser();
parser.setLanguage(R as Parameters<Parser['setLanguage']>[0]);

function verdict(source: string, targetName = 'helper'): string {
  const files = new Map([['a.R', { tree: parser.parse(source), parsed: { localDefs: [] } }]]);
  const issue = rRenameProvider.checkSafety?.({
    target: { type: 'Function', qualifiedName: targetName, filePath: 'a.R' },
    newName: 'assist',
    files,
    graph: createKnowledgeGraph(),
  } as never);
  return issue ? issue.code : 'ok';
}

describe('R rename: a superassignment to the function name', () => {
  it('refuses <<- inside a function', () => {
    expect(verdict('install <- function() { helper <<- function(z) z }')).toBe(
      'ambiguous_reference',
    );
  });

  it('refuses ->> inside a function', () => {
    expect(verdict('install <- function() { function(z) z ->> helper }')).toBe(
      'ambiguous_reference',
    );
  });

  it('refuses the top-level form too', () => {
    expect(verdict('helper <<- function(z) z')).toBe('ambiguous_reference');
  });

  it('refuses a superassignment written with backticks', () => {
    expect(verdict('f <- function() { `helper` <<- 1 }')).toBe('ambiguous_reference');
    expect(verdict('f <- function() { helper <<- 1 }', '`helper`')).toBe('ambiguous_reference');
  });

  it('allows local assignments and superassignments to other names', () => {
    expect(verdict('f <- function() { helper <- function(z) z }')).toBe('ok');
    expect(verdict('f <- function() { helper = 1; 2 -> helper }')).toBe('ok');
    expect(verdict('f <- function() { other <<- 1; helperx <<- 2 }')).toBe('ok');
  });

  it('allows a superassignment into an element of the name', () => {
    expect(verdict('f <- function() { helper$field <<- 1 }')).toBe('ok');
  });
});

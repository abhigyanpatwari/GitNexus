/**
 * A body assignment of a function-capable value binds its name locally, so a call of that name may
 * reach the local or the function being renamed, and a rename cannot tell which: any function body
 * that binds the renamed name this way refuses (`ambiguous_reference`), with or without a call.
 * A function literal (a real definition) and a constant (skipped by R at a call) bind nothing the
 * rename must worry about here.
 *
 * The call side (`rFunctionLexicalNames`) and this guard read the same predicate, so they agree
 * on every case of the review repro; the lockstep test runs both over the fixture's callers.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import Parser from 'tree-sitter';
import R from '@eagleoutice/tree-sitter-r';
import { rRenameProvider } from '../../src/core/ingestion/languages/r/rename.js';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { rFunctionLexicalNames } from '../../src/core/ingestion/languages/r/captures.js';
import { rLexicalAssignedNames } from '../../src/core/ingestion/languages/r/assignment.js';

const parser = new Parser();
parser.setLanguage(R as Parameters<Parser['setLanguage']>[0]);

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

describe('R rename: a body assignment that may shadow the renamed function', () => {
  it.each([
    ['an identifier, then a call', 'use <- function(x) { helper <- identity; helper(x) }'],
    ['an identifier, no call', 'use <- function(x) { helper <- identity; x }'],
    [
      'a call before the assignment',
      'use <- function(x) { y <- helper(x); helper <- identity; y }',
    ],
    ['a conditional assignment', 'use <- function(x, c) { if (c) helper <- identity; helper(x) }'],
    ['`=`', 'use <- function(x) { helper = identity; helper(x) }'],
    ['a right assignment', 'use <- function(x) { identity -> helper; helper(x) }'],
    ['a computed value', 'use <- function(x) { helper <- pick(x); x }'],
    ['NULL', 'use <- function(x) { helper <- NULL; x }'],
    ['a complex target', 'use <- function(x) { helper$a <- 1; x }'],
    [
      'a nested function',
      'use <- function(x) { inner <- function(z) { helper <- identity; z }; x }',
    ],
  ])('refuses %s', (_label, source) => {
    expect(verdict(`helper <- function(v) v\n${source}`)).toBe('ambiguous_reference');
  });

  it.each([
    ['a function literal', 'use <- function(x) { helper <- function(y) 1; helper(x) }'],
    ['a function literal, no call', 'use <- function(x) { helper <- function(y) 1; x }'],
    ['a constant', 'use <- function(x) { helper <- 2; helper(x) }'],
    ['no assignment', 'use <- function(x) helper(x)'],
    ['another name', 'use <- function(x) { other <- identity; helper(x) }'],
  ])('does not refuse %s', (_label, source) => {
    expect(verdict(`helper <- function(v) v\n${source}`)).toBe('ok');
  });

  it('refuses the same name whichever way it is spelled', () => {
    expect(verdict('helper <- function(v) v\nuse <- function(x) { `helper` <- identity; x }')).toBe(
      'ambiguous_reference',
    );
  });
});

describe('lockstep: the lexical names and the rename guard read the same assignments', () => {
  const fixture = fileURLToPath(
    new URL('../fixtures/lang-resolution/r-assignment-locals/scripts/d.R', import.meta.url),
  );
  const source = fs.readFileSync(fixture, 'utf8');
  const root = parser.parse(source).rootNode;
  // `dN_f <- function(...)` for every N of the review repro.
  const callers = root.namedChildren.flatMap((node) => {
    const name = node.childForFieldName('lhs')?.text ?? '';
    const fn = node.childForFieldName('rhs');
    return /^d\d+_f$/.test(name) && fn?.type === 'function_definition'
      ? [{ name, fn, text: node.text }]
      : [];
  });
  // Cases the guard refuses for a reason other than an assigned name: d9 has a parameter, d15 a `<<-`.
  const otherRule = new Set(['d9_f', 'd15_f']);

  it('finds every caller of the fixture', () => {
    expect(callers.map((c) => c.name)).toEqual(
      expect.arrayContaining(['d1_f', 'd4_f', 'd5_f', 'd6_f', 'd9_f', 'd13_f', 'd15_f', 'd16_f']),
    );
    expect(callers.length).toBeGreaterThanOrEqual(13);
  });

  it.each([
    ['d1_f', true],
    ['d2_f', true],
    ['d3_f', true],
    ['d4_f', true],
    ['d5_f', true],
    ['d7_f', true],
    ['d11_f', true],
    ['d16_f', true],
    ['d6_f', false],
    ['d13_f', false],
    ['d9_f', false],
    ['d12_f', false],
    ['d15_f', false],
  ])('%s: assigned-lexical is %s', (name, lexical) => {
    const entry = callers.find((c) => c.name === name);
    if (entry === undefined) throw new Error(`no caller ${name}`);
    const assigned = rLexicalAssignedNames(entry.fn as never);
    expect(assigned.has('helper')).toBe(lexical);
    // 5a: the function scope's lexical names are a superset of what the walker reports, and carry
    // helper exactly when the walker (or a parameter) does.
    const lexicalNames = rFunctionLexicalNames(entry.fn as never);
    for (const bound of assigned) expect(lexicalNames).toContain(bound);
    expect(lexicalNames.includes('helper')).toBe(lexical || name === 'd9_f');
    // 5d: the rename guard refuses iff the walker reports helper (other rules aside).
    const refused = verdict(`helper <- function(v) v\n${entry.text}`) === 'ambiguous_reference';
    expect(refused).toBe(otherRule.has(name) ? true : lexical);
  });

  it('agrees for every caller of the fixture, none left out of the table above', () => {
    for (const { name, fn, text } of callers) {
      if (otherRule.has(name)) continue;
      const lexical = rLexicalAssignedNames(fn as never).has('helper');
      expect(rFunctionLexicalNames(fn as never).includes('helper'), name).toBe(lexical);
      expect(verdict(`helper <- function(v) v\n${text}`) === 'ambiguous_reference', name).toBe(
        lexical,
      );
    }
  });
});

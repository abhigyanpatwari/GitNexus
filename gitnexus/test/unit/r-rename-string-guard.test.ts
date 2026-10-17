/**
 * The R rename provider refuses a function whose old or new name is spelled as a string
 * literal (string lookup is not resolved). The guard compares the string's VALUE, not its
 * raw source text: `"worker"`, `'wor\x6ber'`, `"wor\153er"`, `"\u{77}orker"` and raw
 * strings `r"(worker)"` all hold the name `worker` but spell it differently,
 * and tree-sitter-r nests an escape sequence inside `string_content` (raw strings have no
 * `string_content` at all). Each refusal is paired with a string that is only similar.
 */
import { describe, expect, it } from 'vitest';
import Parser from 'tree-sitter';
import R from '@eagleoutice/tree-sitter-r';
import { rRenameProvider } from '../../src/core/ingestion/languages/r/rename.js';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';

const parser = new Parser();
parser.setLanguage(R as Parameters<Parser['setLanguage']>[0]);

/** Run the provider's safety check for renaming `worker` -> `job` over one source text. */
function verdict(source: string, newName = 'job', targetName = 'worker'): string {
  const tree = parser.parse(source);
  const files = new Map([['a.R', { tree, parsed: { localDefs: [] } }]]);
  const issue = rRenameProvider.checkSafety?.({
    target: { type: 'Function', qualifiedName: targetName, filePath: 'a.R' },
    newName,
    files,
    graph: createKnowledgeGraph(),
  } as never);
  return issue ? issue.code : 'ok';
}

describe('R rename: the string-literal guard compares decoded string values', () => {
  it('positive controls: a plain literal refuses, an unrelated or longer one does not', () => {
    expect(verdict('do.call("worker", list())')).toBe('unsupported_occurrence');
    expect(verdict("do.call('worker', list())")).toBe('unsupported_occurrence');
    expect(verdict('do.call("workers", list())')).toBe('ok');
    expect(verdict('do.call("a worker", list())')).toBe('ok');
    expect(verdict('x <- "other"')).toBe('ok');
  });

  it.each([
    ['\\u escape', 'do.call("wor\\u006ber", list())'],
    ['\\u{} escape', 'do.call("\\u{77}orker", list())'],
    ['\\U escape', 'do.call("wor\\U0000006Be\\U00000072", list())'],
    ['\\x escape, single quotes', "do.call('wor\\x6ber', list())"],
    ['octal escape', 'do.call("wor\\153er", list())'],
  ])('refuses %s', (_label, source) => {
    expect(verdict(source)).toBe('unsupported_occurrence');
  });

  it('keeps an invalid escape verbatim: "w\\orker" is not the name', () => {
    expect(verdict('x <- "w\\orker"')).toBe('ok');
  });

  it.each([
    ['r"(worker)"', 'do.call(r"(worker)", list())'],
    ["r'[worker]'", "do.call(r'[worker]', list())"],
    ['R"{worker}"', 'do.call(R"{worker}", list())'],
    ['r"---(worker)---"', 'do.call(r"---(worker)---", list())'],
  ])('refuses the raw string %s', (_label, source) => {
    expect(verdict(source)).toBe('unsupported_occurrence');
  });

  it('does not decode escapes inside a raw string, and ignores a non-matching one', () => {
    expect(verdict('x <- r"(wor\\u006ber)"')).toBe('ok');
    expect(verdict('x <- r"(workers)"')).toBe('ok');
  });

  it('compares the symbol of a function defined in backticks', () => {
    expect(verdict('do.call("worker", list())', 'job', '`worker`')).toBe('unsupported_occurrence');
    expect(verdict('do.call("workers", list())', 'job', '`worker`')).toBe('ok');
  });

  it('applies to the new name as well', () => {
    expect(verdict('x <- "j\\u006fb"')).toBe('unsupported_occurrence');
    expect(verdict('x <- r"(job)"')).toBe('unsupported_occurrence');
    expect(verdict('x <- "jobs"')).toBe('ok');
  });

  it('an escaped backslash before digits is not an octal escape', () => {
    expect(verdict('x <- "\\\\153"')).toBe('ok');
  });
});

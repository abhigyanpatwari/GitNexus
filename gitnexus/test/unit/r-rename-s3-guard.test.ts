/**
 * The R rename provider refuses a new name `generic.class` that would silently register an S3
 * method. Every dot is a possible split, so `to.json.foo` is a method of `to.json`, and a base
 * generic counts although no indexed source defines it (`print.foo`). Each refusal is paired with
 * a name that only looks similar.
 */
import { describe, expect, it } from 'vitest';
import Parser from 'tree-sitter';
import R from '@eagleoutice/tree-sitter-r';
import { registersS3Method, rRenameProvider } from '../../src/core/ingestion/languages/r/rename.js';

const parser = new Parser();
parser.setLanguage(R as Parameters<Parser['setLanguage']>[0]);

/** Run the provider's safety check for renaming `helper` to `newName`, with these functions defined. */
function verdict(newName: string, defined: readonly string[]): string {
  const source = defined.map((name) => `${name} <- function(x) x`).join('\n');
  const files = new Map([
    [
      'a.R',
      {
        tree: parser.parse(source),
        parsed: { localDefs: defined.map((name) => ({ qualifiedName: name })) },
      },
    ],
  ]);
  const issue = rRenameProvider.checkSafety?.({
    target: { type: 'Function', qualifiedName: 'helper', filePath: 'a.R' },
    newName,
    files,
    graph: { forEachNode: () => undefined },
  } as never);
  return issue ? issue.code : 'ok';
}

describe('R rename: the S3 registration guard', () => {
  it('refuses a name whose first dot split is a defined function', () => {
    expect(verdict('area.circle', ['area'])).toBe('unsupported_occurrence');
  });

  it('refuses a name whose later dot split is a defined dotted generic', () => {
    expect(verdict('to.json.foo', ['to.json'])).toBe('unsupported_occurrence');
    expect(verdict('as.data.frame.foo', ['as.data.frame'])).toBe('unsupported_occurrence');
  });

  it('refuses a name with one dot after a defined function of a shorter name', () => {
    expect(verdict('to.json', ['to'])).toBe('unsupported_occurrence');
  });

  it('refuses a method of a base generic that the sources do not define', () => {
    for (const name of ['print.foo', 'format.foo', 'summary.foo', 'plot.foo', 'as.character.foo']) {
      expect(verdict(name, [])).toBe('unsupported_occurrence');
    }
  });

  it('allows a dotted name when no prefix is a function or a base generic', () => {
    expect(verdict('my.helper', [])).toBe('ok');
    expect(verdict('to.json.foo', [])).toBe('ok');
    expect(verdict('toJson.foo', ['to.json'])).toBe('ok');
  });

  it('allows a name with no dot, and a name that merely starts with a dot', () => {
    expect(verdict('print_foo', [])).toBe('ok');
    expect(verdict('.print', [])).toBe('ok');
    expect(verdict('.print.x', [])).toBe('ok');
  });

  it('tests every prefix of the name', () => {
    const defined = new Set(['a.b']);
    expect([
      registersS3Method('a.b.c.d', defined),
      registersS3Method('a.x.b', defined),
      registersS3Method('a.b', defined),
    ]).toEqual([true, false, false]);
  });
});

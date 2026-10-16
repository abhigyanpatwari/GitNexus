/**
 * R dotted (S3) names vs bare names in the shared simple-name indexes:
 * the `isCallableVisibleFromCaller` hook and the
 * `expandRWildcardNames` tail guard. ParsedFiles come from the real R extractor.
 */
import { describe, expect, it } from 'vitest';
import type { ParsedFile, SymbolDefinition } from 'gitnexus-shared';
import { extractParsedFile } from '../../../../src/core/ingestion/scope-extractor-bridge.js';
import { rProvider } from '../../../../src/core/ingestion/languages/r.js';
import { populateClassOwnedMembers } from '../../../../src/core/ingestion/scope-resolution/scope/walkers.js';
import {
  expandRWildcardNames,
  rIsCallableVisibleFromCaller,
  rScopeResolver,
} from '../../../../src/core/ingestion/languages/r/scope-resolver.js';
import { countedParsedFiles } from '../../../helpers/counting-file-set.js';

function parse(src: string, filePath: string): ParsedFile {
  const parsed = extractParsedFile(rProvider, src, filePath);
  if (parsed === undefined) throw new Error(`no ParsedFile for ${filePath}`);
  populateClassOwnedMembers(parsed);
  return parsed;
}

const def = (parsed: ParsedFile, qualifiedName: string): SymbolDefinition => {
  const found = parsed.localDefs.find((d) => d.qualifiedName === qualifiedName);
  if (found === undefined) throw new Error(`no def ${qualifiedName}`);
  return found;
};

const visible = (callerParsed: ParsedFile, candidate: SymbolDefinition): boolean =>
  rIsCallableVisibleFromCaller({ callerParsed, candidate } as never);

describe('rIsCallableVisibleFromCaller', () => {
  const p = parse(
    [
      'print.foo <- function(x, ...) x',
      'foo <- function(v) v',
      '`odd name` <- function(v) v',
      'Scorer <- R6::R6Class("Scorer", public = list(score = function(d) d))',
    ].join('\n'),
    'pkg/R/a.R',
  );

  it('is registered on rScopeResolver', () => {
    expect(rScopeResolver.isCallableVisibleFromCaller).toBe(rIsCallableVisibleFromCaller);
  });

  it('refuses a dotted S3 def for a bare call', () => {
    expect(visible(p, def(p, 'print.foo'))).toBe(false);
  });

  it('allows a bare def and a backticked non-dotted def', () => {
    expect(visible(p, def(p, 'foo'))).toBe(true);
    expect(visible(p, def(p, '`odd name`'))).toBe(true);
  });

  it('refuses a class member whose qualified name is dotted (never callable bare)', () => {
    const member = p.localDefs.find(
      (d) => d.type === 'Method' && d.qualifiedName?.endsWith('score'),
    );
    if (member === undefined) throw new Error('no R6 member def');
    expect(member.qualifiedName).toContain('.');
    expect(visible(p, member)).toBe(false);
  });

  it('allows a def with no qualified name (nothing to prove)', () => {
    expect(visible(p, { ...def(p, 'foo'), qualifiedName: undefined })).toBe(true);
  });
});

describe('expandRWildcardNames', () => {
  const names = (src: string): readonly string[] => {
    const parsed = parse(src, 'pkg/R/a.R');
    return expandRWildcardNames(parsed.moduleScope, [parsed]);
  };

  it('drops a bare name whose file defines a dotted def with that tail (S3 method first)', () => {
    expect(names('print.foo <- function(x) x\nfoo <- function(v) v\nqux <- function(v) v')).toEqual(
      ['qux'],
    );
  });

  it('drops it in the mirror layout too (order-blind)', () => {
    expect(names('bar <- function(v) v\nprint.bar <- function(x) x\nqux <- function(v) v')).toEqual(
      ['qux'],
    );
  });

  it('keeps names that share no tail with a dotted def', () => {
    expect(names('print.foo <- function(x) x\nplain_fn <- function(v) v')).toEqual(['plain_fn']);
  });

  it('keeps a bare name when the dotted def sits in a different file', () => {
    const a = parse('foo <- function(v) v', 'pkg/R/a.R');
    const b = parse('print.foo <- function(x) x', 'pkg/R/b.R');
    expect(expandRWildcardNames(a.moduleScope, [a, b])).toEqual(['foo']);
  });

  it('keeps a bare name that only matches a class member (not a top-level dotted def)', () => {
    expect(
      names(
        'Scorer <- R6::R6Class("Scorer", public = list(tidy = function(d) d))\ntidy <- function(d) d',
      ),
    ).toEqual(['Scorer', 'tidy']);
  });

  it('lists only top-level definitions, not functions nested in another function', () => {
    expect(
      names('outer <- function() {\n  helper <- function() 1\n  helper()\n}\ntop <- function() 2'),
    ).toEqual(['outer', 'top']);
  });

  it('does not list a function nested several levels deep or inside a control block', () => {
    expect(
      names(
        [
          'a <- function() {',
          '  b <- function() {',
          '    c <- function() 1',
          '  }',
          '  if (TRUE) d <- function() 2',
          '}',
        ].join('\n'),
      ),
    ).toEqual(['a']);
  });

  it('still lists top-level classes alongside top-level functions', () => {
    expect(
      names('Scorer <- R6::R6Class("Scorer", public = list(f = function() 1))\nrun = function() 1'),
    ).toEqual(['Scorer', 'run']);
  });

  it('still lists an S4 class defined by a bare setClass() call', () => {
    expect(
      names('setClass("Shape", representation(n = "numeric"))\nplain <- function() 1'),
    ).toEqual(['Shape', 'plain']);
  });

  it('never lists dotted names themselves', () => {
    expect(names('print.foo <- function(x) x')).toEqual([]);
  });

  it('returns nothing for an unknown module scope', () => {
    const a = parse('foo <- function(v) v', 'pkg/R/a.R');
    expect(expandRWildcardNames('scope:missing' as never, [a])).toEqual([]);
  });
});

describe('expandRWildcardNames: the module-scope lookup is built once per pass', () => {
  it('reads each parsed file once however many wildcard edges ask', () => {
    // `parsedFiles.find` per edge read the files up to the match every time. Counted element
    // reads, not wall time: the figure depends on the file count and the number of passes only.
    const paths = Array.from({ length: 200 }, (_, i) => `pkg/R/f${i}.R`);
    const { parsedFiles, reads } = countedParsedFiles(paths);
    for (let edge = 0; edge < 1_000; edge++) {
      expandRWildcardNames(`module:${paths[(edge * 7) % paths.length]}`, parsedFiles);
    }
    expect(reads()).toBe(paths.length);
  });

  it('answers a scope no file owns with nothing', () => {
    const { parsedFiles } = countedParsedFiles(['pkg/R/a.R']);
    expect(expandRWildcardNames('module:absent' as never, parsedFiles)).toEqual([]);
  });
});

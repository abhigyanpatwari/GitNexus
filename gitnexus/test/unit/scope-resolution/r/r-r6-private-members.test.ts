/**
 * `self$m()` reaches only the public members of an R6 class, so the capture pass records where
 * the private members are. The definitions carry no section, so the record is keyed by the
 * position their definition id encodes, and it crosses the worker boundary (and the parse cache)
 * as the file's capture side channel. This pins the keys against the real definition ids and the
 * round trip through `collectCaptureSideChannel` / `applyCaptureSideChannel`.
 */
import { describe, expect, it } from 'vitest';
import type { ParsedFile } from 'gitnexus-shared';
import { extractParsedFile } from '../../../../src/core/ingestion/scope-extractor-bridge.js';
import { rProvider } from '../../../../src/core/ingestion/languages/r.js';
import { rScopeResolver } from '../../../../src/core/ingestion/languages/r/scope-resolver.js';
import { definitionIdPosition } from '../../../../src/core/ingestion/scope-resolution/utils/definition-id.js';

const SOURCE = [
  'Foo <- R6::R6Class("Foo",',
  '  public = list(',
  '    pub = function() 1',
  '  ),',
  '  private = list(',
  '    hidden = function() 2,',
  '    count = 0',
  '  ),',
  '  active = list(',
  '    size = function(value) 3',
  '  )',
  ')',
  'free <- function() 4',
  '',
].join('\n');

const collect = (filePath: string) => rProvider.collectCaptureSideChannel?.(filePath);

function parse(source: string, filePath: string): ParsedFile {
  const file = extractParsedFile(rProvider, source, filePath);
  if (file === undefined) throw new Error('no ParsedFile');
  return file;
}

describe('R6 private members: the capture side channel', () => {
  it('records exactly the private methods, at the position their definition id encodes', () => {
    const file = parse(SOURCE, 'R/privacy.R');
    const channel = collect('R/privacy.R') as { kind: string; r6PrivateMembers: string[] };
    expect(channel.kind).toBe('r');
    const keyOf = (name: string): string => {
      const def = file.localDefs.find((d) => d.nodeId.endsWith(`:Method:${name}`));
      const position = definitionIdPosition(def?.nodeId, 'R/privacy.R');
      if (position === undefined) throw new Error(`no Method ${name}`);
      return `${position.line}:${position.column}`;
    };
    expect(channel.r6PrivateMembers).toEqual([keyOf('hidden')]);
    expect(channel.r6PrivateMembers).not.toContain(keyOf('pub'));
    expect(channel.r6PrivateMembers).not.toContain(keyOf('size'));
  });

  it('is plain data that survives a structured clone', () => {
    parse(SOURCE, 'R/privacy.R');
    const channel = collect('R/privacy.R');
    expect(structuredClone(channel)).toEqual(channel);
  });

  it('records nothing for a file without private members, and a re-parse replaces the record', () => {
    parse(SOURCE, 'R/reparsed.R');
    expect(collect('R/reparsed.R')).toBeDefined();
    parse('free <- function() 4\n', 'R/reparsed.R');
    expect(collect('R/reparsed.R')).toBeUndefined();
  });

  it('a reused ParsedFile restores its record, and one without a channel clears a stale one', () => {
    const file = parse(SOURCE, 'R/reused.R');
    const channel = collect('R/reused.R');
    parse('free <- function() 4\n', 'R/reused.R');
    expect(collect('R/reused.R')).toBeUndefined();

    rScopeResolver.applyCaptureSideChannel?.({ ...file, captureSideChannel: channel });
    expect(collect('R/reused.R')).toEqual(channel);

    rScopeResolver.applyCaptureSideChannel?.({ ...file, captureSideChannel: undefined });
    expect(collect('R/reused.R')).toBeUndefined();
  });
});
